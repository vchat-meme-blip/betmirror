import { 
    IExchangeAdapter, 
    OrderParams,
    OrderResult,
    LiquidityHealth,
    LiquidityMetrics,
    OrderSide
} from '../interfaces.js';
import { OrderBook, PositionData } from '../../domain/market.types.js';
import { TradeSignal, TradeHistoryEntry } from '../../domain/trade.types.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { Wallet as WalletV6, JsonRpcProvider, Contract, formatUnits } from 'ethers';
import { Wallet as WalletV5 } from 'ethers-v5'; // V5 for SDK
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { SafeManagerService } from '../../services/safe-manager.service.js';
import { TradingWalletConfig, L2ApiCredentials } from '../../domain/wallet.types.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { Logger } from '../../utils/logger.util.js';
import { TOKENS } from '../../config/env.js';
import axios from 'axios';

const HOST_URL = 'https://clob.polymarket.com';
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)', 'function allowance(address owner, address spender) view returns (uint256)'];

enum SignatureType {
    EOA = 0,
    POLY_PROXY = 1,
    POLY_GNOSIS_SAFE = 2
}

interface PolyActivityResponse {
  type: string;
  timestamp: number;
  conditionId: string;
  asset: string;
  size: number;
  usdcSize: number;
  price: number;
  side: string;
  outcomeIndex: number;
  transactionHash: string;
}

export interface PolymarketAdapterConfig {
    rpcUrl: string;
    walletConfig: TradingWalletConfig;
    userId: string;
    l2ApiCredentials?: L2ApiCredentials;
    builderApiKey?: string;
    builderApiSecret?: string;
    builderApiPassphrase?: string;
    mongoEncryptionKey: string;
}

export class PolymarketAdapter implements IExchangeAdapter {
    readonly exchangeName = 'Polymarket';
    
    private client?: ClobClient;
    private wallet?: WalletV6; 
    private walletV5?: WalletV5; // Dedicated V5 wallet for SDK
    private walletService?: EvmWalletService;
    private safeManager?: SafeManagerService;
    private usdcContract?: Contract;
    private provider?: JsonRpcProvider;
    private safeAddress?: string;

    private marketMetadataCache: Map<string, any> = new Map();

    constructor(
        private config: PolymarketAdapterConfig,
        private logger: Logger
    ) {}

    async initialize(): Promise<void> {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter...`);
        
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        
        if (this.config.walletConfig.encryptedPrivateKey) {
             this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
             this.walletV5 = await this.walletService.getWalletInstanceV5(this.config.walletConfig.encryptedPrivateKey);
        } else {
             throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }

        const sdkAlignedAddress = await SafeManagerService.computeAddress(this.config.walletConfig.address);
        this.safeAddress = sdkAlignedAddress;

        this.safeManager = new SafeManagerService(
            this.wallet,
            this.config.builderApiKey,
            this.config.builderApiSecret,
            this.config.builderApiPassphrase,
            this.logger,
            this.safeAddress 
        );

        this.provider = new JsonRpcProvider(this.config.rpcUrl);
        this.usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI, this.provider);
    }

    async validatePermissions(): Promise<boolean> {
        return true;
    }

    async authenticate(): Promise<void> {
        if (!this.wallet || !this.safeManager || !this.safeAddress) throw new Error("Adapter not initialized");

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

    private initClobClient(apiCreds: any) {
        let builderConfig: BuilderConfig | undefined;
        if (this.config.builderApiKey && this.config.builderApiSecret && this.config.builderApiPassphrase) {
            builderConfig = new BuilderConfig({ 
                localBuilderCreds: {
                    key: this.config.builderApiKey,
                    secret: this.config.builderApiSecret,
                    passphrase: this.config.builderApiPassphrase
                }
            });
        }

        this.client = new ClobClient(
            HOST_URL,
            Chain.POLYGON,
            this.walletV5 as any, 
            apiCreds,
            SignatureType.POLY_GNOSIS_SAFE,
            this.safeAddress,
            undefined, 
            undefined,
            builderConfig
        );
    }

    private async deriveAndSaveKeys() {
        try {
            const tempClient = new ClobClient(
                HOST_URL,
                Chain.POLYGON,
                this.walletV5 as any, 
                undefined,
                SignatureType.EOA,
                undefined
            );

            const rawCreds = await tempClient.createOrDeriveApiKey();
            if (!rawCreds || !rawCreds.key) throw new Error("Empty keys returned");

            const apiCreds = {
                key: rawCreds.key,
                secret: rawCreds.secret,
                passphrase: rawCreds.passphrase
            };

            await User.findOneAndUpdate(
                { address: this.config.userId },
                { 
                    "tradingWallet.l2ApiCredentials": apiCreds,
                    "tradingWallet.safeAddress": this.safeAddress 
                }
            );
            this.config.l2ApiCredentials = apiCreds;
            this.logger.success('API Keys Derived and Saved');
        } catch (e: any) {
            this.logger.error(`Handshake Failed: ${e.message}`);
            throw e;
        }
    }

    async fetchBalance(address: string): Promise<number> {
        if(!this.usdcContract) return 0;
        try {
            const bal = await this.usdcContract.balanceOf(address);
            return parseFloat(formatUnits(bal, 6));
        } catch (e) { return 0; }
    }

    async getPortfolioValue(address: string): Promise<number> {
        try {
            const res = await axios.get(`https://data-api.polymarket.com/value?user=${address}`);
            return parseFloat(res.data) || 0;
        } catch (e) { return 0; }
    }

    async getMarketPrice(marketId: string, tokenId: string, side: 'BUY' | 'SELL' = 'BUY'): Promise<number> {
        if (!this.client) return 0;
        try {
            const priceRes = await this.client.getPrice(tokenId, side as any);
            return parseFloat(priceRes.price) || 0;
        } catch (e) {
            try {
                const mid = await this.client.getMidpoint(tokenId);
                return parseFloat(mid.mid) || 0;
            } catch (midErr) {
                return 0;
            }
        }
    }

    async getOrderBook(tokenId: string): Promise<OrderBook> {
        if (!this.client) throw new Error("Not auth");
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
            min_order_size: Number((book as any).min_order_size) || 5,
            tick_size: Number((book as any).tick_size) || 0.01,
            neg_risk: (book as any).neg_risk
        };
    }

    /**
     * UPDATED LIQUIDITY MATH:
     * We now use absolute cent spreads instead of percentages.
     * This is critical for prediction markets where 1c vs 2c is a tiny gap but a huge %.
     */
    async getLiquidityMetrics(tokenId: string, side: 'BUY' | 'SELL'): Promise<LiquidityMetrics> {
        if (!this.client) throw new Error("Not auth");
        const book = await this.client.getOrderBook(tokenId);
        
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
        } else {
            // How much USD of shares is available for us to buy?
            depthUsd = sortedAsks.slice(0, 3).reduce((sum, a) => sum + (a.size * a.price), 0);
        }

        // Health based on ABSOLUTE spread (cents) + USD depth
        // For prediction markets: depth matters MORE than spread at extreme prices
        let health: LiquidityHealth = LiquidityHealth.CRITICAL;
        
        if (spreadAbs <= 0.02 && depthUsd >= 500) {
            health = LiquidityHealth.HIGH;      // Tight spread, deep book
        } else if (spreadAbs <= 0.05 && depthUsd >= 100) {
            health = LiquidityHealth.MEDIUM;    // Moderate spread, decent depth
        } else if (depthUsd >= 20) {
            health = LiquidityHealth.LOW;       // Depth exists - tradeable but risky
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

    private async fetchMarketSlugs(marketId: string): Promise<{ marketSlug: string; eventSlug: string; question: string; image: string }> {
        let marketSlug = "";
        let eventSlug = "";
        let question = marketId;
        let image = "";

        if (this.client && marketId) {
            try {
                this.marketMetadataCache.delete(marketId);
                const marketData = await this.client.getMarket(marketId);
                this.marketMetadataCache.set(marketId, marketData);

                if (marketData) {
                    marketSlug = marketData.market_slug || "";
                    question = marketData.question || question;
                    image = marketData.image || image;
                }
            } catch (e) {}
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
            } catch (e) {}
        }

        return { marketSlug, eventSlug, question, image };
    }

    async getPositions(address: string): Promise<PositionData[]> {
        try {
            const url = `https://data-api.polymarket.com/positions?user=${address}`;
            const res = await axios.get(url);
            if(!Array.isArray(res.data)) return [];
            
            const positions: PositionData[] = [];
            for (const p of res.data) {
                const size = parseFloat(p.size) || 0;
                if (size <= 0.01) continue;
                const marketId = p.conditionId || p.market;
                const tokenId = p.asset;
                let currentPrice = parseFloat(p.price) || 0;
                if (currentPrice === 0 && this.client && tokenId) {
                    try {
                        const mid = await this.client.getMidpoint(tokenId);
                        currentPrice = parseFloat(mid.mid) || 0;
                    } catch (e) {
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
        } catch (e) {
            return [];
        }
    }

    async fetchPublicTrades(address: string, limit: number = 20): Promise<TradeSignal[]> {
        try {
            const url = `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`;
            const res = await axios.get<PolyActivityResponse[]>(url);
            if (!res.data || !Array.isArray(res.data)) return [];
            return res.data
                .filter(act => act.type === 'TRADE' || act.type === 'ORDER_FILLED')
                .map(act => ({
                    trader: address,
                    marketId: act.conditionId,
                    tokenId: act.asset,
                    outcome: act.outcomeIndex === 0 ? 'YES' : 'NO',
                    side: act.side.toUpperCase() as 'BUY' | 'SELL',
                    sizeUsd: act.usdcSize || (act.size * act.price),
                    price: act.price,
                    timestamp: (act.timestamp > 1e11 ? act.timestamp : act.timestamp * 1000)
                }));
        } catch (e) { return []; }
    }

    async getTradeHistory(address: string, limit: number = 50): Promise<TradeHistoryEntry[]> {
        return []; 
    }

    async createOrder(params: OrderParams, retryCount = 0): Promise<OrderResult> {
        if (!this.client) throw new Error("Client not authenticated");

        try {
            const market = await this.client.getMarket(params.marketId);
            const tickSize = Number(market.minimum_tick_size) || 0.01;
            const minOrderSize = Number(market.minimum_order_size) || 5;

            // JIT PROTECTION: Ensure rights and allowances just before trade
            if (params.side === 'BUY') {
                await this.ensureUsdcAllowance(market.neg_risk, params.sizeUsd);
            } else {
                await this.ensureOutcomeTokenApproval(market.neg_risk);
            }

            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            const book = await this.getOrderBook(params.tokenId);
            
            const topBids = book.bids.slice(0, 3).map(b => `${b.price} (${b.size})`).join(', ');
            const topAsks = book.asks.slice(0, 3).map(a => `${a.price} (${a.size})`).join(', ');
            this.logger.info(`Book [${params.tokenId}]: Bids: [${topBids || 'none'}] | Asks: [${topAsks || 'none'}]`);

            let rawPrice: number;
            if (side === Side.SELL) {
                if (!book.bids.length) return { success: false, error: "skipped_no_bids", sharesFilled: 0, priceFilled: 0 };
                rawPrice = params.priceLimit !== undefined ? params.priceLimit : book.bids[0].price; 
            } else {
                if (!book.asks.length) return { success: false, error: "skipped_no_liquidity", sharesFilled: 0, priceFilled: 0 };
                rawPrice = params.priceLimit !== undefined ? params.priceLimit : book.asks[0].price;
            }

            const inverseTick = Math.round(1 / tickSize);
            const roundedPrice = side === Side.BUY 
                ? Math.ceil(rawPrice * inverseTick) / inverseTick
                : Math.floor(rawPrice * inverseTick) / inverseTick;
            const finalPrice = Math.max(0.001, Math.min(0.999, roundedPrice));

            // DIRECTIONAL MATH: 
            // BUY orders use ceil to hit floor. SELL orders use floor to avoid overselling.
            let shares = params.sizeShares || (
                params.side === 'BUY' 
                    ? Math.ceil(params.sizeUsd / finalPrice) 
                    : Math.floor(params.sizeUsd / finalPrice)
            );
            
            // DUST PROTECTION: 
            // 1. Exchange floor for total order value is $1.00
            if (params.side === 'BUY' && (shares * finalPrice) < 1.00) {
                shares = Math.ceil(1.00 / finalPrice);
                this.logger.info(`   + Dust Protection: Boosting shares to ${shares} to meet $1.00 floor`);
            }

            // 2. Exchange floor for share count is usually 5 shares
            if (params.side === 'BUY' && shares < minOrderSize) {
                shares = minOrderSize;
                this.logger.info(`   + Dust Protection: Boosting shares to ${shares} to meet 5-share minimum`);
            }

            if (shares < minOrderSize) {
                const errorMsg = `EXCHANGE_LIMIT: Size (${shares.toFixed(2)} shares) is below exchange minimum of ${minOrderSize}.`;
                return { success: false, error: errorMsg, sharesFilled: 0, priceFilled: 0 };
            }

            this.logger.info(`Placing Order: ${params.side} ${shares} shares @ ${finalPrice.toFixed(3)} (Limit)`);

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
                return { 
                    success: true, 
                    orderId: res.orderID, 
                    txHash: res.transactionHash, 
                    sharesFilled: shares, 
                    priceFilled: finalPrice 
                };
            }
            throw new Error(res.errorMsg || "Order failed response");

        } catch (error: any) {
            if (retryCount < 1 && (String(error).includes("401") || String(error).includes("signature"))) {
                await this.deriveAndSaveKeys();
                this.initClobClient(this.config.l2ApiCredentials);
                return this.createOrder(params, retryCount + 1);
            }
            
            // Improve error messaging for balance vs allowance issues
            let errorMessage = error.message || "Unknown Error";
            if (errorMessage.includes("not enough balance / allowance")) {
                // Check if it's specifically an allowance issue by checking current allowance
                try {
                    const market = await this.client.getMarket(params.marketId);
                    const allowance = await this.checkUsdcAllowance(market.neg_risk);
                    const balance = await this.fetchBalance(this.safeAddress!);
                    
                    if (allowance < (params.sizeUsd || 0)) {
                        errorMessage = `INSUFFICIENT_ALLOWANCE (allowance: $${allowance.toFixed(2)}, needed: $${params.sizeUsd?.toFixed(2) || '0'}) - Please approve allowance`;
                    } else {
                        errorMessage = `INSUFFICIENT_BALANCE (balance: $${balance.toFixed(2)}, needed: $${params.sizeUsd?.toFixed(2) || '0'})`;
                    }
                } catch (e) {
                    errorMessage = "BALANCE_OR_ALLOWANCE_ISSUE - Check wallet balance and token allowance";
                }
            }
            
            return { success: false, error: errorMessage, sharesFilled: 0, priceFilled: 0 };
        }
    }

    async cancelOrder(orderId: string): Promise<boolean> {
        if (!this.client) return false;
        try {
            await this.client.cancelOrder({ orderID: orderId });
            return true;
        } catch (e) { return false; }
    }

    async getOpenOrders(): Promise<any[]> {
        if (!this.client) return [];
        try {
            const orders = await this.client.getOpenOrders();
            return orders || [];
        } catch (e) { return []; }
    }

    async cashout(amount: number, destination: string): Promise<string> {
        if (!this.safeManager) throw new Error("Safe Manager not initialized");
        const amountStr = Math.floor(amount * 1000000).toString();
        return await this.safeManager.withdrawUSDC(destination, amountStr);
    }

        async ensureUsdcAllowance(isNegRisk: boolean, tradeAmountUsd: number = 0): Promise<void> {
        if (!this.safeManager) throw new Error("Safe Manager not initialized");
        const EXCHANGE = isNegRisk ? "0xC5d563A36AE78145C45a50134d48A1215220f80a" : "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        
        const allowance = await this.usdcContract!.allowance(this.safeAddress, EXCHANGE);
        
        // Check if current allowance covers this specific trade (plus a tiny buffer)
        const requiredAmountRaw = BigInt(Math.ceil((tradeAmountUsd + 1) * 1000000));
        
        if (allowance < requiredAmountRaw) { 
            this.logger.info(`   + JIT: Granting USDC allowance ($${tradeAmountUsd} trade)...`);
            await this.safeManager.enableApprovals();
            // FIX: Add Indexing Delay - CLOB indexer takes a few seconds to see on-chain allowance changes
            this.logger.info(`   + Waiting for CLOB indexing grace period (5s)...`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    async checkUsdcAllowance(isNegRisk: boolean = false): Promise<number> {
        if (!this.safeManager) throw new Error("Safe Manager not initialized");
        const EXCHANGE = isNegRisk ? "0xC5d563A36AE78145C45a50134d48A1215220f80a" : "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        
        const allowance = await this.usdcContract!.allowance(this.safeAddress, EXCHANGE);
        return Number(allowance) / 1000000; // Convert from wei to USDC
    }

    async ensureOutcomeTokenApproval(isNegRisk: boolean): Promise<void> {
        if (!this.safeManager) throw new Error("Safe Manager not initialized");
        const EXCHANGE = isNegRisk 
            ? "0xC5d563A36AE78145C45a50134d48A1215220f80a"
            : "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        try {
            const safeAddr = this.safeAddress;
            if (!safeAddr) return;
            const isApproved = await this.safeManager.checkOutcomeTokenApproval(safeAddr, EXCHANGE);
            if (!isApproved) {
                this.logger.info(`   + Granting outcome token rights to ${isNegRisk ? 'NegRisk' : 'Standard'} Exchange...`);
                await this.safeManager.approveOutcomeTokens(EXCHANGE, isNegRisk);
                // Indexing Grace Period
                await new Promise(r => setTimeout(r, 5000));
            }
        } catch (e: any) {
            throw e;
        }
    }
    
    getFunderAddress() {
        return this.safeAddress || this.config.walletConfig.address;
    }

    getRawClient(): any {
        return this.client;
    }

    getSigner(): any {
        return this.wallet;
    }
}