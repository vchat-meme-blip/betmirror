
import { Wallet, Interface, Contract, ethers, JsonRpcProvider } from 'ethers';
import { RelayClient, SafeTransaction, OperationType } from '@polymarket/builder-relayer-client';
import { deriveSafe } from '@polymarket/builder-relayer-client/dist/builder/derive.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { POLYGON_CHAIN_ID, TOKENS } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';
import axios from 'axios';

// --- Constants ---
const RELAYER_URL = "https://relayer-v2.polymarket.com";

// Polymarket Core Contracts
const CTF_CONTRACT_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER_ADDRESS = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

// Gnosis Safe Factories
const POLYMARKET_SAFE_FACTORY = "0xaacfeea03eb1561c4e67d661e40682bd20e3541b"; 
const STANDARD_SAFE_FACTORY = "0xa6b71e26c5e0845f74c812102ca7114b6a896ab2"; // Legacy/Standard Gnosis

// Use Polymarket as default for new deployments, but check both
const SAFE_SINGLETON_ADDRESS = "0x3e5c63644e683549055b9be8653de26e0b4cd36e";
const FALLBACK_HANDLER_ADDRESS = "0xf48f2b2d2a534e40247ecb36350021948091179d";

const SAFE_ABI = [
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
    "function nonce() view returns (uint256)",
    "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
    "function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
    "function isOwner(address owner) view returns (bool)",
    "function addOwnerWithThreshold(address owner, uint256 _threshold)",
    "function getOwners() view returns (address[])"
];

const PROXY_FACTORY_ABI = [
    "function createProxyWithNonce(address _singleton, bytes memory initializer, uint256 saltNonce) returns (address proxy)"
];

const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

// ABIs
const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];
const ERC1155_ABI = [
    "function setApprovalForAll(address operator, bool approved)",
    "function isApprovedForAll(address account, address operator) view returns (bool)"
];

export class SafeManagerService {
    private relayClient: RelayClient;
    private safeAddress: string; // Source of Truth
    private viemPublicClient: any;

    constructor(
        private signer: Wallet, // Ethers V6 Wallet
        private builderApiKey: string | undefined,
        private builderApiSecret: string | undefined,
        private builderApiPassphrase: string | undefined,
        private logger: Logger,
        knownSafeAddress: string 
    ) {
        if (!knownSafeAddress || !knownSafeAddress.startsWith('0x')) {
            throw new Error("SafeManagerService initialized without a valid Safe Address.");
        }
        this.safeAddress = knownSafeAddress;
        
        // Log Factory for verification
        this.logger.info(`ℹ️ Active Safe: ${knownSafeAddress}`);

        let builderConfig: BuilderConfig | undefined = undefined;

        if (!builderApiKey || !builderApiSecret || !builderApiPassphrase) {
            this.logger.warn(`⚠️ Builder Creds Missing. Safe Relayer functionality limited.`);
        } else {
            try {
                builderConfig = new BuilderConfig({
                    localBuilderCreds: {
                        key: builderApiKey,
                        secret: builderApiSecret,
                        passphrase: builderApiPassphrase
                    }
                });
            } catch (e) {
                this.logger.warn("⚠️ Failed to initialize BuilderConfig.");
            }
        }

        const account = privateKeyToAccount(signer.privateKey as `0x${string}`);
        // FIX: Use explicit high-reliability RPC. Default http() uses public nodes which flake often.
        const viemClient = createWalletClient({
            account,
            chain: polygon,
            transport: http('https://polygon-rpc.com')
        });
        
        this.viemPublicClient = createPublicClient({
            chain: polygon,
            transport: http('https://polygon-rpc.com')
        });

        this.relayClient = new RelayClient(
            RELAYER_URL,
            POLYGON_CHAIN_ID,
            viemClient, 
            builderConfig
        );
    }

    public getSafeAddress(): string {
        return this.safeAddress;
    }

    /**
     * SMART ADDRESS DERIVATION
     * Checks both Polymarket and Standard Gnosis factories.
     * Returns the one that exists on-chain, or defaults to Polymarket factory for new users.
     */
    public static async computeAddress(ownerAddress: string): Promise<string> {
        // 1. Derive both possibilities
        const polySafe = await deriveSafe(ownerAddress, POLYMARKET_SAFE_FACTORY);
        const stdSafe = await deriveSafe(ownerAddress, STANDARD_SAFE_FACTORY);

        // 2. Check Chain for existence (Provider needed)
        try {
            const provider = new JsonRpcProvider('https://polygon-rpc.com');
            
            // Check Standard (Legacy) First - Many users have this
            const stdCode = await provider.getCode(stdSafe);
            if (stdCode && stdCode !== '0x') {
                console.log(`[SafeManager] Found existing Legacy Safe at ${stdSafe}`);
                return stdSafe;
            }

            // Check Polymarket
            const polyCode = await provider.getCode(polySafe);
            if (polyCode && polyCode !== '0x') {
                console.log(`[SafeManager] Found existing Polymarket Safe at ${polySafe}`);
                return polySafe;
            }
        } catch (e) {
            console.warn("[SafeManager] Failed to check code on-chain, defaulting to Polymarket factory derivation.");
        }

        // Default to Polymarket for new users
        return polySafe;
    }

    public async isDeployed(): Promise<boolean> {
        try {
            const code = await this.signer.provider?.getCode(this.safeAddress);
            return code !== undefined && code !== '0x';
        } catch(rpcErr) { 
             try {
                const code = await this.viemPublicClient.getBytecode({ address: this.safeAddress });
                return (code && code !== '0x');
             } catch(e) { return false; }
        }
    }

    public async deploySafe(): Promise<string> {
        // 1. Check if already deployed
        if (await this.isDeployed()) {
            this.logger.info(`   Safe ${this.safeAddress.slice(0,8)}... is active.`);
            return this.safeAddress;
        }

        this.logger.info(`🚀 Deploying Gnosis Safe ${this.safeAddress.slice(0,8)}...`);

        try {
            // NOTE: We try to use the SDK first. If it derives the same address, great.
            // If not, we might need a manual deploy, but deployment is complex to manualize with Relayer
            // without a dedicated endpoint. 
            // For now, we trust the SDK defaults for *NEW* deployments, and handle *EXISTING* mismatch in withdrawals.
            const task = await this.relayClient.deploy();
            await task.wait(); 
            const realAddress = (task as any).proxyAddress;
            
            if (realAddress && realAddress.toLowerCase() !== this.safeAddress.toLowerCase()) {
                this.logger.warn(`⚠️ Relayer deployed to ${realAddress}, but DB expected ${this.safeAddress}. Updating DB...`);
                // This is a critical recovery. If Relayer creates a different address, we must adopt it for this session.
                return realAddress;
            }
            this.logger.success(`✅ Safe Deployed via Relayer`);
            return realAddress || this.safeAddress;
        } catch (e: any) {
            const msg = (e.message || "").toLowerCase();
            if (msg.includes("already deployed")) {
                this.logger.success(`   Safe active (confirmed by Relayer).`);
                return this.safeAddress;
            }
            this.logger.warn(`   Relayer deploy failed (${msg}). Switching to Rescue Deploy...`);
            return await this.deploySafeOnChain();
        }
    }

    public async enableApprovals(): Promise<void> {
        // Approvals need to be executed sequentially to avoid Nonce issues if we don't implement MultiSend manually.
        // We will check and execute one by one.
        
        const usdcInterface = new Interface(ERC20_ABI);
        const ctfInterface = new Interface(ERC1155_ABI);

        this.logger.info(`   Checking permissions for ${this.safeAddress.slice(0,8)}...`);

        const usdcSpenders = [
            { addr: CTF_CONTRACT_ADDRESS, name: "CTF" },
            { addr: NEG_RISK_ADAPTER_ADDRESS, name: "NegRiskAdapter" },
            { addr: CTF_EXCHANGE_ADDRESS, name: "CTFExchange" },
            { addr: NEG_RISK_CTF_EXCHANGE_ADDRESS, name: "NegRiskExchange" }
        ];

        for (const spender of usdcSpenders) {
            try {
                const allowance = await this.viemPublicClient.readContract({
                    address: TOKENS.USDC_BRIDGED,
                    abi: parseAbi(ERC20_ABI),
                    functionName: 'allowance',
                    args: [this.safeAddress, spender.addr]
                }) as bigint;

                if (allowance < 1000000000n) {
                    this.logger.info(`     + Granting USDC to ${spender.name}`);
                    const data = usdcInterface.encodeFunctionData("approve", [spender.addr, MAX_UINT256]);
                    
                    // Execute via API (Manual) to ensure correct Safe is targeted
                    await this.executeTransactionViaApi({ 
                        to: TOKENS.USDC_BRIDGED, 
                        value: "0", 
                        data: data, 
                        operation: OperationType.Call 
                    });
                }
            } catch (e: any) {
                this.logger.error(`Failed to approve ${spender.name}: ${e.message}`);
            }
        }

        const ctfOperators = [
            { addr: CTF_EXCHANGE_ADDRESS, name: "CTFExchange" },
            { addr: NEG_RISK_CTF_EXCHANGE_ADDRESS, name: "NegRiskExchange" },
            { addr: NEG_RISK_ADAPTER_ADDRESS, name: "NegRiskAdapter" }
        ];

        for (const operator of ctfOperators) {
             try {
                const isApproved = await this.viemPublicClient.readContract({
                    address: CTF_CONTRACT_ADDRESS,
                    abi: parseAbi(ERC1155_ABI),
                    functionName: 'isApprovedForAll',
                    args: [this.safeAddress, operator.addr]
                }) as boolean;

                if (!isApproved) {
                    this.logger.info(`     + Granting Operator to ${operator.name}`);
                    const data = ctfInterface.encodeFunctionData("setApprovalForAll", [operator.addr, true]);
                    
                    // Execute via API
                    await this.executeTransactionViaApi({ 
                        to: CTF_CONTRACT_ADDRESS, 
                        value: "0", 
                        data: data, 
                        operation: OperationType.Call 
                    });
                }
            } catch (e: any) {
                this.logger.error(`Failed to set operator ${operator.name}: ${e.message}`);
            }
        }
    }

    public async withdrawUSDC(to: string, amount: string): Promise<string> {
        const usdcInterface = new Interface(ERC20_ABI);
        const data = usdcInterface.encodeFunctionData("transfer", [to, amount]);
        const tx: SafeTransaction = { to: TOKENS.USDC_BRIDGED, value: "0", data, operation: OperationType.Call };
        
        try {
            const task = await this.relayClient.execute([tx]);
            const result = await task.wait();
            return (result as any).transactionHash || "0x...";
        } catch (e: any) {
            throw e;
        }
    }

    public async withdrawNative(to: string, amount: string): Promise<string> {
        const tx: SafeTransaction = { to, value: amount, data: "0x", operation: OperationType.Call };
        try {
            const task = await this.relayClient.execute([tx]);
            const result = await task.wait();
            return (result as any).transactionHash || "0x...";
        } catch (e: any) {
            throw e;
        }
    }

    // --- MANUAL RELAYER INTERACTION ---
    // Forces the SDK/API to use our specific Safe Address, bypassing auto-derivation
    private async executeTransactionViaApi(safeTx: SafeTransaction): Promise<string> {
        // 1. Get Nonce from Contract
        const safeContract = new Contract(this.safeAddress, SAFE_ABI, this.signer);
        const nonce = await safeContract.nonce();

        // 2. Build Transaction Hash
        const safeTxGas = 0;
        const baseGas = 0;
        const gasPrice = 0;
        const gasToken = "0x0000000000000000000000000000000000000000";
        const refundReceiver = "0x0000000000000000000000000000000000000000";
        
        const txHashBytes = await safeContract.getTransactionHash(
            safeTx.to,
            safeTx.value,
            safeTx.data,
            safeTx.operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            nonce
        );

        // 3. Sign
        const signature = await this.signer.signMessage(Buffer.from(txHashBytes.slice(2), 'hex'));

        // 4. Construct Payload for Relayer
        const payload = {
            safeTxHash: txHashBytes,
            signature: signature,
            safeTx: {
                to: safeTx.to,
                value: safeTx.value,
                data: safeTx.data,
                operation: safeTx.operation,
                safeTxGas,
                baseGas,
                gasPrice,
                gasToken,
                refundReceiver,
                nonce: Number(nonce)
            },
            // CRITICAL: Explicitly tell Relayer which Safe to use
            proxyWallet: this.safeAddress 
        };

        // 5. Send to Relayer API
        try {
            const response = await axios.post(`${RELAYER_URL}/transactions`, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    // Include Builder Headers if available
                    ...(this.builderApiKey ? {
                        'BZ-API-KEY': this.builderApiKey,
                        'BZ-API-SECRET': this.builderApiSecret, // Note: Headers might differ for Relayer vs Data API. 
                        // Usually Relayer authentication is via signature, but we add what we have.
                    } : {})
                }
            });
            
            return response.data.transactionHash;
        } catch (error: any) {
            this.logger.error(`Relayer API Error: ${error.response?.data?.message || error.message}`);
            throw new Error(error.response?.data?.message || "Relayer API Failed");
        }
    }

    // --- ON-CHAIN RECOVERY & ADMIN METHODS ---
    
    public async addOwner(newOwnerAddress: string): Promise<string> {
        this.logger.info(`🛡️ Adding Recovery Owner: ${newOwnerAddress} to Safe ${this.safeAddress}`);

        if (!this.signer.provider) throw new Error("No provider available");

        // 1. Verify not already owner
        const safeContract = new Contract(this.safeAddress, SAFE_ABI, this.signer);
        const isOwner = await safeContract.isOwner(newOwnerAddress);
        
        if (isOwner) {
            this.logger.info("   Address is already an owner.");
            return "ALREADY_OWNER";
        }

        // 2. Check Gas on Signer (Relayer usually doesn't pay for Safe Admin tasks)
        const gasBal = await this.signer.provider.getBalance(this.signer.address);
        if (gasBal < 20000000000000000n) { // 0.02 POL
             throw new Error("Bot Signer Wallet needs ~0.05 POL (Matic) to execute this admin transaction.");
        }

        // 3. Prepare Add Owner Tx
        const safeInterface = new Interface(SAFE_ABI);
        // addOwnerWithThreshold(address owner, uint256 _threshold)
        // We keep threshold at 1 so EITHER the bot OR the user can sign independently.
        const innerData = safeInterface.encodeFunctionData("addOwnerWithThreshold", [newOwnerAddress, 1]);
        
        const safeTxGas = 0;
        const baseGas = 0;
        const gasPrice = 0;
        const gasToken = "0x0000000000000000000000000000000000000000";
        const refundReceiver = "0x0000000000000000000000000000000000000000";
        const operation = 0; // Call
        
        let nonce = 0;
        try { nonce = await safeContract.nonce(); } catch(e) {}

        const txHashBytes = await safeContract.getTransactionHash(
            this.safeAddress, // To Self
            0, // Value
            innerData,
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            nonce
        );

        const signature = await this.signer.signMessage(Buffer.from(txHashBytes.slice(2), 'hex'));
        
        this.logger.info(`   Broadcasting Admin Tx...`);

        const tx = await safeContract.execTransaction(
            this.safeAddress, // Safe calls itself to add owner
            0,
            innerData,
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            signature
        );

        await tx.wait();
        this.logger.success(`   ✅ Owner Added! Tx: ${tx.hash}`);
        return tx.hash;
    }

    public async deploySafeOnChain(): Promise<string> {
        this.logger.warn(`🏗️ STARTING ON-CHAIN RESCUE DEPLOYMENT...`);
        
        if (!this.signer.provider) throw new Error("No provider for deployment");

        const gasBal = await this.signer.provider.getBalance(this.signer.address);
        if (gasBal < 100000000000000000n) { // 0.1 POL
            throw new Error("Insufficient POL (Matic) in Signer wallet to deploy Safe. Please send ~0.2 POL to " + this.signer.address);
        }

        const safeInterface = new Interface(SAFE_ABI);
        const owners = [this.signer.address];
        const threshold = 1;
        const to = "0x0000000000000000000000000000000000000000";
        const data = "0x";
        const fallbackHandler = FALLBACK_HANDLER_ADDRESS;
        const paymentToken = "0x0000000000000000000000000000000000000000";
        const payment = 0;
        const paymentReceiver = "0x0000000000000000000000000000000000000000";

        const initializer = safeInterface.encodeFunctionData("setup", [
            owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver
        ]);

        const factory = new Contract(POLYMARKET_SAFE_FACTORY, PROXY_FACTORY_ABI, this.signer);
        const saltNonce = 0; 

        this.logger.info(`   🚀 Sending Deployment Transaction...`);
        const tx = await factory.createProxyWithNonce(SAFE_SINGLETON_ADDRESS, initializer, saltNonce);
        await tx.wait();
        this.logger.success(`   ✅ Safe Deployed Successfully!`);
        
        return this.safeAddress;
    }

    public async withdrawUSDCOnChain(to: string, amount: string): Promise<string> {
        const safeAddr = this.safeAddress;
        this.logger.warn(`🚨 RESCUE MODE: Executing direct on-chain withdrawal from ${safeAddr}...`);
        
        if (!this.signer.provider) {
             throw new Error("Signer has no provider. Cannot execute on-chain.");
        }

        // 1. Ensure Deployed (Check Code)
        const code = await this.signer.provider.getCode(safeAddr);
        if (code === '0x') {
             this.logger.warn(`   Safe not deployed on-chain. Deploying now...`);
             await this.deploySafeOnChain();
        }

        // 2. Prepare Transaction
        const usdcInterface = new Interface(ERC20_ABI);
        const innerData = usdcInterface.encodeFunctionData("transfer", [to, amount]);

        const safeContract = new Contract(safeAddr, SAFE_ABI, this.signer);
        
        let nonce = 0;
        try {
             nonce = await safeContract.nonce();
        } catch (e: any) {
             throw new Error("Failed to get Safe nonce: " + e.message);
        }
        
        const safeTxGas = 0;
        const baseGas = 0;
        const gasPrice = 0;
        const gasToken = "0x0000000000000000000000000000000000000000";
        const refundReceiver = "0x0000000000000000000000000000000000000000";
        const operation = 0; // Call

        const txHashBytes = await safeContract.getTransactionHash(
            TOKENS.USDC_BRIDGED,
            0,
            innerData,
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            nonce
        );

        const signature = await this.signer.signMessage(Buffer.from(txHashBytes.slice(2), 'hex'));
        
        this.logger.info(`   Broacasting Rescue Tx...`);
        
        // Gas check for Signer
        const gasBal = await this.signer.provider.getBalance(this.signer.address);
        if (gasBal < 10000000000000000n) { // 0.01 POL
             throw new Error("Signer needs POL (Matic) to execute rescue transaction.");
        }

        const tx = await safeContract.execTransaction(
            TOKENS.USDC_BRIDGED,
            0,
            innerData,
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            signature
        );

        this.logger.success(`   ✅ Rescue Tx Sent: ${tx.hash}`);
        await tx.wait();
        return tx.hash;
    }

    public async withdrawNativeOnChain(to: string, amount: string): Promise<string> {
        const safeAddr = this.safeAddress;
        this.logger.warn(`🚨 RESCUE MODE: Executing direct on-chain POL withdrawal from ${safeAddr}...`);
        
        if (!this.signer.provider) {
             throw new Error("Signer has no provider. Cannot execute on-chain.");
        }

        // 1. Ensure Deployed
        const code = await this.signer.provider.getCode(safeAddr);
        if (code === '0x') {
             this.logger.warn(`   Safe not deployed on-chain. Deploying now...`);
             await this.deploySafeOnChain();
        }

        // 2. Prepare Transaction
        const safeContract = new Contract(safeAddr, SAFE_ABI, this.signer);
        
        let nonce = 0;
        try {
             nonce = await safeContract.nonce();
        } catch (e: any) {
             throw new Error("Failed to get Safe nonce: " + e.message);
        }
        
        const safeTxGas = 0;
        const baseGas = 0;
        const gasPrice = 0;
        const gasToken = "0x0000000000000000000000000000000000000000";
        const refundReceiver = "0x0000000000000000000000000000000000000000";
        const operation = 0; // Call

        const txHashBytes = await safeContract.getTransactionHash(
            to,
            amount,
            "0x", // data
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            nonce
        );

        const signature = await this.signer.signMessage(Buffer.from(txHashBytes.slice(2), 'hex'));
        
        this.logger.info(`   Broacasting Rescue POL Tx...`);
        
        // Gas check for Signer
        const gasBal = await this.signer.provider.getBalance(this.signer.address);
        if (gasBal < 10000000000000000n) { // 0.01 POL
             throw new Error("Signer needs POL (Matic) to execute rescue transaction.");
        }

        const tx = await safeContract.execTransaction(
            to,
            amount,
            "0x",
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            signature
        );

        this.logger.success(`   ✅ Rescue Tx Sent: ${tx.hash}`);
        await tx.wait();
        return tx.hash;
    }
}
