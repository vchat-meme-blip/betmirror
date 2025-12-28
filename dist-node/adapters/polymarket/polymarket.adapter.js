import { LiquidityHealth } from '../interfaces.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { JsonRpcProvider, Contract, formatUnits, Interface } from 'ethers';
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { SafeManagerService } from '../../services/safe-manager.service.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { TOKENS } from '../../config/env.js';
import axios from 'axios';
const HOST_URL = 'https://clob.polymarket.com';
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)', 'function allowance(address owner, address spender) view returns (uint256)'];
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
    marketMetadataCache = new Map();
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    async initialize() {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter...`);
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        if (this.config.walletConfig.encryptedPrivateKey) {
            this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
            this.walletV5 = await this.walletService.getWalletInstanceV5(this.config.walletConfig.encryptedPrivateKey);
        }
        else {
            throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }
        const sdkAlignedAddress = await SafeManagerService.computeAddress(this.config.walletConfig.address);
        this.safeAddress = sdkAlignedAddress;
        this.safeManager = new SafeManagerService(this.wallet, this.config.builderApiKey, this.config.builderApiSecret, this.config.builderApiPassphrase, this.logger, this.safeAddress);
        this.provider = new JsonRpcProvider(this.config.rpcUrl);
        this.usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI, this.provider);
    }
    async validatePermissions() {
        return true;
    }
    async authenticate() {
        if (!this.wallet || !this.safeManager || !this.safeAddress)
            throw new Error("Adapter not initialized");
        await this.safeManager.deploySafe();
        await this.safeManager.enableApprovals();
        let apiCreds = this.config.l2ApiCredentials;
        if (!apiCreds || !apiCreds.key) {
            this.logger.info('Handshake: Deriving L2 API Keys...');
            await this.deriveAndSaveKeys();
            apiCreds = this.config.l2ApiCredentials;
        }
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
        this.client = new ClobClient(HOST_URL, Chain.POLYGON, this.walletV5, apiCreds, SignatureType.POLY_GNOSIS_SAFE, this.safeAddress, undefined, undefined, builderConfig);
    }
    async deriveAndSaveKeys() {
        try {
            const tempClient = new ClobClient(HOST_URL, Chain.POLYGON, this.walletV5, undefined, SignatureType.EOA, undefined);
            const rawCreds = await tempClient.createOrDeriveApiKey();
            if (!rawCreds || !rawCreds.key)
                throw new Error("Empty keys returned");
            const apiCreds = {
                key: rawCreds.key,
                secret: rawCreds.secret,
                passphrase: rawCreds.passphrase
            };
            await User.findOneAndUpdate({ address: this.config.userId }, {
                "tradingWallet.l2ApiCredentials": apiCreds,
                "tradingWallet.safeAddress": this.safeAddress
            });
            this.config.l2ApiCredentials = apiCreds;
            this.logger.success('API Keys Derived and Saved');
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
    async getPortfolioValue(address) {
        try {
            const res = await axios.get(`https://data-api.polymarket.com/value?user=${address}`);
            return parseFloat(res.data) || 0;
        }
        catch (e) {
            return 0;
        }
    }
    async getMarketPrice(marketId, tokenId, side = 'BUY') {
        if (!this.client)
            return 0;
        try {
            const priceRes = await this.client.getPrice(tokenId, side);
            return parseFloat(priceRes.price) || 0;
        }
        catch (e) {
            try {
                const mid = await this.client.getMidpoint(tokenId);
                return parseFloat(mid.mid) || 0;
            }
            catch (midErr) {
                return 0;
            }
        }
    }
    async getOrderBook(tokenId) {
        if (!this.client)
            throw new Error("Not auth");
        try {
            const book = await this.client.getOrderBook(tokenId);
            // MUST sort and parse - API may return strings in any order
            const sortedBids = book.bids
                .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
                .sort((a, b) => b.price - a.price); // Highest bid first
            const sortedAsks = book.asks
                .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
                .sort((a, b) => a.price - b.price); // Lowest ask first
            return {
                bids: sortedBids,
                asks: sortedAsks,
                min_order_size: Number(book.min_order_size) || 5,
                tick_size: Number(book.tick_size) || 0.01,
                neg_risk: book.neg_risk
            };
        }
        catch (e) {
            if (String(e).includes("404") || String(e).includes("No orderbook")) {
                // Return empty book for closed markets
                this.logger.warn(`[OrderBook] Market closed or not found for token ${tokenId.slice(0, 10)}...`);
                return { bids: [], asks: [], min_order_size: 5, tick_size: 0.01, neg_risk: false };
            }
            throw e;
        }
    }
    /**
     * UPDATED LIQUIDITY MATH:
     * We now use absolute cent spreads instead of percentages.
     * This is critical for prediction markets where 1c vs 2c is a tiny gap but a huge %.
     */
    async getLiquidityMetrics(tokenId, side) {
        if (!this.client)
            throw new Error("Not auth");
        const book = await this.client.getOrderBook(tokenId);
        // Check if market is resolved (empty order book)
        if (book.bids.length === 0 && book.asks.length === 0) {
            throw new Error("No orderbook exists for the requested token id");
        }
        // Force sort to ensure best prices are at index 0
        const sortedBids = [...book.bids]
            .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
            .sort((a, b) => b.price - a.price); // Highest first
        const sortedAsks = [...book.asks]
            .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
            .sort((a, b) => a.price - b.price); // Lowest first
        const bestBid = sortedBids.length > 0 ? sortedBids[0].price : 0;
        const bestAsk = sortedAsks.length > 0 ? sortedAsks[0].price : 1;
        // ABSOLUTE spread in cents - NOT percentage
        const spreadAbs = bestAsk - bestBid;
        const midpoint = (bestBid + bestAsk) / 2;
        // Keep spreadPercent for logging only, NOT for health decisions
        const spreadPercent = midpoint > 0 ? (spreadAbs / midpoint) * 100 : 100;
        // USD depth on the relevant side (what matters for execution)
        let depthUsd = 0;
        if (side === 'SELL') {
            // How much USD is waiting to buy our shares?
            depthUsd = sortedBids.slice(0, 3).reduce((sum, b) => sum + (b.size * b.price), 0);
        }
        else {
            // How much USD of shares is available for us to buy?
            depthUsd = sortedAsks.slice(0, 3).reduce((sum, a) => sum + (a.size * a.price), 0);
        }
        // Health based on ABSOLUTE spread (cents) + USD depth
        // For prediction markets: depth matters MORE than spread at extreme prices
        let health = LiquidityHealth.CRITICAL;
        if (spreadAbs <= 0.02 && depthUsd >= 500) {
            health = LiquidityHealth.HIGH; // Tight spread, deep book
        }
        else if (spreadAbs <= 0.05 && depthUsd >= 100) {
            health = LiquidityHealth.MEDIUM; // Moderate spread, decent depth
        }
        else if (depthUsd >= 20) {
            health = LiquidityHealth.LOW; // Depth exists - tradeable but risky
        }
        // else CRITICAL - no real liquidity
        return {
            health,
            spread: spreadAbs,
            spreadPercent,
            availableDepthUsd: depthUsd,
            bestPrice: side === 'SELL' ? bestBid : bestAsk
        };
    }
    async fetchMarketSlugs(marketId) {
        let marketSlug = "";
        let eventSlug = "";
        let question = marketId;
        let image = "";
        try {
            // Use Gamma API with condition_id - this returns BOTH slugs
            const gammaUrl = `https://gamma-api.polymarket.com/markets?condition_id=${marketId}`;
            const gammaResponse = await axios.get(gammaUrl);
            if (gammaResponse.data && gammaResponse.data.length > 0) {
                const market = gammaResponse.data[0];
                marketSlug = market.slug || "";
                question = market.question || question;
                image = market.image || image;
                // Get event slug from nested events array
                if (market.events && market.events.length > 0) {
                    eventSlug = market.events[0]?.slug || "";
                }
            }
        }
        catch (e) {
            this.logger.warn(`[fetchMarketSlugs] Failed for ${marketId}: ${e}`);
        }
        return { marketSlug, eventSlug, question, image };
    }
    async getPositions(address) {
        try {
            const url = `https://data-api.polymarket.com/positions?user=${address}`;
            const res = await axios.get(url);
            if (!Array.isArray(res.data))
                return [];
            const positions = [];
            for (const p of res.data) {
                const size = parseFloat(p.size) || 0;
                if (size <= 0.01)
                    continue;
                const marketId = p.conditionId || p.market;
                const tokenId = p.asset;
                // Get current price from midpoint (most reliable)
                let currentPrice = 0;
                if (this.client && tokenId) {
                    try {
                        const mid = await this.client.getMidpoint(tokenId);
                        currentPrice = parseFloat(mid.mid) || 0;
                    }
                    catch (e) {
                        // Fallback to API price if midpoint fails
                        currentPrice = parseFloat(p.price) || 0;
                    }
                }
                else {
                    currentPrice = parseFloat(p.price) || 0;
                }
                // Entry price from avgPrice, fallback to current
                const entryPrice = parseFloat(p.avgPrice) || currentPrice || 0.5;
                const currentValueUsd = size * currentPrice;
                const investedValueUsd = size * entryPrice;
                const unrealizedPnL = currentValueUsd - investedValueUsd;
                const { marketSlug, eventSlug, question, image } = await this.fetchMarketSlugs(marketId);
                positions.push({
                    marketId,
                    tokenId,
                    outcome: p.outcome || 'UNK',
                    balance: size,
                    valueUsd: currentValueUsd,
                    investedValue: investedValueUsd,
                    entryPrice,
                    currentPrice,
                    unrealizedPnL,
                    question,
                    image,
                    marketSlug,
                    eventSlug,
                    clobOrderId: tokenId
                });
            }
            return positions;
        }
        catch (e) {
            return [];
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
    async getTradeHistory(address, limit = 50) {
        return [];
    }
    async createOrder(params, retryCount = 0) {
        if (!this.client)
            throw new Error("Client not authenticated");
        try {
            const market = await this.client.getMarket(params.marketId);
            const tickSize = Number(market.minimum_tick_size) || 0.01;
            const minOrderSize = Number(market.minimum_order_size) || 5;
            if (params.side === 'BUY') {
                await this.ensureUsdcAllowance(market.neg_risk, params.sizeUsd);
            }
            else {
                await this.ensureOutcomeTokenApproval(market.neg_risk);
            }
            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            const book = await this.getOrderBook(params.tokenId);
            let rawPrice;
            if (side === Side.SELL) {
                if (!book.bids.length)
                    return { success: false, error: "skipped_no_bids", sharesFilled: 0, priceFilled: 0 };
                rawPrice = book.bids[0].price; // HIT THE BEST BID
                if (params.priceLimit !== undefined && params.priceLimit > rawPrice) {
                    rawPrice = params.priceLimit;
                }
            }
            else {
                if (!book.asks.length)
                    return { success: false, error: "skipped_no_liquidity", sharesFilled: 0, priceFilled: 0 };
                rawPrice = book.asks[0].price; // HIT THE BEST ASK
                if (params.priceLimit !== undefined && params.priceLimit < rawPrice) {
                    rawPrice = params.priceLimit;
                }
            }
            const inverseTick = Math.round(1 / tickSize);
            // Directional rounding for taker orders
            const roundedPrice = side === Side.BUY
                ? Math.ceil(rawPrice * inverseTick) / inverseTick
                : Math.floor(rawPrice * inverseTick) / inverseTick;
            const finalPrice = Math.max(0.001, Math.min(0.999, roundedPrice));
            let shares = params.sizeShares || (params.side === 'BUY'
                ? Math.ceil(params.sizeUsd / finalPrice)
                : Math.floor(params.sizeUsd / finalPrice));
            if (params.side === 'BUY' && (shares * finalPrice) < 1.00) {
                shares = Math.ceil(1.00 / finalPrice);
            }
            if (shares < minOrderSize) {
                return { success: false, error: "BELOW_MIN_SIZE", sharesFilled: 0, priceFilled: 0 };
            }
            this.logger.info(`Placing Order: ${params.side} ${shares} shares @ ${finalPrice.toFixed(3)} (Limit)`);
            const signedOrder = await this.client.createOrder({
                tokenID: params.tokenId,
                price: finalPrice,
                side: side,
                size: Math.floor(shares),
                feeRateBps: 0,
                taker: "0x0000000000000000000000000000000000000000"
            });
            // SELL orders MUST use FAK to hit best bid without staying in the book
            const orderType = side === Side.SELL ? OrderType.FAK : OrderType.GTC;
            const res = await this.client.postOrder(signedOrder, orderType);
            if (res && res.success) {
                let actualFilledShares = 0;
                let actualUsdMoved = 0;
                if (params.side === 'BUY') {
                    actualFilledShares = parseFloat(res.takingAmount || '0');
                    actualUsdMoved = parseFloat(res.makingAmount || '0') / 1e6;
                }
                else {
                    actualUsdMoved = parseFloat(res.takingAmount || '0') / 1e6; // Real USDC Received
                    actualFilledShares = parseFloat(res.makingAmount || '0'); // Real Shares Given
                }
                const avgPrice = actualFilledShares > 0 ? actualUsdMoved / actualFilledShares : finalPrice;
                return {
                    success: true,
                    orderId: res.orderID,
                    txHash: res.transactionHash,
                    sharesFilled: actualFilledShares,
                    priceFilled: avgPrice,
                    usdFilled: actualUsdMoved
                };
            }
            throw new Error(res.errorMsg || "Order failed response");
        }
        catch (error) {
            if (retryCount < 1 && (String(error).includes("401") || String(error).includes("signature"))) {
                await this.deriveAndSaveKeys();
                this.initClobClient(this.config.l2ApiCredentials);
                return this.createOrder(params, retryCount + 1);
            }
            return { success: false, error: error.message, sharesFilled: 0, priceFilled: 0 };
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
    async getOpenOrders() {
        if (!this.client)
            return [];
        try {
            const orders = await this.client.getOpenOrders();
            return orders || [];
        }
        catch (e) {
            return [];
        }
    }
    async cashout(amount, destination) {
        if (!this.safeManager)
            throw new Error("Safe Manager not initialized");
        const amountStr = Math.floor(amount * 1000000).toString();
        return await this.safeManager.withdrawUSDC(destination, amountStr);
    }
    async ensureUsdcAllowance(isNegRisk, tradeAmountUsd = 0) {
        if (!this.safeManager || !this.safeAddress)
            throw new Error("Safe Manager not initialized");
        const EXCHANGE = isNegRisk ? "0xC5d563A36AE78145C45a50134d48A1215220f80a" : "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        const allowance = await this.usdcContract.allowance(this.safeAddress, EXCHANGE);
        const requiredAmountRaw = BigInt(Math.ceil((tradeAmountUsd + 1) * 1000000));
        if (allowance < requiredAmountRaw) {
            await this.safeManager.enableApprovals();
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    async checkUsdcAllowance(isNegRisk = false) {
        if (!this.safeManager)
            throw new Error("Safe Manager not initialized");
        const EXCHANGE = isNegRisk ? "0xC5d563A36AE78145C45a50134d48A1215220f80a" : "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        const allowance = await this.usdcContract.allowance(this.safeAddress, EXCHANGE);
        return Number(allowance) / 1000000;
    }
    async ensureOutcomeTokenApproval(isNegRisk) {
        if (!this.safeManager)
            throw new Error("Safe Manager not initialized");
        const EXCHANGE = isNegRisk
            ? "0xC5d563A36AE78145C45a50134d48A1215220f80a"
            : "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        try {
            const safeAddr = this.safeAddress;
            if (!safeAddr)
                return;
            const isApproved = await this.safeManager.checkOutcomeTokenApproval(safeAddr, EXCHANGE);
            if (!isApproved) {
                this.logger.info(`   + Granting outcome token rights to ${isNegRisk ? 'NegRisk' : 'Standard'} Exchange...`);
                await this.safeManager.approveOutcomeTokens(EXCHANGE, isNegRisk);
                // Indexing Grace Period
                await new Promise(r => setTimeout(r, 5000));
            }
        }
        catch (e) {
            throw e;
        }
    }
    getFunderAddress() {
        return this.safeAddress || this.config.walletConfig.address;
    }
    getRawClient() {
        return this.client;
    }
    getSigner() {
        return this.wallet;
    }
    async redeemPosition(marketId, tokenId) {
        if (!this.safeManager || !this.safeAddress)
            return { success: false, error: "Adapter not initialized" };
        const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
        const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
        try {
            const balanceBefore = await this.fetchBalance(this.safeAddress);
            const redeemTx = {
                to: CTF_ADDRESS,
                data: this.encodeRedeemPositions(USDC_ADDRESS, "0x0000000000000000000000000000000000000000000000000000000000000000", marketId, [1, 2]),
                value: "0"
            };
            const txHash = await this.safeManager.executeTransaction(redeemTx);
            await new Promise(r => setTimeout(r, 5000));
            const balanceAfter = await this.fetchBalance(this.safeAddress);
            return { success: true, amountUsd: balanceAfter - balanceBefore, txHash };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    }
    encodeRedeemPositions(collateralToken, parentCollectionId, conditionId, indexSets) {
        const iface = new Interface(["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"]);
        return iface.encodeFunctionData("redeemPositions", [collateralToken, parentCollectionId, conditionId, indexSets]);
    }
}
