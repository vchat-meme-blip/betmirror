
// ... imports ...
import { 
    IExchangeAdapter, 
    OrderParams,
    OrderResult
} from '../interfaces.js';
import { OrderBook, PositionData } from '../../domain/market.types.js';
import { TradeSignal, TradeHistoryEntry } from '../../domain/trade.types.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { Wallet as WalletV6, JsonRpcProvider, Contract, formatUnits } from 'ethers';
import { Wallet as WalletV5 } from 'ethers-v5'; 
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { SafeManagerService } from '../../services/safe-manager.service.js';
import { TradingWalletConfig } from '../../domain/wallet.types.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { Logger } from '../../utils/logger.util.js';
import { TOKENS } from '../../config/env.js';
import axios from 'axios';
import crypto from 'crypto';

const HOST_URL = 'https://clob.polymarket.com';
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

// Standard User Agent to prevent Cloudflare 403s
const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
};

enum SignatureType {
    EOA = 0,
    POLY_PROXY = 1,
    POLY_GNOSIS_SAFE = 2
}

interface PolyTradeResponse {
    id: string;
    timestamp: number;
    market: string;
    asset: string;
    side: string;
    size: number;
    price: number;
    fee: number;
    orderId: string;
    takerOrder: string;
    makerOrder: string;
    matchId: string;
    owner: string;
    status: string;
    transactionHash: string;
    outcome: string; 
    outcomeIndex?: number;
}

// Data API Response Structure
interface PolyPositionResponse {
    asset: string;
    title: string;
    size: number;
    currentPrice: number;
    market: string; 
    conditionId: string; // Add alternate field
    outcome: string;
    outcomeIndex: number;
    initialValue: number;
    currentValue: number;
    percentChange: number;
}

export class PolymarketAdapter implements IExchangeAdapter {
    readonly exchangeName = 'Polymarket';
    
    private client?: ClobClient;
    private wallet?: WalletV6; 
    private walletV5?: WalletV5; 
    private walletService?: EvmWalletService;
    private safeManager?: SafeManagerService;
    private usdcContract?: Contract;
    private provider?: JsonRpcProvider;
    private safeAddress?: string;

    constructor(
        private config: {
            rpcUrl: string;
            walletConfig: TradingWalletConfig;
            userId: string;
            l2ApiCredentials?: any;
            builderApiKey?: string;
            builderApiSecret?: string;
            builderApiPassphrase?: string;
            mongoEncryptionKey: string;
        },
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

        let safeAddressToUse = this.config.walletConfig.safeAddress;
        
        if (!safeAddressToUse) {
            this.logger.warn(`   ⚠️ Safe address missing in config. Computing...`);
            safeAddressToUse = await SafeManagerService.computeAddress(this.config.walletConfig.address);
        }

        if (!safeAddressToUse) {
             throw new Error("Failed to resolve Safe Address.");
        }

        this.safeManager = new SafeManagerService(
            this.wallet,
            this.config.builderApiKey,
            this.config.builderApiSecret,
            this.config.builderApiPassphrase,
            this.logger,
            safeAddressToUse 
        );

        this.safeAddress = this.safeManager.getSafeAddress();
        this.logger.info(`   Smart Bot Address: ${this.safeAddress}`);

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
            this.logger.info('🤝 Deriving L2 API Keys...');
            await this.deriveAndSaveKeys();
            apiCreds = this.config.l2ApiCredentials; 
        } else {
             this.logger.info('🔌 Using existing CLOB Credentials');
        }

        this.initClobClient(apiCreds);
    }

    public isReady(): boolean {
        return !!this.client;
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
                { "tradingWallet.l2ApiCredentials": apiCreds }
            );
            this.config.l2ApiCredentials = apiCreds;
            this.logger.success('✅ API Keys Derived & Saved');
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
            const url = `https://data-api.polymarket.com/value?user=${address}`;
            const res = await axios.get(url, { headers: HTTP_HEADERS });
            return parseFloat(res.data) || 0;
        } catch (e) {
            this.logger.debug(`Portfolio Value fetch failed: ${(e as Error).message}`);
            return 0;
        }
    }

    async getMarketPrice(marketId: string, tokenId: string): Promise<number> {
        if (!this.client || !tokenId) return 0;
        try {
            const mid = await this.client.getMidpoint(tokenId);
            return parseFloat(mid.mid);
        } catch (e) { return 0; }
    }
    
    // --- UPDATED: POSITION FETCHING WITH RICH DATA ENRICHMENT ---
    async getPositions(address: string): Promise<PositionData[]> {
        this.logger.debug(`Fetching positions for ${address}...`);

        let apiPositions: PolyPositionResponse[] = [];
        try {
            const url = `https://data-api.polymarket.com/positions?user=${address}`;
            const res = await axios.get<PolyPositionResponse[]>(url, { headers: HTTP_HEADERS });
            
            if (Array.isArray(res.data)) {
                // Filter dust
                apiPositions = res.data.filter(p => p.size > 0.001);
            }
        } catch (e: any) {
            this.logger.warn(`Data API Position fetch failed: ${e.message}.`);
            return [];
        }

        // ENRICHMENT LOOP
        // Use Promise.all to fetch metadata in parallel
        const enrichmentPromises = apiPositions.map(async (p) => {
            try {
                // FIX: Support both 'market' and 'conditionId' fields from API
                const marketId = p.market || p.conditionId;
                
                let marketData: any = null;
                let currentPrice = Number(p.currentPrice); 

                // Only call CLOB if we have a valid market ID and client
                if (this.client && marketId && marketId !== 'undefined') {
                    // A. Fetch Market Metadata (Question, Image, Slug)
                    try {
                        marketData = await this.client.getMarket(marketId);
                    } catch (err) {
                        // Suppress 404s for old markets
                    }
                }

                // B. Fetch Real-Time CLOB Price if asset ID exists
                if (this.client && p.asset) {
                    try {
                        const mid = await this.client.getMidpoint(p.asset);
                        if (mid && mid.mid) {
                            currentPrice = parseFloat(mid.mid);
                        }
                    } catch (err) {}
                }

                const size = Number(p.size);
                
                return {
                    marketId: marketId || "UNKNOWN",
                    tokenId: p.asset,
                    outcome: p.outcome || 'UNK',
                    balance: size,
                    valueUsd: size * currentPrice,
                    entryPrice: Number(p.initialValue) / size, // Approx avg entry
                    currentPrice: currentPrice,
                    // Rich Fields
                    question: marketData?.question || p.title || "Unknown Market",
                    image: marketData?.image || marketData?.icon || "",
                    endDate: marketData?.end_date_iso,
                    marketSlug: marketData?.market_slug // Added Slug
                } as PositionData;

            } catch (e) {
                // If one fails, don't break the whole list
                return null;
            }
        });

        const results = await Promise.all(enrichmentPromises);
        const validPositions = results.filter((p): p is PositionData => p !== null);

        this.logger.info(`✅ Synced ${validPositions.length} positions (Enriched)`);
        return validPositions;
    }

    async getOrderBook(tokenId: string): Promise<OrderBook> {
        if (!this.client) throw new Error("Not auth");
        try {
            const book = await this.client.getOrderBook(tokenId);
            return {
                bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
                asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
            };
        } catch (e: any) {
            if (e.message && e.message.includes('404')) {
                throw new Error("Orderbook not found (Market might be closed)");
            }
            throw e;
        }
    }

    async fetchPublicTrades(address: string, limit: number = 20): Promise<TradeSignal[]> {
        try {
            const url = `https://data-api.polymarket.com/trades?user=${address}&limit=${limit}`;
            const res = await axios.get<PolyTradeResponse[]>(url, { headers: HTTP_HEADERS });
            if (!res.data || !Array.isArray(res.data)) return [];

            const signals: TradeSignal[] = [];
            for (const t of res.data) {
                let outcome: 'YES' | 'NO' | undefined;
                if (t.outcome === 'YES' || t.outcome === 'NO') outcome = t.outcome;
                else if (t.outcomeIndex === 0) outcome = 'YES';
                else if (t.outcomeIndex === 1) outcome = 'NO';
                
                if (outcome) {
                    signals.push({
                        trader: address,
                        marketId: t.market,
                        tokenId: t.asset,
                        outcome: outcome,
                        side: t.side.toUpperCase() as 'BUY' | 'SELL',
                        sizeUsd: t.size * t.price, 
                        price: t.price,
                        timestamp: t.timestamp * 1000 
                    });
                }
            }
            return signals;
        } catch (e) { return []; }
    }
    
    async getTradeHistory(address: string, limit: number = 50): Promise<TradeHistoryEntry[]> {
        if (this.client) {
            try {
                this.logger.debug(`Fetching CLOB trade history for ${address}`);
                const trades = await this.client.getTrades({
                    maker_address: address,
                    limit: limit.toString() as any 
                } as any);

                if (Array.isArray(trades)) {
                    return trades.map((t: any) => ({
                        id: t.id,
                        timestamp: t.match_time ? new Date(Number(t.match_time) * 1000).toISOString() : new Date().toISOString(),
                        marketId: t.market,
                        outcome: t.outcome || (t.outcomeIndex === 0 ? 'YES' : 'NO'),
                        side: t.side ? t.side.toUpperCase() : 'UNK',
                        size: parseFloat(t.size) * parseFloat(t.price),
                        executedSize: parseFloat(t.size) * parseFloat(t.price),
                        price: parseFloat(t.price),
                        status: 'FILLED',
                        txHash: t.transaction_hash,
                        clobOrderId: t.maker_order_id || t.taker_order_id 
                    }));
                }
            } catch (e) {
                this.logger.warn(`CLOB History fetch failed (fallback to public API): ${(e as Error).message}`);
            }
        }

        return this.fetchPublicTrades(address, limit).then(signals => 
            signals.map(s => ({
                id: crypto.randomUUID(),
                timestamp: new Date(s.timestamp).toISOString(),
                marketId: s.marketId,
                outcome: s.outcome,
                side: s.side,
                size: s.sizeUsd,
                price: s.price,
                status: 'FILLED'
            }))
        );
    }

    async createOrder(params: OrderParams, retryCount = 0): Promise<OrderResult> {
        if (!this.client) return { success: false, error: "Client not authenticated", sharesFilled: 0, priceFilled: 0 };

        try {
            const marketPromise = this.client.getMarket(params.marketId);
            const bookPromise = this.client.getOrderBook(params.tokenId);

            const [market, book] = await Promise.all([
                marketPromise.catch(e => null), 
                bookPromise.catch(e => null)
            ]);

            if (!market) throw new Error("Market data not available");
            if (!book) throw new Error("Orderbook not available (Liquidity check failed)");

            const negRisk = market.neg_risk;
            let minOrderSize = 5; 
            let tickSize = 0.01;

            if (book.tick_size) {
                tickSize = Number(book.tick_size);
            } else if (market.minimum_tick_size) {
                tickSize = Number(market.minimum_tick_size);
            }

            if (market.minimum_order_size) minOrderSize = Number(market.minimum_order_size);

            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            
            let rawPrice = params.priceLimit;

            if (rawPrice === undefined) {
                 if (side === Side.BUY) {
                     if (!book.asks || book.asks.length === 0) return { success: false, error: "skipped_no_liquidity", sharesFilled: 0, priceFilled: 0 };
                     rawPrice = Number(book.asks[0].price); 
                 } else {
                     if (!book.bids || book.bids.length === 0) return { success: false, error: "skipped_no_liquidity", sharesFilled: 0, priceFilled: 0 };
                     rawPrice = Number(book.bids[0].price); 
                 }
            }

            // Price clamp safety
            if (rawPrice >= 0.99) rawPrice = 0.99;
            if (rawPrice <= 0.01) rawPrice = 0.01;

            // Tick alignment
            const inverseTick = Math.round(1 / tickSize);
            const roundedPrice = Math.floor(rawPrice * inverseTick) / inverseTick;
            
            let shares = params.sizeShares || 0;
            
            if (!shares && params.sizeUsd > 0) {
                 const rawShares = params.sizeUsd / roundedPrice;
                 shares = Math.ceil(rawShares);
            }

            // MINIMUM SHARE CHECK (5 Shares)
            if (shares < minOrderSize) {
                this.logger.warn(`⚠️ Order Rejected: Size (${shares}) < Minimum (${minOrderSize} shares). Req: $${params.sizeUsd.toFixed(2)} @ ${roundedPrice}`);
                return { success: false, error: "skipped_min_size_limit", sharesFilled: 0, priceFilled: 0 }; 
            }
            
            // MINIMUM USD AMOUNT CHECK ($1.00 USD hard requirement from CLOB error)
            const usdValue = shares * roundedPrice;
            if (usdValue < 1.00) {
                this.logger.warn(`⚠️ Order Rejected: Value ($${usdValue.toFixed(2)}) < $1.00 Minimum. Req: ${shares} shares @ ${roundedPrice}`);
                return { success: false, error: "skipped_min_usd_limit", sharesFilled: 0, priceFilled: 0 };
            }

            const order: any = {
                tokenID: params.tokenId,
                price: roundedPrice,
                side: side,
                size: shares,
                feeRateBps: 0,
                taker: "0x0000000000000000000000000000000000000000" 
            };

            this.logger.info(`📝 Placing Order (Safe): ${params.side} ${shares} shares @ $${roundedPrice} (Tick: ${tickSize})`);

            const res = await this.client.createAndPostOrder(
                order, 
                { 
                    negRisk,
                    tickSize: tickSize as any 
                }, 
                OrderType.FOK as any
            );

            if (res && res.success) {
                this.logger.success(`✅ Order Accepted. Tx: ${res.transactionHash || res.orderID || 'OK'}`);
                return { 
                    success: true, 
                    orderId: res.orderID, 
                    txHash: res.transactionHash, 
                    sharesFilled: shares,
                    priceFilled: roundedPrice
                };
            }
            
            throw new Error(res.errorMsg || "Order failed response");

        } catch (error: any) {
            const errStr = String(error);

            if (retryCount < 1 && (errStr.includes("401") || errStr.includes("403") || errStr.includes("invalid signature"))) {
                this.logger.warn("⚠️ Auth Error. Refreshing keys and retrying...");
                this.config.l2ApiCredentials = undefined; 
                await this.deriveAndSaveKeys();
                this.initClobClient(this.config.l2ApiCredentials);
                return this.createOrder(params, retryCount + 1);
            }
            
            if (error.response?.data) {
                this.logger.error(`[CLOB Client] request error ${JSON.stringify(error.response)}`);
            }

            const errorMsg = error.response?.data?.error || error.message;
            
            if (errorMsg?.includes("allowance")) {
                this.logger.error("❌ Failed: Insufficient Allowance. Retrying approvals...");
                await this.safeManager?.enableApprovals();
            } else if (errorMsg?.includes("balance")) {
                this.logger.error("❌ Failed: Insufficient USDC Balance.");
                return { success: false, error: "insufficient_funds", sharesFilled: 0, priceFilled: 0 };
            } else if (errorMsg?.includes("minimum") || errorMsg?.includes("invalid amount")) {
                 this.logger.error(`❌ Failed: Below Min Size (CLOB Rejection).`);
                 return { success: false, error: "skipped_min_size_limit", sharesFilled: 0, priceFilled: 0 };
            } else {
                this.logger.error(`Order Error: ${errorMsg}`);
            }
            return { success: false, error: "failed", sharesFilled: 0, priceFilled: 0 };
        }
    }

    async cancelOrder(orderId: string): Promise<boolean> {
        if (!this.client) return false;
        try {
            await this.client.cancelOrder({ orderID: orderId });
            return true;
        } catch (e) { return false; }
    }

    async cashout(amount: number, destination: string): Promise<string> {
        if (!this.safeManager) throw new Error("Safe Manager not initialized");
        const amountStr = Math.floor(amount * 1000000).toString();
        return await this.safeManager.withdrawUSDC(destination, amountStr);
    }
    
    getFunderAddress() {
        return this.safeAddress || this.config.walletConfig.address;
    }
}
