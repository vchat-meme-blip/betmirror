import { LiquidityHealth } from '../interfaces.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { JsonRpcProvider, Contract, formatUnits, Interface, ethers } from 'ethers';
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { SafeManagerService } from '../../services/safe-manager.service.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { TOKENS } from '../../config/env.js';
import axios from 'axios';
const HOST_URL = 'https://clob.polymarket.com';
const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
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
    walletV5;
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
        this.logger.info(`[${this.exchangeName}] Initializing Adapter for user ${this.config.userId}...`);
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        if (this.config.walletConfig.encryptedPrivateKey) {
            this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
            this.walletV5 = await this.walletService.getWalletInstanceV5(this.config.walletConfig.encryptedPrivateKey);
        }
        else {
            throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }
        // Derive deterministic address aligned with Polymarket SDK logic
        const sdkAlignedAddress = await SafeManagerService.computeAddress(this.config.walletConfig.address);
        this.safeAddress = sdkAlignedAddress;
        this.safeManager = new SafeManagerService(this.wallet, this.config.builderApiKey, this.config.builderApiSecret, this.config.builderApiPassphrase, this.logger, this.safeAddress);
        this.provider = new JsonRpcProvider(this.config.rpcUrl);
        const USDC_ABI_INTERNAL = [
            'function balanceOf(address owner) view returns (uint256)',
            'function allowance(address owner, address spender) view returns (uint256)',
            'function transfer(address to, uint256 amount) returns (bool)'
        ];
        this.usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI_INTERNAL, this.provider);
    }
    async validatePermissions() {
        return true;
    }
    async authenticate() {
        if (!this.wallet || !this.safeManager || !this.safeAddress)
            throw new Error("Adapter not initialized");
        // Ensure Safe is deployed and permissions (USDC/CTF) are set gaslessly
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
        const book = await this.client.getOrderBook(tokenId);
        const sortedBids = book.bids
            .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
            .sort((a, b) => b.price - a.price);
        const sortedAsks = book.asks
            .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
            .sort((a, b) => a.price - b.price);
        return {
            bids: sortedBids,
            asks: sortedAsks,
            min_order_size: Number(book.min_order_size) || 5,
            tick_size: Number(book.tick_size) || 0.01,
            neg_risk: book.neg_risk
        };
    }
    async getLiquidityMetrics(tokenId, side) {
        if (!this.client)
            throw new Error("Not auth");
        const book = await this.getOrderBook(tokenId);
        const bestBid = book.bids.length > 0 ? book.bids[0].price : 0;
        const bestAsk = book.asks.length > 0 ? book.asks[0].price : 1;
        const spreadAbs = bestAsk - bestBid;
        const midpoint = (bestBid + bestAsk) / 2;
        const spreadPercent = midpoint > 0 ? (spreadAbs / midpoint) * 100 : 100;
        let depthUsd = 0;
        if (side === 'SELL') {
            depthUsd = book.bids.slice(0, 3).reduce((sum, b) => sum + (b.size * b.price), 0);
        }
        else {
            depthUsd = book.asks.slice(0, 3).reduce((sum, a) => sum + (a.size * a.price), 0);
        }
        let health = LiquidityHealth.CRITICAL;
        if (spreadAbs <= 0.02 && depthUsd >= 500) {
            health = LiquidityHealth.HIGH;
        }
        else if (spreadAbs <= 0.05 && depthUsd >= 100) {
            health = LiquidityHealth.MEDIUM;
        }
        else if (depthUsd >= 20) {
            health = LiquidityHealth.LOW;
        }
        return {
            health,
            spread: spreadAbs,
            spreadPercent,
            availableDepthUsd: depthUsd,
            bestPrice: side === 'SELL' ? bestBid : bestAsk
        };
    }
    async getNegRiskMarkets() {
        try {
            const res = await axios.get(`${HOST_URL}/markets?active=true&closed=false`);
            const markets = res.data?.data || [];
            return markets.filter((m) => m.neg_risk === true && m.tokens?.length > 1);
        }
        catch (e) {
            return [];
        }
    }
    async fetchMarketSlugs(marketId) {
        let marketSlug = "";
        let eventSlug = "";
        let question = marketId;
        let image = "";
        if (this.client && marketId) {
            try {
                const marketData = await this.client.getMarket(marketId);
                if (marketData) {
                    marketSlug = marketData.market_slug || "";
                    question = marketData.question || question;
                    image = marketData.image || image;
                }
            }
            catch (e) { }
        }
        if (marketSlug) {
            try {
                const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${marketSlug}`;
                const gammaResponse = await fetch(gammaUrl);
                if (gammaResponse.ok) {
                    const marketData = await gammaResponse.json();
                    if (marketData.events && marketData.events.length > 0) {
                        eventSlug = marketData.events[0]?.slug || "";
                    }
                }
            }
            catch (e) { }
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
                const marketId = p.market || p.conditionId;
                const conditionId = p.conditionId || p.asset;
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
                const { marketSlug, eventSlug, question, image } = await this.fetchMarketSlugs(marketId);
                positions.push({
                    marketId: marketId,
                    conditionId: conditionId,
                    tokenId: tokenId,
                    outcome: p.outcome || 'UNK',
                    balance: size,
                    valueUsd: currentValueUsd,
                    investedValue: investedValueUsd,
                    entryPrice: entryPrice,
                    currentPrice: currentPrice,
                    unrealizedPnL: unrealizedPnL,
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
                rawPrice = book.bids[0].price;
                if (params.priceLimit !== undefined && params.priceLimit > rawPrice)
                    rawPrice = params.priceLimit;
            }
            else {
                if (!book.asks.length)
                    return { success: false, error: "skipped_no_liquidity", sharesFilled: 0, priceFilled: 0 };
                rawPrice = book.asks[0].price;
                if (params.priceLimit !== undefined && params.priceLimit < rawPrice)
                    rawPrice = params.priceLimit;
            }
            // Round price to tick size
            const inverseTick = Math.round(1 / tickSize);
            const roundedPrice = side === Side.BUY
                ? Math.ceil(rawPrice * inverseTick) / inverseTick
                : Math.floor(rawPrice * inverseTick) / inverseTick;
            // FIX: Round price to 2 decimal places max
            const finalPrice = Math.max(0.01, Math.min(0.99, Math.round(roundedPrice * 100) / 100));
            // Calculate shares
            let shares = params.sizeShares || (params.side === 'BUY'
                ? Math.ceil(params.sizeUsd / finalPrice)
                : Math.floor(params.sizeUsd / finalPrice));
            // Ensure minimum $1 order for buys
            if (params.side === 'BUY' && (shares * finalPrice) < 1.00) {
                shares = Math.ceil(1.00 / finalPrice);
            }
            // FIX: Round shares to integer (no decimals for taker amount)
            shares = Math.floor(shares);
            if (shares < minOrderSize) {
                return { success: false, error: "BELOW_MIN_SIZE", sharesFilled: 0, priceFilled: 0 };
            }
            // FIX: Ensure size is an integer
            const signedOrder = await this.client.createOrder({
                tokenID: params.tokenId,
                price: finalPrice,
                side: side,
                size: shares, // Must be integer
                feeRateBps: 0,
                taker: "0x0000000000000000000000000000000000000000"
            });
            // Order type selection
            let orderType = OrderType.FOK;
            if (params.orderType === 'GTC') {
                orderType = OrderType.GTC;
            }
            else if (side === Side.SELL) {
                orderType = OrderType.FAK;
            }
            const res = await this.client.postOrder(signedOrder, orderType);
            if (res && res.success) {
                let actualFilledShares = 0;
                let actualUsdMoved = 0;
                if (params.side === 'BUY') {
                    actualFilledShares = parseFloat(res.takingAmount || '0');
                    actualUsdMoved = parseFloat(res.makingAmount || '0') / 1e6;
                }
                else {
                    actualUsdMoved = parseFloat(res.takingAmount || '0') / 1e6;
                    actualFilledShares = parseFloat(res.makingAmount || '0');
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
            throw new Error(res.errorMsg || "Order execution rejected by relayer");
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
    async cancelAllOrders() {
        await this.client?.cancelAll();
        return true;
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
    async mergePositions(conditionId, amount) {
        if (!this.safeManager)
            throw new Error("No Safe");
        const amountWei = ethers.parseUnits(amount.toString(), 6);
        const ctfInterface = new Interface(["function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount)"]);
        const data = ctfInterface.encodeFunctionData("mergePositions", [
            TOKENS.USDC_BRIDGED,
            ethers.ZeroHash,
            conditionId,
            [1, 2],
            amountWei
        ]);
        return await this.safeManager.executeTransaction({
            to: CTF_ADDRESS,
            data,
            value: "0"
        });
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
    async ensureOutcomeTokenApproval(isNegRisk) {
        if (!this.safeManager || !this.safeAddress)
            throw new Error("Safe Manager not initialized");
        const EXCHANGE = isNegRisk ? "0xC5d563A36AE78145C45a50134d48A1215220f80a" : "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        const isApproved = await this.safeManager.checkOutcomeTokenApproval(this.safeAddress, EXCHANGE);
        if (!isApproved) {
            await this.safeManager.approveOutcomeTokens(EXCHANGE, isNegRisk);
            await new Promise(r => setTimeout(r, 5000));
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
    async redeemPosition(conditionId, tokenId) {
        if (!this.safeManager || !this.safeAddress)
            throw new Error('Safe manager not initialized');
        const USDC_ADDRESS = TOKENS.USDC_BRIDGED;
        try {
            const balanceBefore = await this.fetchBalance(this.safeAddress);
            const indexSets = [1n, 2n];
            const redeemTx = {
                to: CTF_ADDRESS,
                data: this.encodeRedeemPositions(USDC_ADDRESS, ethers.ZeroHash, conditionId, indexSets),
                value: "0"
            };
            const txHash = await this.safeManager.executeTransaction(redeemTx);
            await new Promise(r => setTimeout(r, 5000));
            const balanceAfter = await this.fetchBalance(this.safeAddress);
            return {
                success: true,
                amountUsd: balanceAfter - balanceBefore,
                txHash
            };
        }
        catch (e) {
            return { success: false, error: e.message || 'Redemption failed' };
        }
    }
    encodeRedeemPositions(collateralToken, parentCollectionId, conditionId, indexSets) {
        const iface = new Interface(["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets)"]);
        return iface.encodeFunctionData("redeemPositions", [collateralToken, parentCollectionId, conditionId, indexSets]);
    }
}
