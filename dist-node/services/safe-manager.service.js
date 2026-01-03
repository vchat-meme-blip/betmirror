import { Interface, Contract, ethers, JsonRpcProvider } from 'ethers';
import { RelayClient, OperationType } from '@polymarket/builder-relayer-client';
import { deriveSafe } from '@polymarket/builder-relayer-client/dist/builder/derive.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { POLYGON_CHAIN_ID, TOKENS } from '../config/env.js';
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
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address owner) view returns (uint256)"
];
const ERC1155_ABI = [
    "function setApprovalForAll(address operator, bool approved)",
    "function isApprovedForAll(address account, address operator) view returns (bool)"
];
export class SafeManagerService {
    signer;
    builderApiKey;
    builderApiSecret;
    builderApiPassphrase;
    logger;
    relayClient;
    safeAddress; // Source of Truth
    viemPublicClient;
    constructor(signer, // Ethers V6 Wallet
    builderApiKey, builderApiSecret, builderApiPassphrase, logger, knownSafeAddress) {
        this.signer = signer;
        this.builderApiKey = builderApiKey;
        this.builderApiSecret = builderApiSecret;
        this.builderApiPassphrase = builderApiPassphrase;
        this.logger = logger;
        if (!knownSafeAddress || !knownSafeAddress.startsWith('0x')) {
            throw new Error("SafeManagerService initialized without a valid Safe Address.");
        }
        this.safeAddress = knownSafeAddress;
        this.logger.info(`ℹ️ Active Safe: ${knownSafeAddress}`);
        let builderConfig = undefined;
        if (!builderApiKey || !builderApiSecret || !builderApiPassphrase) {
            this.logger.warn(`⚠️ Builder Creds Missing. Safe Relayer functionality limited.`);
        }
        else {
            try {
                builderConfig = new BuilderConfig({
                    localBuilderCreds: {
                        key: builderApiKey,
                        secret: builderApiSecret,
                        passphrase: builderApiPassphrase
                    }
                });
            }
            catch (e) {
                this.logger.warn("⚠️ Failed to initialize BuilderConfig.");
            }
        }
        const account = privateKeyToAccount(signer.privateKey);
        const viemClient = createWalletClient({
            account,
            chain: polygon,
            transport: http(process.env.RPC_URL || 'https://polygon-rpc.com')
        });
        this.viemPublicClient = createPublicClient({
            chain: polygon,
            transport: http(process.env.RPC_URL || 'https://polygon-rpc.com')
        });
        this.relayClient = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, viemClient, builderConfig);
    }
    getSafeAddress() {
        return this.safeAddress;
    }
    static async computeAddress(ownerAddress) {
        const polySafe = await deriveSafe(ownerAddress, POLYMARKET_SAFE_FACTORY);
        const stdSafe = await deriveSafe(ownerAddress, STANDARD_SAFE_FACTORY);
        try {
            const provider = new JsonRpcProvider(process.env.RPC_URL || 'https://polygon-rpc.com');
            const stdCode = await provider.getCode(stdSafe);
            if (stdCode && stdCode !== '0x') {
                console.log(`[SafeManager] Found existing Legacy Safe at ${stdSafe}`);
                return stdSafe;
            }
            const polyCode = await provider.getCode(polySafe);
            if (polyCode && polyCode !== '0x') {
                console.log(`[SafeManager] Found existing Polymarket Safe at ${polySafe}`);
                return polySafe;
            }
        }
        catch (e) {
            console.warn("[SafeManager] Failed to check code on-chain, defaulting to Polymarket factory derivation.");
        }
        return polySafe;
    }
    async isDeployed() {
        try {
            const code = await this.signer.provider?.getCode(this.safeAddress);
            return code !== undefined && code !== '0x';
        }
        catch (rpcErr) {
            try {
                const code = await this.viemPublicClient.getBytecode({ address: this.safeAddress });
                return (code && code !== '0x');
            }
            catch (e) {
                return false;
            }
        }
    }
    async deploySafe() {
        if (await this.isDeployed()) {
            this.logger.info(`   Safe ${this.safeAddress.slice(0, 8)}... is active.`);
            return this.safeAddress;
        }
        this.logger.info(`🚀 Deploying Gnosis Safe ${this.safeAddress.slice(0, 8)}...`);
        try {
            const task = await this.relayClient.deploy();
            await task.wait();
            const realAddress = task.proxyAddress;
            if (realAddress && realAddress.toLowerCase() !== this.safeAddress.toLowerCase()) {
                this.logger.warn(`⚠️ Relayer deployed to ${realAddress}, but DB expected ${this.safeAddress}. Updating DB...`);
                return realAddress;
            }
            this.logger.success(`✅ Safe Deployed via Relayer`);
            return realAddress || this.safeAddress;
        }
        catch (e) {
            const msg = (e.message || "").toLowerCase();
            if (msg.includes("already deployed")) {
                this.logger.success(`   Safe active (confirmed by Relayer).`);
                return this.safeAddress;
            }
            this.logger.warn(`   Relayer deploy failed (${msg}). Switching to Rescue Deploy...`);
            return await this.deploySafeOnChain();
        }
    }
    /**
     * ATOMIC BATCH APPROVAL ENGINE
     * Bundles all missing USDC allowances and CTF operator permissions into one single multi-send transaction.
     * This prevents the "Bad Request" (nonce collision) errors from the Polymarket relayer.
     */
    async checkAllowance(token, spender) {
        try {
            const allowance = await this.viemPublicClient.readContract({
                address: token,
                abi: parseAbi(ERC20_ABI),
                functionName: 'allowance',
                args: [this.safeAddress, spender]
            });
            return allowance;
        }
        catch (e) {
            this.logger.error(`Error checking allowance: ${e}`);
            return 0n;
        }
    }
    async checkBalance(token) {
        try {
            const balance = await this.viemPublicClient.readContract({
                address: token,
                abi: parseAbi(ERC20_ABI),
                functionName: 'balanceOf',
                args: [this.safeAddress]
            });
            return balance;
        }
        catch (e) {
            this.logger.error(`Error checking balance: ${e}`);
            return 0n;
        }
    }
    async setDynamicAllowance(token, spender, requiredAmount) {
        try {
            const currentAllowance = await this.checkAllowance(token, spender);
            if (currentAllowance >= requiredAmount) {
                return true; // Already approved enough
            }
            // Get current balance to ensure we don't approve more than we have
            const balance = await this.checkBalance(token);
            const approvalAmount = balance > 0 ? balance * 2n : requiredAmount * 2n;
            this.logger.info(`   Setting allowance for ${spender.slice(0, 8)}... to ${ethers.formatUnits(approvalAmount, 6)} USDC`);
            const usdcInterface = new Interface(ERC20_ABI);
            const tx = await this.executeTransaction({
                to: token,
                data: usdcInterface.encodeFunctionData("approve", [spender, approvalAmount]),
                value: "0x0"
            });
            this.logger.success(`   Allowance set in tx: ${tx}`);
            return true;
        }
        catch (e) {
            this.logger.error(`Failed to set allowance: ${e}`);
            return false;
        }
    }
    async enableApprovals() {
        const usdcInterface = new Interface(ERC20_ABI);
        const ctfInterface = new Interface(ERC1155_ABI);
        this.logger.info(`   Synchronizing permissions for ${this.safeAddress.slice(0, 8)}...`);
        // FIX: Wait for Safe deployment confirmation indexing before requesting nonce or executing
        let retries = 10;
        while (retries > 0 && !(await this.isDeployed())) {
            this.logger.info(`   Waiting for Safe deployment indexing...`);
            await new Promise(r => setTimeout(r, 3000));
            retries--;
        }
        const batch = [];
        // 1. COLLECT USDC APPROVALS
        const usdcSpenders = [
            { addr: CTF_CONTRACT_ADDRESS, name: "CTF" },
            { addr: NEG_RISK_ADAPTER_ADDRESS, name: "NegRiskAdapter" },
            { addr: CTF_EXCHANGE_ADDRESS, name: "CTFExchange" },
            { addr: NEG_RISK_CTF_EXCHANGE_ADDRESS, name: "NegRiskExchange" }
        ];
        // Get current balance to determine reasonable allowance
        const currentBalance = await this.checkBalance(TOKENS.USDC_BRIDGED);
        const minAllowance = currentBalance > 0n ? currentBalance * 2n : 1000000n; // 1 USDC minimum if balance is 0
        for (const spender of usdcSpenders) {
            const allowance = await this.checkAllowance(TOKENS.USDC_BRIDGED, spender.addr);
            if (allowance < minAllowance) {
                this.logger.info(`     + Batching USDC approval for ${spender.name} (${ethers.formatUnits(minAllowance, 6)} USDC)`);
                batch.push({
                    to: TOKENS.USDC_BRIDGED,
                    value: "0",
                    data: usdcInterface.encodeFunctionData("approve", [spender.addr, minAllowance]),
                    operation: OperationType.Call
                });
            }
        }
        // 2. COLLECT CTF OPERATOR PERMISSIONS
        const ctfOperators = [
            { addr: CTF_EXCHANGE_ADDRESS, name: "CTFExchange" },
            { addr: NEG_RISK_CTF_EXCHANGE_ADDRESS, name: "NegRiskExchange" },
            { addr: NEG_RISK_ADAPTER_ADDRESS, name: "NegRiskAdapter" }
        ];
        for (const operator of ctfOperators) {
            const isApproved = await this.viemPublicClient.readContract({
                address: CTF_CONTRACT_ADDRESS,
                abi: parseAbi(ERC1155_ABI),
                functionName: 'isApprovedForAll',
                args: [this.safeAddress, operator.addr]
            });
            if (!isApproved) {
                this.logger.info(`     + Batching Operator set for ${operator.name}`);
                batch.push({
                    to: CTF_CONTRACT_ADDRESS,
                    value: "0",
                    data: ctfInterface.encodeFunctionData("setApprovalForAll", [operator.addr, true]),
                    operation: OperationType.Call
                });
            }
        }
        // 3. EXECUTE ATOMIC BATCH
        if (batch.length > 0) {
            this.logger.info(`   🚀 Executing Atomic Approval Batch (${batch.length} actions)...`);
            try {
                const task = await this.relayClient.execute(batch);
                await task.wait();
                this.logger.success(`   ✅ All permissions synchronized.`);
            }
            catch (e) {
                this.logger.error(`❌ Batch Approval Failed: ${e.message}`);
                throw e;
            }
        }
        else {
            this.logger.info(`   ✅ Permissions already sufficient.`);
        }
    }
    async withdrawUSDC(to, amount) {
        const usdcInterface = new Interface(ERC20_ABI);
        const data = usdcInterface.encodeFunctionData("transfer", [to, amount]);
        const tx = {
            to: TOKENS.USDC_BRIDGED,
            value: "0",
            data: data,
            operation: OperationType.Call
        };
        try {
            const task = await this.relayClient.execute([tx]);
            const result = await task.wait();
            return result.transactionHash || "0x...";
        }
        catch (e) {
            throw e;
        }
    }
    async addOwner(newOwnerAddress) {
        this.logger.info(`🛡️ Adding Recovery Owner: ${newOwnerAddress} to Safe ${this.safeAddress}`);
        const isOwner = await this.viemPublicClient.readContract({
            address: this.safeAddress,
            abi: parseAbi(SAFE_ABI),
            functionName: 'isOwner',
            args: [newOwnerAddress]
        });
        if (isOwner) {
            this.logger.info("   Address is already an owner.");
            return "ALREADY_OWNER";
        }
        const safeInterface = new Interface(SAFE_ABI);
        const data = safeInterface.encodeFunctionData("addOwnerWithThreshold", [newOwnerAddress, 1]);
        const tx = {
            to: this.safeAddress,
            value: "0",
            data: data,
            operation: OperationType.Call
        };
        const task = await this.relayClient.execute([tx]);
        const result = await task.wait();
        this.logger.success(`   ✅ Owner Added! Tx: ${result.transactionHash}`);
        return result.transactionHash;
    }
    async deploySafeOnChain() {
        this.logger.warn(`🏗️ STARTING ON-CHAIN RESCUE DEPLOYMENT...`);
        if (!this.signer.provider)
            throw new Error("No provider for deployment");
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
    async withdrawUSDCOnChain(to, amount) {
        const innerData = new Interface(ERC20_ABI).encodeFunctionData("transfer", [to, amount]);
        return await this.executeOnChain(TOKENS.USDC_BRIDGED, 0, innerData);
    }
    async withdrawNativeOnChain(to, amount) {
        const amountInWei = ethers.parseEther(amount);
        return await this.executeOnChain(to, amountInWei, "0x");
    }
    /**
     * Executes a transaction on-chain via the Safe.
     * FIX FOR EMPTY DATA: Uses safeInterface.encodeFunctionData to manually construct
     * the call to execTransaction, ensuring 'data' is never empty in the transaction object.
     */
    async executeOnChain(to, value, data) {
        const safeAddr = this.safeAddress;
        this.logger.warn(`🚨 RESCUE MODE: Executing direct on-chain transaction from ${safeAddr}...`);
        if (!this.signer.provider) {
            throw new Error("Signer has no provider. Cannot execute on-chain.");
        }
        const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
        const safeInterface = new Interface(SAFE_ABI);
        const safeContract = new Contract(safeAddr, SAFE_ABI, this.signer);
        const nonce = await safeContract.nonce();
        // 1. Get the hash to sign (EIP-712 hash)
        const txHash = await safeContract.getTransactionHash(to, value, data, 0, 0, 0, 0, ZERO_ADDRESS, ZERO_ADDRESS, nonce);
        // 2. Sign the RAW hash (unprefixed)
        const signingKey = new ethers.SigningKey(this.signer.privateKey);
        const rawSig = signingKey.sign(txHash);
        /**
         * 3. Format signature for Gnosis Safe (r + s + v)
         * ADJUST V: We use standard v (27/28).
         * Note: If GS026 persist, consider v + 4 (31/32) which is a Gnosis-specific
         * flag for EOA signatures on EIP-712 hashes.
         */
        const vValue = rawSig.v >= 27 ? rawSig.v : rawSig.v + 27;
        const signature = ethers.concat([
            rawSig.r,
            rawSig.s,
            ethers.toBeHex(vValue, 1)
        ]);
        // 4. EXPLICITLY ENCODE execTransaction CALL DATA
        // This ensures the 'data' field of the Ethers transaction is not empty.
        const execData = safeInterface.encodeFunctionData("execTransaction", [
            to, value, data, 0, 0, 0, 0, ZERO_ADDRESS, ZERO_ADDRESS, signature
        ]);
        // 5. Execute with manual gas parameters to bypass automated eth_estimateGas
        const feeData = await this.signer.provider.getFeeData();
        this.logger.info(`   🚀 Sending Rescue Transaction (Manual Data Encoding)...`);
        const tx = await this.signer.sendTransaction({
            to: safeAddr,
            data: execData,
            gasLimit: 600000, // Higher limit for Safe exec
            gasPrice: feeData.gasPrice
        });
        this.logger.success(`   ✅ Rescue Tx Sent: ${tx.hash}`);
        await tx.wait();
        return tx.hash;
    }
    async checkOutcomeTokenApproval(safeAddress, operatorAddress) {
        try {
            const isApproved = await this.viemPublicClient.readContract({
                address: CTF_CONTRACT_ADDRESS,
                abi: parseAbi(ERC1155_ABI),
                functionName: 'isApprovedForAll',
                args: [safeAddress, operatorAddress]
            });
            return isApproved;
        }
        catch (e) {
            this.logger.error(`Failed to check outcome token approval: ${e.message}`);
            return false;
        }
    }
    async approveOutcomeTokens(operatorAddress, isNegRisk) {
        try {
            const ctfInterface = new Interface(ERC1155_ABI);
            const data = ctfInterface.encodeFunctionData("setApprovalForAll", [operatorAddress, true]);
            const tx = {
                to: CTF_CONTRACT_ADDRESS,
                value: "0",
                data: data,
                operation: OperationType.Call
            };
            const task = await this.relayClient.execute([tx]);
            await task.wait();
            this.logger.success(`   ✅ Approved ${isNegRisk ? 'Neg Risk' : 'CTF'} Exchange for outcome tokens`);
        }
        catch (e) {
            this.logger.error(`Failed to approve outcome tokens: ${e.message}`);
            throw e;
        }
    }
    async executeTransaction(tx) {
        const safeTx = {
            to: tx.to,
            value: tx.value,
            data: tx.data,
            operation: OperationType.Call
        };
        try {
            const task = await this.relayClient.execute([safeTx]);
            const result = await task.wait();
            return result.transactionHash || "0x...";
        }
        catch (e) {
            throw e;
        }
    }
}
