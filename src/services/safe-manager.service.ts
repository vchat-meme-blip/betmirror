
import { Wallet, Interface } from 'ethers';
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

// Polymarket Core Contracts (Spenders/Operators)
const CTF_CONTRACT_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER_ADDRESS = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

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

// Fallback Factory (Gnosis Safe Proxy Factory 1.3.0 L2)
const SAFE_PROXY_FACTORY_ADDRESS = "0x3e5c63644E683549055b9Be8653de26E0B4CD36E";

export class SafeManagerService {
    private relayClient: RelayClient;
    private safeAddress: string | null = null;
    private viemPublicClient: any;

    constructor(
        private signer: Wallet,
        private builderApiKey: string | undefined,
        private builderApiSecret: string | undefined,
        private builderApiPassphrase: string | undefined,
        private logger: Logger,
        knownSafeAddress?: string 
    ) {
        if (knownSafeAddress) {
            this.safeAddress = knownSafeAddress;
        }

        let builderConfig: BuilderConfig | undefined = undefined;

        if (!builderApiKey || !builderApiSecret || !builderApiPassphrase) {
            this.logger.warn(`⚠️ Builder Creds Missing. Safe Relayer functionality disabled.`);
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
        const viemClient = createWalletClient({
            account,
            chain: polygon,
            transport: http()
        });
        
        // Use a reliable public RPC for reads to avoid rate limits
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

        if (this.safeAddress) {
            this.forceSafeAddress(this.safeAddress);
        }
    }

    /**
     * Patch the RelayClient to strictly use our calculated Safe address.
     * This overrides internal logic that might try to re-derive it incorrectly.
     */
    private forceSafeAddress(address: string) {
        const client = this.relayClient as any;
        
        // 1. Internal Property Override (Common in SDKs)
        try { client._safeAddress = address; } catch(e) {}
        try { client.safeAddress = address; } catch(e) {}

        // 2. Getter Override (Ruthless: Use defineProperty to ensure read-only getters are mocked)
        try {
            Object.defineProperty(this.relayClient, 'safeAddress', {
                get: () => address,
                configurable: true
            });
        } catch(e) {
            // this.logger.warn(`[SafeManager] Could not patch safeAddress prop: ${e}`);
        }

        // 3. Method Override (If the SDK uses a method to fetch it)
        if (typeof client.getSafeAddress === 'function') {
            client.getSafeAddress = async () => address;
        }
        
        // this.logger.debug(`[SafeManager] Patched RelayClient -> ${address.slice(0,8)}...`);
    }

    public static async computeAddress(ownerAddress: string): Promise<string> {
        try {
            return await deriveSafe(ownerAddress, undefined as any);
        } catch (e) {
            return await deriveSafe(ownerAddress, SAFE_PROXY_FACTORY_ADDRESS);
        }
    }

    public async getSafeAddress(): Promise<string> {
        if (this.safeAddress) return this.safeAddress;

        try {
            this.safeAddress = await SafeManagerService.computeAddress(this.signer.address);
            this.forceSafeAddress(this.safeAddress);
            return this.safeAddress;
        } catch (e: any) {
            this.logger.error("Failed to derive Safe address", e);
            throw e;
        }
    }

    public async isDeployed(): Promise<boolean> {
        const safe = await this.getSafeAddress();
        try {
            // 1. Check via Relayer API (Fastest)
            const status = await (this.relayClient as any).getDeployed(safe);
            if (status) return true;
        } catch (e) {}

        // 2. Fallback: Check if code exists on-chain
        try {
            const code = await this.viemPublicClient.getBytecode({ address: safe });
            return code && code !== '0x';
        } catch(rpcErr) {
            return false;
        }
    }

    public async deploySafe(): Promise<string> {
        const safe = await this.getSafeAddress();
        this.forceSafeAddress(safe);
        
        // Optimistic check to avoid error 400s
        const alreadyDeployed = await this.isDeployed();
        if (alreadyDeployed) {
            this.logger.info(`   Safe ${safe.slice(0,8)}... is active.`);
            return safe;
        }

        this.logger.info(`🚀 Deploying Gnosis Safe ${safe.slice(0,8)}...`);
        
        try {
            const task = await this.relayClient.deploy();
            await task.wait(); 
            this.logger.success(`✅ Safe Deployed.`);
            return safe;
        } catch (e: any) {
            if (await this.isDeployed()) return safe; // Double check if race condition
            
            if (e.message?.includes("already deployed")) {
                return safe;
            }
            this.logger.error("Safe deployment failed", e);
            throw e;
        }
    }

    /**
     * INTELLIGENT APPROVALS:
     * Only submits transactions if allowances are missing on-chain.
     */
    public async enableApprovals(): Promise<void> {
        const safeAddr = await this.getSafeAddress();
        this.forceSafeAddress(safeAddr);

        const txs: SafeTransaction[] = [];
        const usdcInterface = new Interface(ERC20_ABI);
        const ctfInterface = new Interface(ERC1155_ABI);

        this.logger.info(`   Checking permissions for ${safeAddr.slice(0,8)}...`);

        // 1. Check USDC.e Approvals (ERC20)
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
                    args: [safeAddr, spender.addr]
                }) as bigint;

                // 1000 USDC threshold (arbitrary safety check)
                if (allowance < 1000000000n) {
                    this.logger.info(`     + Granting USDC to ${spender.name}`);
                    const data = usdcInterface.encodeFunctionData("approve", [spender.addr, MAX_UINT256]);
                    txs.push({ to: TOKENS.USDC_BRIDGED, value: "0", data: data, operation: OperationType.Call });
                }
            } catch (e) {
                 // If read fails, assume we need approval to be safe
                 const data = usdcInterface.encodeFunctionData("approve", [spender.addr, MAX_UINT256]);
                 txs.push({ to: TOKENS.USDC_BRIDGED, value: "0", data: data, operation: OperationType.Call });
            }
        }

        // 2. Check Outcome Token Approvals (ERC1155)
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
                    args: [safeAddr, operator.addr]
                }) as boolean;

                if (!isApproved) {
                    this.logger.info(`     + Granting Operator to ${operator.name}`);
                    const data = ctfInterface.encodeFunctionData("setApprovalForAll", [operator.addr, true]);
                    txs.push({ to: CTF_CONTRACT_ADDRESS, value: "0", data: data, operation: OperationType.Call });
                }
            } catch (e) {
                const data = ctfInterface.encodeFunctionData("setApprovalForAll", [operator.addr, true]);
                txs.push({ to: CTF_CONTRACT_ADDRESS, value: "0", data: data, operation: OperationType.Call });
            }
        }

        if (txs.length === 0) {
            this.logger.info("   ✅ Permissions healthy. No transactions needed.");
            return;
        }

        try {
            this.logger.info(`🔐 Broadcasting ${txs.length} setup transactions...`);
            const task = await this.relayClient.execute(txs);
            // We wait, but catch timeout errors to avoid crashing boot
            await task.wait().catch(e => this.logger.warn(`   (Relay response slow, proceeding anyway)`));
            this.logger.success("   Permissions updated.");
        } catch (e: any) {
             this.logger.warn(`   Setup note: ${e.message}`);
        }
    }

    public async withdrawUSDC(to: string, amount: string): Promise<string> {
        const safe = await this.getSafeAddress();
        this.forceSafeAddress(safe); // ENSURE RELAYER TARGETS CORRECT SAFE

        const usdcInterface = new Interface(ERC20_ABI);
        const data = usdcInterface.encodeFunctionData("transfer", [to, amount]);
        
        // This transaction tells the SAFE (from) to send money TO the USDC contract
        // The USDC contract then reads the 'data' (transfer to Recipient) and moves the money.
        const tx: SafeTransaction = {
            to: TOKENS.USDC_BRIDGED, // Interaction target: USDC Contract
            value: "0",
            data: data, // Instruction: transfer(to_address, amount)
            operation: OperationType.Call
        };
        
        this.logger.info(`💸 Withdrawing ${Number(amount) / 1000000} USDC from Vault ${safe.slice(0,6)}...`);
        this.logger.info(`   -> Recipient: ${to.slice(0,6)}...`);
        
        try {
            const task = await this.relayClient.execute([tx]);
            
            // IMMEDIATE CAPTURE: Even if wait() fails, we have the hash.
            const txHash = task.transactionHash;
            this.logger.info(`   Tx Submitted: ${txHash}`);

            try {
                await task.wait();
            } catch (waitError: any) {
                 this.logger.warn(`   ⚠️ Withdrawal timed out waiting for conf, but was sent: ${txHash}`);
            }
            
            return txHash;
        } catch (e: any) {
            this.logger.error("Safe withdrawal failed", e);
            throw e;
        }
    }
}
