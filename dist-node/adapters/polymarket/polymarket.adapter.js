import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { JsonRpcProvider, Contract, formatUnits } from 'ethers';
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { SafeManagerService } from '../../services/safe-manager.service.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { TOKENS } from '../../config/env.js';
import axios from 'axios';
const HOST_URL = 'https://clob.polymarket.com';
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];
var SignatureType;
(function (SignatureType) {
    SignatureType[SignatureType["EOA"] = 0] = "EOA";
    SignatureType[SignatureType["POLY_PROXY"] = 1] = "POLY_PROXY";
    SignatureType[SignatureType["POLY_GNOSIS_SAFE"] = 2] = "POLY_GNOSIS_SAFE";
})(SignatureType || (SignatureType = {}));
export class PolymarketAdapter {
    config;
    logger;
    exchangeName = 'Polymarket';
    client;
    wallet;
    walletV5; // Dedicated V5 wallet for SDK
    walletService;
    safeManager;
    usdcContract;
    provider;
    safeAddress;
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    async initialize() {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter (Ethers v6/v5 Hybrid)...`);
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        if (this.config.walletConfig.encryptedPrivateKey) {
            // V6 for general operations
            this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
            // V5 for SDK stability
            this.walletV5 = await this.walletService.getWalletInstanceV5(this.config.walletConfig.encryptedPrivateKey);
        }
        else {
            throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }
        // Initialize Safe Manager
        // Check for safe address in config, or compute it now
        let safeAddressToUse = this.config.walletConfig.safeAddress;
        if (!safeAddressToUse) {
            this.logger.warn(`   ⚠️ Safe address missing in config. Computing...`);
            safeAddressToUse = await SafeManagerService.computeAddress(this.config.walletConfig.address);
        }
        if (!safeAddressToUse) {
            throw new Error("Failed to resolve Safe Address.");
        }
        this.safeManager = new SafeManagerService(this.wallet, this.config.builderApiKey, this.config.builderApiSecret, this.config.builderApiPassphrase, this.logger, safeAddressToUse);
        this.safeAddress = this.safeManager.getSafeAddress();
        this.logger.info(`   Smart Bot Address: ${this.safeAddress}`);
        this.provider = new JsonRpcProvider(this.config.rpcUrl);
        this.usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI, this.provider);
    }
    async validatePermissions() {
        return true;
    }
    async authenticate() {
        if (!this.wallet || !this.safeManager || !this.safeAddress)
            throw new Error("Adapter not initialized");
        // 1. Ensure Safe is Deployed
        await this.safeManager.deploySafe();
        // 2. Ensure Approvals
        await this.safeManager.enableApprovals();
        // 3. L2 Auth (API Keys)
        let apiCreds = this.config.l2ApiCredentials;
        if (!apiCreds || !apiCreds.key) {
            this.logger.info('🤝 Deriving L2 API Keys...');
            await this.deriveAndSaveKeys();
            apiCreds = this.config.l2ApiCredentials;
        }
        else {
            this.logger.info('🔌 Using existing CLOB Credentials');
        }
        // 4. Initialize Clob Client
        this.initClobClient(apiCreds);
    }
    initClobClient(apiCreds) {
        let builderConfig;
        if (this.config.builderApiKey && this.config.builderApiSecret && this.config.builderApiPassphrase) {
            builderConfig = new BuilderConfig({
                localBuilderCreds: {
                    key: this.config.builderApiKey,
                    secret: this.config.builderApiSecret,
                    passphrase: this.config.builderApiPassphrase
                }
            });
        }
        this.client = new ClobClient(HOST_URL, Chain.POLYGON, this.walletV5, apiCreds, SignatureType.POLY_GNOSIS_SAFE, // Funder is Safe
        this.safeAddress, // Explicitly set funder (Maker)
        undefined, undefined, builderConfig);
    }
    async deriveAndSaveKeys() {
        try {
            // Keys must be derived using SignatureType.EOA because the EOA is the signer.
            const tempClient = new ClobClient(HOST_URL, Chain.POLYGON, this.walletV5, undefined, SignatureType.EOA, undefined);
            const rawCreds = await tempClient.createOrDeriveApiKey();
            if (!rawCreds || !rawCreds.key)
                throw new Error("Empty keys returned");
            const apiCreds = {
                key: rawCreds.key,
                secret: rawCreds.secret,
                passphrase: rawCreds.passphrase
            };
            await User.findOneAndUpdate({ address: this.config.userId }, { "tradingWallet.l2ApiCredentials": apiCreds });
            this.config.l2ApiCredentials = apiCreds;
            this.logger.success('✅ API Keys Derived & Saved');
        }
        catch (e) {
            this.logger.error(`Handshake Failed: ${e.message}`);
            throw e;
        }
    }
    async fetchBalance(address) {
        if (!this.usdcContract)
            return 0;
        try {
            const bal = await this.usdcContract.balanceOf(address);
            return parseFloat(formatUnits(bal, 6));
        }
        catch (e) {
            return 0;
        }
    }
    async getMarketPrice(marketId, tokenId) {
        if (!this.client)
            return 0;
        try {
            const mid = await this.client.getMidpoint(tokenId);
            return parseFloat(mid.mid);
        }
        catch (e) {
            return 0;
        }
    }
    async getOrderBook(tokenId) {
        if (!this.client)
            throw new Error("Not auth");
        try {
            const book = await this.client.getOrderBook(tokenId);
            return {
                bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
                asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
            };
        }
        catch (e) {
            if (e.message && e.message.includes('404')) {
                throw new Error("Orderbook not found (Market might be closed)");
            }
            throw e;
        }
    }
    async fetchPublicTrades(address, limit = 20) {
        try {
            const url = `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`;
            const res = await axios.get(url);
            if (!res.data || !Array.isArray(res.data))
                return [];
            return res.data
                .filter(act => act.type === 'TRADE' || act.type === 'ORDER_FILLED')
                .map(act => ({
                trader: address,
                marketId: act.conditionId,
                tokenId: act.asset,
                outcome: act.outcomeIndex === 0 ? 'YES' : 'NO',
                side: act.side.toUpperCase(),
                sizeUsd: act.usdcSize || (act.size * act.price),
                price: act.price,
                timestamp: (act.timestamp > 1e11 ? act.timestamp : act.timestamp * 1000)
            }));
        }
        catch (e) {
            return [];
        }
    }
    async createOrder(params, retryCount = 0) {
        if (!this.client)
            throw new Error("Client not authenticated");
        try {
            // 1. FETCH MARKET CONFIG (Tick Size & Min Size)
            // Default values usually safe for binary markets, but we try to fetch real ones
            let negRisk = false;
            let minOrderSize = 5;
            let tickSize = 0.01;
            try {
                // Get market details to check for Neg Risk and specific constraints
                const market = await this.client.getMarket(params.marketId);
                negRisk = market.neg_risk;
                // Parse Order constraints if available
                if (market.minimum_order_size)
                    minOrderSize = Number(market.minimum_order_size);
                if (market.minimum_tick_size)
                    tickSize = Number(market.minimum_tick_size);
            }
            catch (e) {
                this.logger.debug(`[Order] Market info fetch fallback for ${params.marketId}`);
            }
            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            // 2. PRICE DETERMINATION & TICK ROUNDING
            let rawPrice = params.priceLimit;
            // If no limit provided, take Market Price (hit the book)
            if (rawPrice === undefined) {
                const book = await this.client.getOrderBook(params.tokenId);
                if (side === Side.BUY) {
                    if (!book.asks || book.asks.length === 0)
                        return "skipped_no_liquidity";
                    rawPrice = Number(book.asks[0].price); // Buy at lowest ask
                }
                else {
                    if (!book.bids || book.bids.length === 0)
                        return "skipped_no_liquidity";
                    rawPrice = Number(book.bids[0].price); // Sell at highest bid
                }
            }
            // SAFETY: Clamp Price to valid ranges (0.01 - 0.99 usually)
            // We use tickSize to determine the floor/ceil
            if (rawPrice >= 0.99)
                rawPrice = 0.99;
            if (rawPrice <= 0.01)
                rawPrice = 0.01;
            // ROUND TO TICK SIZE
            // This is critical. If tick is 0.01, price 0.543 becomes 0.54.
            // If we send 0.543, CLOB rejects it.
            const inverseTick = Math.round(1 / tickSize);
            const roundedPrice = Math.floor(rawPrice * inverseTick) / inverseTick;
            // 3. SIZE CALCULATION (SHARES)
            // Polymarket orders are in SHARES, not USD.
            // shares = sizeUsd / price
            const rawShares = params.sizeUsd / roundedPrice;
            // We must floor the shares to avoid fractional share errors if the market doesn't support them well,
            // though Polymarket supports partials, integers are safer for "min size" checks.
            const shares = Math.floor(rawShares);
            // 4. MINIMUM SIZE CHECK
            // If our calculated share count is below the market minimum (usually 5 shares), the API will reject it.
            if (shares < minOrderSize) {
                this.logger.warn(`⚠️ Order Rejected: Size (${shares}) < Minimum (${minOrderSize} shares). Req: $${params.sizeUsd.toFixed(2)} @ ${roundedPrice}`);
                return `skipped_min_size_limit`;
            }
            // 5. CONSTRUCT ORDER
            const order = {
                tokenID: params.tokenId,
                price: roundedPrice,
                side: side,
                size: shares,
                feeRateBps: 0,
                taker: "0x0000000000000000000000000000000000000000" // Standard taker address
            };
            this.logger.info(`📝 Placing Order (Safe): ${params.side} ${shares} shares @ $${roundedPrice.toFixed(2)} (Total: $${(shares * roundedPrice).toFixed(2)})`);
            // 6. POST ORDER (FOK - Fill Or Kill)
            // We use FOK so we don't end up with open orders that clog the account
            const res = await this.client.createAndPostOrder(order, {
                negRisk,
                // Ensure tickSize is passed as a number or string based on SDK requirements
                // Casting to any to bypass strict type checks in some SDK versions that have mismatched types
                tickSize: tickSize
            }, OrderType.FOK);
            if (res && res.success) {
                this.logger.success(`✅ Order Accepted. Tx: ${res.transactionHash || res.orderID || 'OK'}`);
                return res.orderID || res.transactionHash || "filled";
            }
            throw new Error(res.errorMsg || "Order failed response");
        }
        catch (error) {
            const errStr = String(error);
            // Auth Retry Logic (Token Expiry)
            if (retryCount < 1 && (errStr.includes("401") || errStr.includes("403") || errStr.includes("invalid signature"))) {
                this.logger.warn("⚠️ Auth Error. Refreshing keys and retrying...");
                this.config.l2ApiCredentials = undefined;
                await this.deriveAndSaveKeys();
                this.initClobClient(this.config.l2ApiCredentials);
                return this.createOrder(params, retryCount + 1);
            }
            const errorMsg = error.response?.data?.error || error.message;
            // Map common errors to readable logs
            if (errorMsg?.includes("allowance")) {
                this.logger.error("❌ Failed: Insufficient Allowance. Retrying approvals...");
                await this.safeManager?.enableApprovals();
            }
            else if (errorMsg?.includes("balance")) {
                this.logger.error("❌ Failed: Insufficient USDC Balance.");
                return "insufficient_funds";
            }
            else if (errorMsg?.includes("minimum")) {
                this.logger.error(`❌ Failed: Below Min Size (CLOB Rejection).`);
                return "skipped_min_size_limit";
            }
            else {
                this.logger.error(`Order Error: ${errorMsg}`);
            }
            return "failed";
        }
    }
    async cancelOrder(orderId) {
        if (!this.client)
            return false;
        try {
            await this.client.cancelOrder({ orderID: orderId });
            return true;
        }
        catch (e) {
            return false;
        }
    }
    async cashout(amount, destination) {
        if (!this.safeManager)
            throw new Error("Safe Manager not initialized");
        const amountStr = Math.floor(amount * 1000000).toString();
        return await this.safeManager.withdrawUSDC(destination, amountStr);
    }
    getFunderAddress() {
        return this.safeAddress || this.config.walletConfig.address;
    }
}
