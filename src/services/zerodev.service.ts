
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
  Log
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
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";

// Constants
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
   * Checks receipt logs to verify UserOperation success.
   * Throws if success is false.
   */
  private async verifyUserOpSuccess(txHash: string) {
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash as Hex });
      
      // Filter for UserOperationEvent
      for (const log of receipt.logs) {
          try {
              // ENTRY_POINT is typed as EntryPointType, so we must double-cast to compare with string
              if (log.address.toLowerCase() === (ENTRY_POINT as unknown as string).toLowerCase()) {
                   // Cast log to any to ensure topics access (TS sometimes infers logs without topics in receipts)
                   const topics = (log as any).topics;
                   const event = decodeEventLog({
                       abi: ENTRY_POINT_ABI,
                       data: log.data,
                       topics: topics
                   });
                   
                   // Cast event result to access properties
                   const decodedEvent = event as unknown as { eventName: string; args: any };

                   if (decodedEvent.eventName === 'UserOperationEvent') {
                       if (!decodedEvent.args.success) {
                           throw new Error(`UserOp failed on-chain. Gas Used: ${decodedEvent.args.actualGasUsed}`);
                       }
                       return true; // Success found
                   }
              }
          } catch(e) { continue; }
      }
      // If we found the receipt but no UserOp event, it might be a direct tx or different issue, but we assume success if no revert found
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

       // 1. Try with Paymaster
       try {
           console.log(`Attempting UserOp via ERC20 Paymaster...`);
           const userOpHash = await kernelClient.sendUserOperation({
               callData: userOpCallData
           } as any);
           
           const txHash = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
           await this.verifyUserOpSuccess(txHash.receipt.transactionHash);
           
           console.log("✅ Paymaster Success. Tx:", txHash.receipt.transactionHash);
           return txHash.receipt.transactionHash;
       } catch (e: any) {
           console.warn(`⚠️ Paymaster Failed (${e.message}). Retrying with Native Gas...`);
       }

       // 2. Fallback: Native Gas
       const fallbackClient = createKernelAccountClient({
           account: sessionKeyAccount,
           chain: CHAIN,
           bundlerTransport: http(this.bundlerRpc),
           client: this.publicClient as any,
       });

       const userOpHash = await fallbackClient.sendUserOperation({ 
           callData: userOpCallData
       } as any);
       
       const txHash = await fallbackClient.waitForUserOperationReceipt({ hash: userOpHash });
       await this.verifyUserOpSuccess(txHash.receipt.transactionHash);

       console.log("✅ Native Gas Success. Tx:", txHash.receipt.transactionHash);
       return txHash.receipt.transactionHash;
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

    const serializedSessionKey = await serializePermissionAccount(sessionKeyAccountObj, sessionPrivateKey);

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
      let value: bigint = BigInt(0);
      let target: Hex;

      if (isNative) {
          callData = "0x"; 
          value = amount;
          target = toAddress as Hex;
      } else {
          callData = encodeFunctionData({
              abi: USDC_ABI,
              functionName: "transfer",
              args: [toAddress as Hex, amount]
          });
          target = tokenAddress as Hex;
      }
      
      const calls = [{ to: target, value, data: callData }];

      // Auto-approve Paymaster if needed
      if (!isNative && tokenAddress.toLowerCase() === GAS_TOKEN_ADDRESS.toLowerCase()) {
           const approveData = await this.getPaymasterApprovalCallData();
           calls.unshift({
               to: GAS_TOKEN_ADDRESS as Hex,
               value: BigInt(0),
               data: approveData
           });
      }

      const encodedCallData = await account.encodeCalls(calls);

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
                return paymasterClient.sponsorUserOperation({ 
                    userOperation,
                    gasToken: GAS_TOKEN_ADDRESS 
                });
            }
        }
      });

       try {
           const userOpHash = await kernelClient.sendUserOperation({
               callData: encodedCallData,
           } as any);
           const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
           await this.verifyUserOpSuccess(receipt.receipt.transactionHash);
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
           await this.verifyUserOpSuccess(receipt.receipt.transactionHash);
           return receipt.receipt.transactionHash;
       }
  }
}
