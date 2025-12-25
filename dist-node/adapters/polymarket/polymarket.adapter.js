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
        this.logger.info(`   Target Bot Address: ${this.safeAddress}`);
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
            // Use getPrice for more accurate best execution price
            const priceRes = await this.client.getPrice(tokenId, side);
            return parseFloat(priceRes.price) || 0;
        }
        catch (e) {
            // Fallback to midpoint if no liquidity on that specific side
            try {
                const mid = await this.client.getMidpoint(tokenId);
                return parseFloat(mid.mid) || 0;
            }
            catch (midErr) {
                return 0;
            }
        }
    }
    async getAccurateMidpoint(tokenId) {
        if (!this.client)
            throw new Error("Not auth");
        const book = await this.client.getOrderBook(tokenId);
        const bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0;
        const bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : 1;
        const mid = (bestBid + bestAsk) / 2;
        return { mid, bestBid, bestAsk, spread: bestAsk - bestBid };
    }
    async getOrderBook(tokenId) {
        if (!this.client)
            throw new Error("Not auth");
        const book = await this.client.getOrderBook(tokenId);
        return {
            bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
            asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
            min_order_size: book.min_order_size ? Number(book.min_order_size) : 5,
            tick_size: book.tick_size ? Number(book.tick_size) : 0.01,
            neg_risk: book.neg_risk
        };
    }
    async fetchMarketSlugs(marketId) {
        let marketSlug = "";
        let eventSlug = "";
        let question = marketId;
        let image = "";
        // CLOB API for market data - force fresh fetch
        if (this.client && marketId) {
            try {
                // Clear cache to force fresh data
                this.marketMetadataCache.delete(marketId);
                const marketData = await this.client.getMarket(marketId);
                this.marketMetadataCache.set(marketId, marketData);
                if (marketData) {
                    marketSlug = marketData.market_slug || "";
                    question = marketData.question || question;
                    image = marketData.image || image;
                }
            }
            catch (e) {
                this.logger.debug(`CLOB API fetch failed for ${marketId}`);
            }
        }
        // Gamma API for event slug - use slug endpoint for accurate results
        if (marketSlug) {
            try {
                const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${marketSlug}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                const gammaResponse = await fetch(gammaUrl, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (gammaResponse.ok) {
                    const marketData = await gammaResponse.json();
                    // The event slug should be in the events array
                    if (marketData.events && marketData.events.length > 0) {
                        eventSlug = marketData.events[0]?.slug || "";
                    }
                }
            }
            catch (e) {
                this.logger.debug(`Gamma API fetch failed for slug ${marketSlug}`);
            }
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
                if (size <= 0)
                    continue;
                const marketId = p.conditionId || p.market;
                const tokenId = p.asset;
                let currentPrice = parseFloat(p.price) || 0;
                if (currentPrice === 0 && this.client && tokenId) {
                    try {
                        const mid = await this.client.getMidpoint(tokenId);
                        currentPrice = parseFloat(mid.mid) || 0;
                    }
                    catch (e) {
                        currentPrice = parseFloat(p.avgPrice) || 0.5;
                    }
                }
                const entryPrice = parseFloat(p.avgPrice) || currentPrice || 0.5;
                const currentValueUsd = size * currentPrice;
                const investedValueUsd = size * entryPrice;
                const unrealizedPnL = currentValueUsd - investedValueUsd;
                const unrealizedPnLPercent = investedValueUsd > 0 ? (unrealizedPnL / investedValueUsd) * 100 : 0;
                // RESTORED: Deep slug fetching logic
                const { marketSlug, eventSlug, question, image } = await this.fetchMarketSlugs(marketId);
                positions.push({
                    marketId: marketId,
                    tokenId: tokenId,
                    outcome: p.outcome || 'UNK',
                    balance: size,
                    valueUsd: currentValueUsd,
                    investedValue: investedValueUsd,
                    entryPrice: entryPrice,
                    currentPrice: currentPrice,
                    unrealizedPnL: unrealizedPnL,
                    unrealizedPnLPercent: unrealizedPnLPercent,
                    question: question,
                    image: image,
                    marketSlug: marketSlug,
                    eventSlug: eventSlug,
                    clobOrderId: tokenId
                });
            }
            return positions;
        }
        catch (e) {
            this.logger.error("Failed to fetch positions", e);
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
            if (params.side === 'SELL') {
                await this.ensureOutcomeTokenApproval(market.neg_risk);
            }
            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            // Single fetch of orderbook for efficiency and accuracy
            const book = await this.client.getOrderBook(params.tokenId);
            // Log market levels for transparency
            const topBids = book.bids.slice(0, 3).map(b => `${b.price} (${b.size})`).join(', ');
            const topAsks = book.asks.slice(0, 3).map(a => `${a.price} (${a.size})`).join(', ');
            this.logger.info(`Book [${params.tokenId}]: Bids: [${topBids || 'none'}] | Asks: [${topAsks || 'none'}]`);
            // Determine execution price based on side
            let rawPrice;
            if (side === Side.SELL) {
                if (!book.bids.length)
                    return { success: false, error: "skipped_no_bids", sharesFilled: 0, priceFilled: 0 };
                rawPrice = parseFloat(book.bids[0].price); // Hit the best bid
            }
            else {
                if (!book.asks.length)
                    return { success: false, error: "skipped_no_liquidity", sharesFilled: 0, priceFilled: 0 };
                // For buys, use best ask price or user-defined limit
                rawPrice = params.priceLimit || parseFloat(book.asks[0].price);
            }
            // Round to tick size based on direction (Buys ceil, Sells floor)
            const inverseTick = Math.round(1 / tickSize);
            const roundedPrice = side === Side.BUY
                ? Math.ceil(rawPrice * inverseTick) / inverseTick
                : Math.floor(rawPrice * inverseTick) / inverseTick;
            const finalPrice = Math.max(0.001, Math.min(0.999, roundedPrice));
            // Calculate shares
            const shares = params.sizeShares || Math.floor(params.sizeUsd / finalPrice);
            if (shares < minOrderSize) {
                return { success: false, error: "skipped_min_size_limit", sharesFilled: 0, priceFilled: 0 };
            }
            this.logger.info(`Placing Order: ${params.side} ${shares} shares @ ${finalPrice.toFixed(3)}`);
            const orderArgs = {
                tokenID: params.tokenId,
                price: finalPrice,
                side: side,
                size: Math.floor(shares),
                feeRateBps: 0,
                taker: "0x0000000000000000000000000000000000000000"
            };
            const signedOrder = await this.client.createOrder(orderArgs);
            const orderType = side === Side.SELL ? OrderType.FAK : OrderType.GTC;
            const res = await this.client.postOrder(signedOrder, orderType);
            if (res && res.success) {
                this.logger.success(`Order Accepted. ID: ${res.orderID}`);
                return {
                    success: true,
                    orderId: res.orderID,
                    txHash: res.transactionHash,
                    sharesFilled: shares,
                    priceFilled: finalPrice
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
        return [];
    }
    async cashout(amount, destination) {
        if (!this.safeManager)
            throw new Error("Safe Manager not initialized");
        const amountStr = Math.floor(amount * 1000000).toString();
        return await this.safeManager.withdrawUSDC(destination, amountStr);
    }
    async ensureOutcomeTokenApproval(isNegRisk) {
        if (!this.safeManager)
            throw new Error("Safe Manager not initialized");
        const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
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
                this.logger.success(`   ✅ CTF permissions granted.`);
            }
        }
        catch (e) {
            this.logger.error(`Failed to approve outcome tokens: ${e.message}`);
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
}
