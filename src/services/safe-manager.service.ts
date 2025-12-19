
import { Wallet, Interface, Contract, ethers, JsonRpcProvider } from 'ethers';
import { RelayClient, SafeTransaction, OperationType } from '@polymarket/builder-relayer-client';
import { deriveSafe } from '@polymarket/builder-relayer-client/dist/builder/derive.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { POLYGON_CHAIN_ID, TOKENS } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';

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
    private safeAddress: string;
    private viemPublicClient: any;

    constructor(
        private signer: Wallet,
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
        
        let builderConfig: BuilderConfig | undefined = undefined;
        if (builderApiKey && builderApiSecret && builderApiPassphrase) {
            builderConfig = new BuilderConfig({
                localBuilderCreds: {
                    key: builderApiKey,
                    secret: builderApiSecret,
                    passphrase: builderApiPassphrase
                }
            });
        }

        const account = privateKeyToAccount(signer.privateKey as `0x${string}`);
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

    public static async computeAddress(ownerAddress: string): Promise<string> {
        const polySafe = await deriveSafe(ownerAddress, POLYMARKET_SAFE_FACTORY);
        const stdSafe = await deriveSafe(ownerAddress, STANDARD_SAFE_FACTORY);

        try {
            const provider = new JsonRpcProvider('https://polygon-rpc.com');
            const stdCode = await provider.getCode(stdSafe);
            if (stdCode && stdCode !== '0x') return stdSafe;

            const polyCode = await provider.getCode(polySafe);
            if (polyCode && polyCode !== '0x') return polySafe;
        } catch (e) {
            console.warn("[SafeManager] Code check failed.");
        }
        return polySafe;
    }

    public async isDeployed(): Promise<boolean> {
        try {
            const code = await this.viemPublicClient.getBytecode({ address: this.safeAddress });
            return (code && code !== '0x');
        } catch(e) { return false; }
    }

    public async deploySafe(): Promise<string> {
        if (await this.isDeployed()) {
            return this.safeAddress;
        }

        this.logger.info(`🚀 Deploying Gnosis Safe ${this.safeAddress.slice(0,8)}...`);

        try {
            const task = await this.relayClient.deploy();
            await task.wait(); 
            const realAddress = (task as any).proxyAddress;
            this.logger.success(`✅ Safe Deployed via Relayer`);
            return realAddress || this.safeAddress;
        } catch (e: any) {
            if (e.message?.toLowerCase().includes("already deployed")) return this.safeAddress;
            return await this.deploySafeOnChain();
        }
    }

    public async enableApprovals(): Promise<void> {
        const usdcInterface = new Interface(ERC20_ABI);
        const ctfInterface = new Interface(ERC1155_ABI);

        this.logger.info(`   Checking permissions for ${this.safeAddress.slice(0,8)}...`);

        // FIX: Wait for Safe deployment confirmation indexing to prevent BAD_DATA nonce errors
        let retries = 10;
        while (retries > 0 && !(await this.isDeployed())) {
            this.logger.info(`   Waiting for Safe deployment indexing...`);
            await new Promise(r => setTimeout(r, 3000));
            retries--;
        }

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
                    
                    const tx: SafeTransaction = { 
                        to: TOKENS.USDC_BRIDGED as `0x${string}`, 
                        value: "0", 
                        data: data as `0x${string}`, 
                        operation: OperationType.Call 
                    };
                    // FIX: Use RelayClient.execute instead of manual axios POST
                    const task = await this.relayClient.execute([tx]);
                    await task.wait();
                    this.logger.success(`     ✅ Approved ${spender.name}`);
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
                    
                    const tx: SafeTransaction = { 
                        to: CTF_CONTRACT_ADDRESS as `0x${string}`, 
                        value: "0", 
                        data: data as `0x${string}`, 
                        operation: OperationType.Call 
                    };
                    const task = await this.relayClient.execute([tx]);
                    await task.wait();
                    this.logger.success(`     ✅ Operator Set: ${operator.name}`);
                }
            } catch (e: any) {
                this.logger.error(`Failed to set operator ${operator.name}: ${e.message}`);
            }
        }
    }

    public async withdrawUSDC(to: string, amount: string): Promise<string> {
        const usdcInterface = new Interface(ERC20_ABI);
        const data = usdcInterface.encodeFunctionData("transfer", [to, amount]);
        const tx: SafeTransaction = { 
            to: TOKENS.USDC_BRIDGED as `0x${string}`, 
            value: "0", 
            data: data as `0x${string}`, 
            operation: OperationType.Call 
        };
        const task = await this.relayClient.execute([tx]);
        const result = await task.wait();
        return (result as any).transactionHash || "0x...";
    }

    public async withdrawNative(to: string, amount: string): Promise<string> {
        const tx: SafeTransaction = { 
            to: to as `0x${string}`, 
            value: amount, 
            data: "0x", 
            operation: OperationType.Call 
        };
        const task = await this.relayClient.execute([tx]);
        const result = await task.wait();
        return (result as any).transactionHash || "0x...";
    }

    public async addOwner(newOwnerAddress: string): Promise<string> {
        this.logger.info(`🛡️ Adding Recovery Owner: ${newOwnerAddress}`);
        
        // Check if already owner
        const isOwner = await this.viemPublicClient.readContract({
            address: this.safeAddress as `0x${string}`,
            abi: parseAbi(SAFE_ABI),
            functionName: 'isOwner',
            args: [newOwnerAddress]
        }) as boolean;
        
        if (isOwner) {
            this.logger.info(`   Address is already an owner.`);
            return "ALREADY_OWNER";
        }
        
        // Build the addOwner transaction
        const safeInterface = new Interface(SAFE_ABI);
        const data = safeInterface.encodeFunctionData("addOwnerWithThreshold", [newOwnerAddress, 1]);
        
        // Execute via Relayer (GASLESS!)
        const tx: SafeTransaction = { 
            to: this.safeAddress as `0x${string}`, 
            value: "0", 
            data: data as `0x${string}`, 
            operation: OperationType.Call 
        };
        
        const task = await this.relayClient.execute([tx]);
        const result = await task.wait();
        
        this.logger.success(`✅ Owner Added! Tx: ${(result as any).transactionHash}`);
        return (result as any).transactionHash;
    }

    public async deploySafeOnChain(): Promise<string> {
        this.logger.warn(`🏗️ ON-CHAIN DEPLOYMENT...`);

        // Provider check
        if (!this.signer.provider) {
            throw new Error("Signer has no provider. Cannot deploy on-chain.");
        }

        // Gas balance check
        const gasBal = await this.signer.provider.getBalance(this.signer.address);
        if (gasBal < 100000000000000000n) { // 0.1 POL
            throw new Error(`Insufficient POL in signer wallet. Need ~0.2 POL. Address: ${this.signer.address}`);
        }
        const safeInterface = new Interface(SAFE_ABI);
        const owners = [this.signer.address];
        const initializer = safeInterface.encodeFunctionData("setup", [
            owners, 1, "0x0000000000000000000000000000000000000000", "0x", FALLBACK_HANDLER_ADDRESS, "0x0000000000000000000000000000000000000000", 0, "0x0000000000000000000000000000000000000000"
        ]);
        const factory = new Contract(POLYMARKET_SAFE_FACTORY, PROXY_FACTORY_ABI, this.signer);
        const tx = await factory.createProxyWithNonce(SAFE_SINGLETON_ADDRESS, initializer, 0);
        await tx.wait();
        return this.safeAddress;
    }

    public async withdrawUSDCOnChain(to: string, amount: string): Promise<string> {
         // Provider check
        if (!this.signer.provider) {
            throw new Error("Signer has no provider. Cannot execute on-chain.");
        }
        
        // Deployment check
        if (!(await this.isDeployed())) {
            this.logger.warn(`   Safe not deployed. Deploying now...`);
            await this.deploySafeOnChain();
        }
        
        // Gas check
        const gasBal = await this.signer.provider.getBalance(this.signer.address);
        if (gasBal < 10000000000000000n) { // 0.01 POL
            throw new Error("Signer needs POL to execute rescue transaction.");
        }
        const usdcInterface = new Interface(ERC20_ABI);
        const innerData = usdcInterface.encodeFunctionData("transfer", [to, amount]);
        const safeContract = new Contract(this.safeAddress, SAFE_ABI, this.signer);
        const nonce = await safeContract.nonce();
        const txHashBytes = await safeContract.getTransactionHash(TOKENS.USDC_BRIDGED, 0, innerData, 0, 0, 0, 0, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", nonce);
        const signature = await this.signer.signMessage(Buffer.from(txHashBytes.slice(2), 'hex'));
        const tx = await safeContract.execTransaction(TOKENS.USDC_BRIDGED, 0, innerData, 0, 0, 0, 0, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", signature);
        await tx.wait();
        return tx.hash;
    }

    public async withdrawNativeOnChain(to: string, amount: string): Promise<string> {
        this.logger.warn(`🚨 RESCUE: On-chain POL withdrawal...`);
    
        if (!this.signer.provider) {
            throw new Error("Signer has no provider.");
        }
        
        if (!(await this.isDeployed())) {
            this.logger.warn(`   Safe not deployed. Deploying...`);
            await this.deploySafeOnChain();
        }
        
        const gasBal = await this.signer.provider.getBalance(this.signer.address);
        if (gasBal < 10000000000000000n) {
            throw new Error("Signer needs POL for rescue tx.");
        }
        
        const safeContract = new Contract(this.safeAddress, SAFE_ABI, this.signer);
        const nonce = await safeContract.nonce();
        const txHashBytes = await safeContract.getTransactionHash(
            to, amount, "0x", 0, 0, 0, 0,
            "0x0000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000", nonce
        );
        
        const signature = await this.signer.signMessage(Buffer.from(txHashBytes.slice(2), 'hex'));
        
        const tx = await safeContract.execTransaction(
            to, amount, "0x", 0, 0, 0, 0,
            "0x0000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000", signature
        );
        
        await tx.wait();
        this.logger.success(`✅ Rescue POL Tx: ${tx.hash}`);
        return tx.hash;
    }
}
