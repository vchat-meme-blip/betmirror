import { Interface, Contract, ethers } from 'ethers';
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
// Gnosis Safe Constants (Polymarket Specific Factory)
const SAFE_PROXY_FACTORY_ADDRESS = "0xaacfeea03eb1561c4e67d661e40682bd20e3541b";
const SAFE_SINGLETON_ADDRESS = "0x3e5c63644e683549055b9be8653de26e0b4cd36e";
const FALLBACK_HANDLER_ADDRESS = "0xf48f2b2d2a534e40247ecb36350021948091179d";
const SAFE_ABI = [
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
    "function nonce() view returns (uint256)",
    "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
    "function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)"
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
            transport: http()
        });
        this.viemPublicClient = createPublicClient({
            chain: polygon,
            transport: http('https://polygon-rpc.com')
        });
        this.relayClient = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, viemClient, builderConfig);
    }
    getSafeAddress() {
        return this.safeAddress;
    }
    /**
     * Compute Address using specific Factory to ensure consistency between
     * our DB generation and our manual on-chain deployment logic.
     */
    static async computeAddress(ownerAddress) {
        return await deriveSafe(ownerAddress, SAFE_PROXY_FACTORY_ADDRESS);
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
        // 1. Check if already deployed
        if (await this.isDeployed()) {
            this.logger.info(`   Safe ${this.safeAddress.slice(0, 8)}... is active.`);
            return this.safeAddress;
        }
        this.logger.info(`🚀 Deploying Gnosis Safe ${this.safeAddress.slice(0, 8)}...`);
        try {
            const task = await this.relayClient.deploy();
            await task.wait();
            const realAddress = task.proxyAddress;
            // Note: Since we updated SAFE_PROXY_FACTORY_ADDRESS, this should now MATCH the SDK.
            if (realAddress && realAddress.toLowerCase() !== this.safeAddress.toLowerCase()) {
                this.logger.warn(`⚠️ Relayer deployed to ${realAddress}, but DB has ${this.safeAddress}.`);
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
    async enableApprovals() {
        const txs = [];
        const usdcInterface = new Interface(ERC20_ABI);
        const ctfInterface = new Interface(ERC1155_ABI);
        this.logger.info(`   Checking permissions for ${this.safeAddress.slice(0, 8)}...`);
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
                });
                if (allowance < 1000000000n) {
                    this.logger.info(`     + Granting USDC to ${spender.name}`);
                    const data = usdcInterface.encodeFunctionData("approve", [spender.addr, MAX_UINT256]);
                    txs.push({ to: TOKENS.USDC_BRIDGED, value: "0", data: data, operation: OperationType.Call });
                }
            }
            catch (e) { }
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
                });
                if (!isApproved) {
                    this.logger.info(`     + Granting Operator to ${operator.name}`);
                    const data = ctfInterface.encodeFunctionData("setApprovalForAll", [operator.addr, true]);
                    txs.push({ to: CTF_CONTRACT_ADDRESS, value: "0", data: data, operation: OperationType.Call });
                }
            }
            catch (e) { }
        }
        if (txs.length === 0)
            return;
        try {
            this.logger.info(`🔐 Broadcasting ${txs.length} setup transactions via Relayer...`);
            const task = await this.relayClient.execute(txs);
            await task.wait();
            this.logger.success("   Permissions updated.");
        }
        catch (e) {
            this.logger.warn(`   Setup note: ${e.message}. (Will retry automatically if trading fails)`);
        }
    }
    async withdrawUSDC(to, amount) {
        const safe = this.safeAddress;
        const usdcInterface = new Interface(ERC20_ABI);
        const data = usdcInterface.encodeFunctionData("transfer", [to, amount]);
        const tx = {
            to: TOKENS.USDC_BRIDGED,
            value: "0",
            data: data,
            operation: OperationType.Call
        };
        this.logger.info(`💸 Withdrawing USDC via Relayer...`);
        this.logger.info(`   Safe: ${safe} -> To: ${to} ($${(Number(amount) / 1e6).toFixed(2)})`);
        try {
            // ATTEMPT 1: Standard SDK (Relayer)
            const task = await this.relayClient.execute([tx]);
            this.logger.info(`   Tx Submitted: ${task.transactionHash}`);
            return task.transactionHash;
        }
        catch (e) {
            this.logger.warn(`   ⚠️ Relayer withdrawal failed (${e.message}).`);
            this.logger.warn(`   -> Switching to RESCUE MODE (On-Chain) for ${safe}.`);
            return await this.withdrawUSDCOnChain(to, amount);
        }
    }
    async withdrawNative(to, amount) {
        const safe = this.safeAddress;
        const tx = {
            to: to,
            value: amount, // Wei amount of POL/MATIC
            data: "0x",
            operation: OperationType.Call
        };
        this.logger.info(`💸 Withdrawing POL via Relayer...`);
        this.logger.info(`   Safe: ${safe} -> To: ${to} (${ethers.formatEther(amount)} POL)`);
        try {
            const task = await this.relayClient.execute([tx]);
            this.logger.info(`   Tx Submitted: ${task.transactionHash}`);
            return task.transactionHash;
        }
        catch (e) {
            this.logger.warn(`   ⚠️ Relayer withdrawal failed (${e.message}).`);
            this.logger.warn(`   -> Switching to RESCUE MODE (On-Chain) for ${safe}.`);
            return await this.withdrawNativeOnChain(to, amount);
        }
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
        const factory = new Contract(SAFE_PROXY_FACTORY_ADDRESS, PROXY_FACTORY_ABI, this.signer);
        const saltNonce = 0;
        this.logger.info(`   🚀 Sending Deployment Transaction...`);
        const tx = await factory.createProxyWithNonce(SAFE_SINGLETON_ADDRESS, initializer, saltNonce);
        await tx.wait();
        this.logger.success(`   ✅ Safe Deployed Successfully!`);
        return this.safeAddress;
    }
    async withdrawUSDCOnChain(to, amount) {
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
        }
        catch (e) {
            throw new Error("Failed to get Safe nonce: " + e.message);
        }
        const safeTxGas = 0;
        const baseGas = 0;
        const gasPrice = 0;
        const gasToken = "0x0000000000000000000000000000000000000000";
        const refundReceiver = "0x0000000000000000000000000000000000000000";
        const operation = 0; // Call
        const txHashBytes = await safeContract.getTransactionHash(TOKENS.USDC_BRIDGED, 0, innerData, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce);
        const signature = await this.signer.signMessage(Buffer.from(txHashBytes.slice(2), 'hex'));
        this.logger.info(`   Broacasting Rescue Tx...`);
        // Gas check for Signer
        const gasBal = await this.signer.provider.getBalance(this.signer.address);
        if (gasBal < 10000000000000000n) { // 0.01 POL
            throw new Error("Signer needs POL (Matic) to execute rescue transaction.");
        }
        const tx = await safeContract.execTransaction(TOKENS.USDC_BRIDGED, 0, innerData, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signature);
        this.logger.success(`   ✅ Rescue Tx Sent: ${tx.hash}`);
        await tx.wait();
        return tx.hash;
    }
    async withdrawNativeOnChain(to, amount) {
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
        }
        catch (e) {
            throw new Error("Failed to get Safe nonce: " + e.message);
        }
        const safeTxGas = 0;
        const baseGas = 0;
        const gasPrice = 0;
        const gasToken = "0x0000000000000000000000000000000000000000";
        const refundReceiver = "0x0000000000000000000000000000000000000000";
        const operation = 0; // Call
        const txHashBytes = await safeContract.getTransactionHash(to, amount, "0x", // data
        operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce);
        const signature = await this.signer.signMessage(Buffer.from(txHashBytes.slice(2), 'hex'));
        this.logger.info(`   Broacasting Rescue POL Tx...`);
        // Gas check for Signer
        const gasBal = await this.signer.provider.getBalance(this.signer.address);
        if (gasBal < 10000000000000000n) { // 0.01 POL
            throw new Error("Signer needs POL (Matic) to execute rescue transaction.");
        }
        const tx = await safeContract.execTransaction(to, amount, "0x", operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signature);
        this.logger.success(`   ✅ Rescue Tx Sent: ${tx.hash}`);
        await tx.wait();
        return tx.hash;
    }
}
