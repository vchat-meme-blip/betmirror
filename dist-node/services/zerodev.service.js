import { createKernelAccount, createZeroDevPaymasterClient, createKernelAccountClient, } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { http, createPublicClient, encodeFunctionData, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { deserializePermissionAccount, serializePermissionAccount, toPermissionValidator, } from "@zerodev/permissions";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
// Constants
const ENTRY_POINT = getEntryPoint("0.7");
const KERNEL_VERSION = KERNEL_V3_1;
const CHAIN = polygon;
// Default Public RPC (Polygon) - In prod use a paid RPC
const PUBLIC_RPC = "https://little-thrilling-layer.matic.quiknode.pro/378fe82ae3cb5d38e4ac79c202990ad508e1c4c6";
const USDC_ABI = parseAbi([
    "function transfer(address to, uint256 amount) returns (bool)"
]);
export class ZeroDevService {
    constructor(zeroDevRpcUrlOrId) {
        // --- AUTO-CORRECT RPC URL ---
        // SDK v5 requires v3 endpoints: https://rpc.zerodev.app/api/v3/<PROJECT_ID>/chain/<CHAIN_ID>
        // We detect if the user passed a v2 URL or just an ID, and upgrade it to v3 for Polygon (137).
        this.rpcUrl = this.normalizeRpcUrl(zeroDevRpcUrlOrId);
        console.log(`[ZeroDev] Using RPC: ${this.rpcUrl}`);
        this.publicClient = createPublicClient({
            chain: CHAIN,
            transport: http(PUBLIC_RPC),
        });
    }
    normalizeRpcUrl(input) {
        // 1. Extract UUID (Project ID)
        const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        const match = input.match(uuidRegex);
        if (!match) {
            console.error("[ZeroDev] Invalid Project ID or URL format provided.");
            return input; // Fallback to whatever was passed
        }
        const projectId = match[0];
        // 2. Check if it's already a v3 URL for Polygon
        if (input.includes("/api/v3") && input.includes("/chain/137")) {
            return input;
        }
        // 3. Construct v3 URL
        return `https://rpc.zerodev.app/api/v3/${projectId}/chain/137`;
    }
    /**
     * Predicts the deterministic address of the Smart Account for this user.
     * Used to check if they already have an account before deploying.
     */
    async computeMasterAccountAddress(ownerWalletClient) {
        try {
            if (!ownerWalletClient)
                throw new Error("Missing owner wallet client");
            const ecdsaValidator = await signerToEcdsaValidator(this.publicClient, {
                entryPoint: ENTRY_POINT,
                signer: ownerWalletClient,
                kernelVersion: KERNEL_VERSION,
            });
            const account = await createKernelAccount(this.publicClient, {
                entryPoint: ENTRY_POINT,
                plugins: { sudo: ecdsaValidator },
                kernelVersion: KERNEL_VERSION,
            });
            return account.address;
        }
        catch (e) {
            console.error("Failed to compute deterministic address (ZeroDev):", e.message);
            // Don't swallow error completely, return null but log detailed error
            return null;
        }
    }
    /**
     * CLIENT SIDE: User calls this to authorize the bot.
     * Creates a Smart Account (if needed) and generates a Session Key for the server.
     */
    async createSessionKeyForServer(ownerWalletClient, ownerAddress) {
        console.log("🔐 Generating Session Key...");
        // 1. Generate a temporary private key for the session (The "Server Key")
        const sessionPrivateKey = generatePrivateKey();
        const sessionKeyAccount = privateKeyToAccount(sessionPrivateKey);
        // 2. Prepare the Session Signer
        const sessionKeySigner = await toECDSASigner({
            signer: sessionKeyAccount,
        });
        // 3. Create/Resolve the Master Smart Account (Kernel)
        const ecdsaValidator = await signerToEcdsaValidator(this.publicClient, {
            entryPoint: ENTRY_POINT,
            signer: ownerWalletClient, // Viem wallet client
            kernelVersion: KERNEL_VERSION,
        });
        // 4. Create the Permission Plugin (The "Session Slip")
        const permissionPlugin = await toPermissionValidator(this.publicClient, {
            entryPoint: ENTRY_POINT,
            signer: sessionKeySigner,
            policies: [
                toSudoPolicy({}), // Allow everything for this session key
            ],
            kernelVersion: KERNEL_VERSION,
        });
        // 5. Create the Session Key Account Object
        const sessionKeyAccountObj = await createKernelAccount(this.publicClient, {
            entryPoint: ENTRY_POINT,
            plugins: {
                sudo: ecdsaValidator,
                regular: permissionPlugin,
            },
            kernelVersion: KERNEL_VERSION,
        });
        const accountAddress = sessionKeyAccountObj.address;
        console.log("   Account Address:", accountAddress);
        // 6. Serialize it to send to the server
        const serializedSessionKey = await serializePermissionAccount(sessionKeyAccountObj, sessionPrivateKey);
        // NOTE: We intentionally DO NOT send a transaction here. 
        // The Account and Session Key validator will be lazy-initialized on the server side 
        // once the user deposits funds and the bot sends its first "Wake Up" transaction.
        return {
            smartAccountAddress: accountAddress,
            serializedSessionKey: serializedSessionKey,
            sessionPrivateKey: sessionPrivateKey
        };
    }
    /**
     * SERVER SIDE: The Bot uses this to execute trades.
     * Reconstructs the account from the string provided by the user.
     */
    async createBotClient(serializedSessionKey) {
        // 1. Deserialize the account
        const sessionKeyAccount = await deserializePermissionAccount(this.publicClient, ENTRY_POINT, KERNEL_VERSION, serializedSessionKey);
        // 2. Create Paymaster (Optional - for gas sponsorship)
        const paymasterClient = createZeroDevPaymasterClient({
            chain: CHAIN,
            transport: http(this.rpcUrl),
        });
        // 3. Create the Kernel Client (The "Bot Wallet")
        const kernelClient = createKernelAccountClient({
            account: sessionKeyAccount,
            chain: CHAIN,
            bundlerTransport: http(this.rpcUrl),
            client: this.publicClient,
            paymaster: {
                getPaymasterData(userOperation) {
                    return paymasterClient.sponsorUserOperation({ userOperation });
                },
            },
        });
        return {
            address: sessionKeyAccount.address,
            client: kernelClient
        };
    }
    /**
     * CLIENT SIDE: Trustless Withdrawal.
     * The Owner (User) signs a UserOp to drain funds. The server cannot stop this.
     */
    async withdrawFunds(ownerWalletClient, smartAccountAddress, toAddress, amount, usdcAddress) {
        console.log("Initiating Trustless Withdrawal...");
        // 1. Create the Validator using the Owner's Wallet
        const ecdsaValidator = await signerToEcdsaValidator(this.publicClient, {
            entryPoint: ENTRY_POINT,
            signer: ownerWalletClient,
            kernelVersion: KERNEL_VERSION,
        });
        // 2. Reconstruct the Account (we know the address and the validator)
        const account = await createKernelAccount(this.publicClient, {
            entryPoint: ENTRY_POINT,
            plugins: {
                sudo: ecdsaValidator,
            },
            kernelVersion: KERNEL_VERSION,
            address: smartAccountAddress,
        });
        // 3. Create Client
        const kernelClient = createKernelAccountClient({
            account,
            chain: CHAIN,
            bundlerTransport: http(this.rpcUrl),
            client: this.publicClient,
            // Optional: User pays gas in MATIC or we sponsor it
        });
        // 4. Encode the USDC transfer call
        const callData = encodeFunctionData({
            abi: USDC_ABI,
            functionName: "transfer",
            args: [toAddress, amount]
        });
        // 5. Send UserOp
        const userOpHash = await kernelClient.sendUserOperation({
            callData: await account.encodeCalls([
                {
                    to: usdcAddress,
                    value: BigInt(0),
                    data: callData,
                },
            ]),
        });
        console.log("UserOp Hash:", userOpHash);
        // Safe wait for receipt
        const receipt = await this.publicClient.waitForTransactionReceipt({
            hash: userOpHash,
        });
        return receipt.transactionHash;
    }
}
