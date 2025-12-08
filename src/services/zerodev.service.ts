import {
  createKernelAccount,
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
const ENTRY_POINT = getEntryPoint("0.7");
const KERNEL_VERSION = KERNEL_V3_1;
const CHAIN = polygon;
const PUBLIC_RPC = "https://polygon-rpc.com";

const USDC_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)"
]);

const ENTRY_POINT_ABI = parseAbi([
    "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"
]);

export class ZeroDevService {
  private publicClient: PublicClient;
  private bundlerRpc: string;

  constructor(zeroDevRpcUrlOrId: string, paymasterRpcUrl?: string) {
    this.bundlerRpc = this.normalizeRpcUrl(zeroDevRpcUrlOrId);
    console.log(`[ZeroDev] Bundler: ${this.bundlerRpc}`);
    console.log(`[ZeroDev] Mode: NATIVE GAS ONLY (Paymaster Disabled for Stability)`);

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

  private async checkUserOpReceipt(receipt: any) {
      if (!receipt) throw new Error("No receipt returned");
      
      if (typeof receipt.success === 'boolean' && !receipt.success) {
           throw new Error(`UserOp failed (success=false). Gas Used: ${receipt.actualGasUsed}`);
      }
      
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
                           if (!decoded.args.success) {
                               throw new Error(`UserOp REVERTED on-chain. Nonce: ${decoded.args.nonce}`);
                           }
                           return true; 
                       }
                  }
              } catch (e) { continue; }
          }
      }
      return true;
  }

  // --- BOT TRANSACTION (Session Key) ---
  async sendTransaction(serializedSessionKey: string, to: string, abi: any[], functionName: string, args: any[]) {
       // 1. Restore Account
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

       // 2. Encode Call
       const userOpCallData = await sessionKeyAccount.encodeCalls([{
           to: to as Hex,
           value: BigInt(0),
           data: callData
       }]);

       // 3. Create Client (Native Gas - No Paymaster)
       const kernelClient = createKernelAccountClient({
           account: sessionKeyAccount,
           chain: CHAIN,
           bundlerTransport: http(this.bundlerRpc),
           client: this.publicClient as any,
       });

       try {
           console.log(`🚀 Sending Native Gas UserOp (Bot Trade)...`);
           const userOpHash = await kernelClient.sendUserOperation({ 
               callData: userOpCallData
           } as any);
           
           console.log(`UserOp Submitted: ${userOpHash}`);
           const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
           await this.checkUserOpReceipt(receipt);

           console.log("✅ Success. Tx:", receipt.receipt.transactionHash);
           return receipt.receipt.transactionHash;
       } catch (error: any) {
           console.error("❌ Transaction Failed:", error.message);
           throw error;
       }
  }
  
  // --- USER ONBOARDING (Owner Key) ---
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
    
    // Create Validator with Owner Signer (Metamask)
    const ecdsaValidator = await signerToEcdsaValidator(this.publicClient as any, {
      entryPoint: ENTRY_POINT,
      signer: ownerWalletClient as any, 
      kernelVersion: KERNEL_VERSION,
    });

    const permissionPlugin = await toPermissionValidator(this.publicClient as any, {
      entryPoint: ENTRY_POINT,
      signer: sessionKeySigner,
      policies: [ toSudoPolicy({}) ], // Full permission for now (simpler for trading)
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

  // --- MANUAL WITHDRAWAL (Owner Key) ---
  // Updated to use Native Gas to avoid Paymaster failures
  async withdrawFunds(ownerWalletClient: WalletClient, smartAccountAddress: string, toAddress: string, amount: bigint, tokenAddress: string) {
      console.log("Initiating Trustless Withdrawal (Native Gas)...");
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

      const encodedCallData = await account.encodeCalls(calls);
      
      // Use Client WITHOUT Paymaster
      const kernelClient = createKernelAccountClient({
        account,
        chain: CHAIN,
        bundlerTransport: http(this.bundlerRpc),
        client: this.publicClient as any,
      });

      try {
           const userOpHash = await kernelClient.sendUserOperation({ callData: encodedCallData } as any);
           console.log(`Withdrawal UserOp: ${userOpHash}`);
           const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
           await this.checkUserOpReceipt(receipt);
           return receipt.receipt.transactionHash;
      } catch (e: any) {
           console.error(`Withdrawal Failed: ${e.message}`);
           throw e;
      }
  }
}