import {
  createKernelAccount,
  createZeroDevPaymasterClient,
  createKernelAccountClient,
} from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
  http,
  Hex,
  createPublicClient,
  PublicClient,
  WalletClient,
  encodeFunctionData,
  parseAbi,
  decodeEventLog,
  Log,
  Address
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  deserializePermissionAccount,
  serializePermissionAccount,
  toPermissionValidator,
} from "@zerodev/permissions";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { KERNEL_V3_1, getEntryPoint } from "@zerodev/sdk/constants";

// Constants
// Canonical EntryPoint 0.7.0 Address
// Use SDK helper to ensure correct type for deserialization
const ENTRY_POINT = getEntryPoint("0.7");
const KERNEL_VERSION = KERNEL_V3_1;
const CHAIN = polygon;

// Default Public RPC (Polygon)
const PUBLIC_RPC = "https://polygon-rpc.com";

// --- GAS TOKEN CONFIGURATION ---
const GAS_TOKEN_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; 

// ERC20 Paymaster Address (Pimlico/ZeroDev Standard for Polygon)
const ERC20_PAYMASTER_ADDRESS = '0x0000000000325602a77414A841499c5613416D2d';

const USDC_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)"
]);

// EntryPoint 0.7 Event ABI
const ENTRY_POINT_ABI = parseAbi([
    "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"
]);

export class ZeroDevService {
  private publicClient: PublicClient;
  private bundlerRpc: string;
  private paymasterRpc: string;

  constructor(zeroDevRpcUrlOrId: string, paymasterRpcUrl?: string) {
    this.bundlerRpc = this.normalizeRpcUrl(zeroDevRpcUrlOrId);
    
    if (paymasterRpcUrl) {
        this.paymasterRpc = paymasterRpcUrl;
    } else {
        this.paymasterRpc = this.bundlerRpc;
    }
    
    console.log(`[ZeroDev] Bundler: ${this.bundlerRpc}`);
    console.log(`[ZeroDev] Paymaster: ${this.paymasterRpc}`);

    this.publicClient = createPublicClient({
      chain: CHAIN,
      transport: http(PUBLIC_RPC),
    }) as unknown as PublicClient;
  }

  private normalizeRpcUrl(input: string): string {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const match = input.match(uuidRegex);
      if (input.includes("http")) return input;
      if (match) {
          return `https://rpc.zerodev.app/api/v3/${match[0]}/chain/137`;
      }
      return input;
  }

  /**
   * Strictly verifies if a UserOp succeeded on-chain.
   * If the UserOp reverted (success=false), this throws an error.
   */
  private async checkUserOpReceipt(receipt: any) {
      if (!receipt) throw new Error("No receipt returned");
      
      // console.log("Checking Receipt Logs:", receipt.logs.length);

      // 1. Check direct success flag if available (Viem/ZeroDev standard)
      if (typeof receipt.success === 'boolean' && !receipt.success) {
           throw new Error(`UserOp failed (success=false). Gas Used: ${receipt.actualGasUsed}`);
      }
      
      // 2. Fallback: Parse logs to find UserOperationEvent
      let foundUserOpEvent = false;
      const entryPointAddr = ENTRY_POINT as unknown as string;

      if (receipt.logs) {
          for (const log of receipt.logs) {
              try {
                  if (log.address.toLowerCase() === entryPointAddr.toLowerCase()) {
                       const decoded: any = decodeEventLog({
                           abi: ENTRY_POINT_ABI,
                           data: log.data,
                           topics: log.topics as any
                       });

                       if (decoded.eventName === 'UserOperationEvent') {
                           foundUserOpEvent = true;
                           // console.log(`UserOp Event Found. Success: ${decoded.args.success}`);
                           if (!decoded.args.success) {
                               throw new Error(`UserOp REVERTED on-chain. Nonce: ${decoded.args.nonce}`);
                           }
                           return true; 
                       }
                  }
              } catch (e) { continue; }
          }
      }
      
      // If we processed logs but didn't find the event, something is weird, but we assume success if no revert found
      // unless strict mode is needed.
      return true;
  }

  async sendTransaction(serializedSessionKey: string, to: string, abi: any[], functionName: string, args: any[]) {
       const sessionKeyAccount = await deserializePermissionAccount(
          this.publicClient as any,
          ENTRY_POINT,
          KERNEL_VERSION,
          serializedSessionKey
       );

       const parsedAbi = (abi.length > 0 && typeof abi[0] === 'string') 
            ? parseAbi(abi as string[]) 
            : abi;

       const callData = encodeFunctionData({
           abi: parsedAbi,
           functionName,
           args
       });

       const userOpCallData = await sessionKeyAccount.encodeCalls([{
           to: to as Hex,
           value: BigInt(0),
           data: callData
       }]);

       // --- 1. ATTEMPT WITH PAYMASTER (Sponsored) ---
       try {
           const paymasterClient = createZeroDevPaymasterClient({
              chain: CHAIN,
              transport: http(this.paymasterRpc),
           });

           const kernelClient = createKernelAccountClient({
               account: sessionKeyAccount,
               chain: CHAIN,
               bundlerTransport: http(this.bundlerRpc),
               client: this.publicClient as any,
               paymaster: {
                   getPaymasterData(userOperation: any) {
                       return paymasterClient.sponsorUserOperation({ 
                           userOperation,
                           gasToken: GAS_TOKEN_ADDRESS 
                       });
                   }
               }
           });

           console.log(`Attempting UserOp via ERC20 Paymaster...`);
           const userOpHash = await kernelClient.sendUserOperation({
               callData: userOpCallData
           } as any);
           
           console.log(`UserOp Submitted: ${userOpHash}. Waiting for receipt...`);
           const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
           
           // STRICT CHECK: Will throw if success is false, triggering fallback
           await this.checkUserOpReceipt(receipt);
           
           console.log("✅ Paymaster Success. Tx:", receipt.receipt.transactionHash);
           return receipt.receipt.transactionHash;

       } catch (e: any) {
           console.warn(`⚠️ Paymaster Failed/Reverted (${e.message}). Switching to Fallback (Native Gas)...`);
       }

       // --- 2. FALLBACK: NATIVE GAS (Smart Account POL) ---
       // This matches the "working" state from before refactor
       try {
           const fallbackClient = createKernelAccountClient({
               account: sessionKeyAccount,
               chain: CHAIN,
               bundlerTransport: http(this.bundlerRpc),
               client: this.publicClient as any,
               // No Paymaster middleware -> Uses Native POL
           });

           console.log(`Attempting Fallback via Native Gas...`);
           const userOpHash = await fallbackClient.sendUserOperation({ 
               callData: userOpCallData
           } as any);
           
           console.log(`Fallback UserOp: ${userOpHash}`);
           const receipt = await fallbackClient.waitForUserOperationReceipt({ hash: userOpHash });
           await this.checkUserOpReceipt(receipt);

           console.log("✅ Native Gas Success. Tx:", receipt.receipt.transactionHash);
           return receipt.receipt.transactionHash;
       } catch (fallbackError: any) {
           console.error("❌ Critical: Both Paymaster and Native Gas failed.");
           throw fallbackError;
       }
  }
  
  async getPaymasterApprovalCallData() {
       return encodeFunctionData({
          abi: USDC_ABI,
          functionName: "approve",
          args: [ERC20_PAYMASTER_ADDRESS as Hex, BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935")]
       });
  }

  async computeMasterAccountAddress(ownerWalletClient: WalletClient) {
      try {
          if (!ownerWalletClient) throw new Error("Missing owner wallet client");
          const ecdsaValidator = await signerToEcdsaValidator(this.publicClient as any, {
              entryPoint: ENTRY_POINT,
              signer: ownerWalletClient as any,
              kernelVersion: KERNEL_VERSION,
          });
          const account = await createKernelAccount(this.publicClient as any, {
              entryPoint: ENTRY_POINT,
              plugins: { sudo: ecdsaValidator },
              kernelVersion: KERNEL_VERSION,
          });
          return account.address;
      } catch (e: any) {
          console.error("Failed to compute deterministic address:", e.message);
          return null;
      }
  }

  async createSessionKeyForServer(ownerWalletClient: WalletClient, ownerAddress: string) {
    console.log("🔐 Generating Session Key...");
    const sessionPrivateKey = generatePrivateKey();
    const sessionKeyAccount = privateKeyToAccount(sessionPrivateKey);
    const sessionKeySigner = await toECDSASigner({ signer: sessionKeyAccount });
    const ecdsaValidator = await signerToEcdsaValidator(this.publicClient as any, {
      entryPoint: ENTRY_POINT,
      signer: ownerWalletClient as any, 
      kernelVersion: KERNEL_VERSION,
    });
    const permissionPlugin = await toPermissionValidator(this.publicClient as any, {
      entryPoint: ENTRY_POINT,
      signer: sessionKeySigner,
      policies: [ toSudoPolicy({}) ],
      kernelVersion: KERNEL_VERSION,
    });
    const sessionKeyAccountObj = await createKernelAccount(this.publicClient as any, {
      entryPoint: ENTRY_POINT,
      plugins: {
        sudo: ecdsaValidator,
        regular: permissionPlugin,
      },
      kernelVersion: KERNEL_VERSION,
    });
    const serializedSessionKey = await serializePermissionAccount(sessionKeyAccountObj as any, sessionPrivateKey);
    return {
      smartAccountAddress: sessionKeyAccountObj.address,
      serializedSessionKey: serializedSessionKey,
      sessionPrivateKey: sessionPrivateKey 
    };
  }

  async withdrawFunds(ownerWalletClient: WalletClient, smartAccountAddress: string, toAddress: string, amount: bigint, tokenAddress: string) {
      console.log("Initiating Trustless Withdrawal...");
      const ecdsaValidator = await signerToEcdsaValidator(this.publicClient as any, {
        entryPoint: ENTRY_POINT,
        signer: ownerWalletClient as any,
        kernelVersion: KERNEL_VERSION,
      });
      const account = await createKernelAccount(this.publicClient as any, {
        entryPoint: ENTRY_POINT,
        plugins: { sudo: ecdsaValidator },
        kernelVersion: KERNEL_VERSION,
        address: smartAccountAddress as Hex,
      });

      const isNative = tokenAddress === '0x0000000000000000000000000000000000000000';
      let callData: Hex;
      if (isNative) {
          callData = "0x"; 
      } else {
          callData = encodeFunctionData({
              abi: USDC_ABI,
              functionName: "transfer",
              args: [toAddress as Hex, amount]
          });
      }
      
      const calls = [{ 
          to: (isNative ? toAddress : tokenAddress) as Hex, 
          value: isNative ? amount : BigInt(0), 
          data: callData 
      }];

      if (!isNative && tokenAddress.toLowerCase() === GAS_TOKEN_ADDRESS.toLowerCase()) {
           const approveData = await this.getPaymasterApprovalCallData();
           calls.unshift({
               to: GAS_TOKEN_ADDRESS as Hex,
               value: BigInt(0),
               data: approveData
           });
      }

      const encodedCallData = await account.encodeCalls(calls);
      
      // Fallback-enabled withdrawal logic
      const paymasterClient = createZeroDevPaymasterClient({
          chain: CHAIN,
          transport: http(this.paymasterRpc),
      });

      const kernelClient = createKernelAccountClient({
        account,
        chain: CHAIN,
        bundlerTransport: http(this.bundlerRpc),
        client: this.publicClient as any,
        paymaster: {
            getPaymasterData(userOperation: any) {
                return paymasterClient.sponsorUserOperation({ userOperation, gasToken: GAS_TOKEN_ADDRESS });
            }
        }
      });

      try {
           const userOpHash = await kernelClient.sendUserOperation({ callData: encodedCallData } as any);
           const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
           await this.checkUserOpReceipt(receipt);
           return receipt.receipt.transactionHash;
      } catch (e: any) {
           console.warn(`Withdraw Paymaster Failed, trying native gas: ${e.message}`);
           const fallbackClient = createKernelAccountClient({
               account,
               chain: CHAIN,
               bundlerTransport: http(this.bundlerRpc),
               client: this.publicClient as any,
           });
           const userOpHash = await fallbackClient.sendUserOperation({ callData: encodedCallData } as any);
           const receipt = await fallbackClient.waitForUserOperationReceipt({ hash: userOpHash });
           await this.checkUserOpReceipt(receipt);
           return receipt.receipt.transactionHash;
      }
  }
}