
import { 
    IExchangeAdapter, 
    OrderParams,
    OrderResult
} from '../interfaces.js';
import { OrderBook, PositionData } from '../../domain/market.types.js';
import { TradeSignal, TradeHistoryEntry } from '../../domain/trade.types.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { Wallet as WalletV6, JsonRpcProvider, Contract, formatUnits } from 'ethers';
import { Wallet as WalletV5 } from 'ethers-v5'; // V5 for SDK
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { SafeManagerService } from '../../services/safe-manager.service.js';
import { TradingWalletConfig } from '../../domain/wallet.types.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { Logger } from '../../utils/logger.util.js';
import { TOKENS } from '../../config/env.js';
import axios from 'axios';

const HOST_URL = 'https://clob.polymarket.com';
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

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
        this.logger.info(`[${this.exchangeName}] Initializing Adapter (Ethers v6/v5 Hybrid)...`);
        
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        
        if (this.config.walletConfig.encryptedPrivateKey) {
             // V6 for general operations
             this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
             // V5 for SDK stability
             this.walletV5 = await this.walletService.getWalletInstanceV5(this.config.walletConfig.encryptedPrivateKey);
        } else {
             throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }

        // Initialize Safe Manager
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
        } else {
             this.logger.info('🔌 Using existing CLOB Credentials');
        }

        // 4. Initialize Clob Client
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
            SignatureType.POLY_GNOSIS_SAFE, // Funder is Safe
            this.safeAddress, // Explicitly set funder (Maker)
            undefined, 
            undefined,
            builderConfig
        );
    }

    private async deriveAndSaveKeys() {
        try {
            // Keys must be derived using SignatureType.EOA because the EOA is the signer.
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
            const res = await axios.get(`https://data-api.polymarket.com/value?user=${address}`);
            return parseFloat(res.data) || 0;
        } catch (e) { return 0; }
    }

    async getMarketPrice(marketId: string, tokenId: string): Promise<number> {
        if (!this.client) return 0;
        try {
            const mid = await this.client.getMidpoint(tokenId);
            return parseFloat(mid.mid);
        } catch (e) { return 0; }
    }

    async getOrderBook(tokenId: string): Promise<OrderBook> {
        if (!this.client) throw new Error("Not auth");
        const book = await this.client.getOrderBook(tokenId);
        return {
            bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
            asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
            min_order_size: (book as any).min_order_size ? Number((book as any).min_order_size) : 5,
            tick_size: (book as any).tick_size ? Number((book as any).tick_size) : 0.01,
            neg_risk: (book as any).neg_risk
        };
    }

    async getPositions(address: string): Promise<PositionData[]> {
        try {
            const url = `https://data-api.polymarket.com/positions?user=${address}`;
            const res = await axios.get(url);
            if(!Array.isArray(res.data)) return [];
            
            const positions: PositionData[] = [];
            
            for (const p of res.data) {
                const size = parseFloat(p.size) || 0;
                if (size <= 0) continue;

                // FIX: Get real-time price from CLOB if Data API returns 0 or null
                let currentPrice = parseFloat(p.price) || 0;
                if (currentPrice === 0 && this.client && p.asset) {
                    try {
                        const mid = await this.client.getMidpoint(p.asset);
                        currentPrice = parseFloat(mid.mid) || 0;
                    } catch (e) {
                        currentPrice = parseFloat(p.avgPrice) || 0.5;
                    }
                }

                // Proper accounting logic
                const entryPrice = parseFloat(p.avgPrice) || currentPrice || 0.5;
                const currentValueUsd = size * currentPrice;
                const investedValueUsd = size * entryPrice;
                const unrealizedPnL = currentValueUsd - investedValueUsd;
                const unrealizedPnLPercent = investedValueUsd > 0 ? (unrealizedPnL / investedValueUsd) * 100 : 0;

                positions.push({
                    marketId: p.conditionId || p.market,
                    tokenId: p.asset,
                    outcome: p.outcome || 'UNK',
                    balance: size,
                    valueUsd: currentValueUsd,
                    investedValue: investedValueUsd,
                    entryPrice: entryPrice,
                    currentPrice: currentPrice,
                    unrealizedPnL: unrealizedPnL,
                    unrealizedPnLPercent: unrealizedPnLPercent,
                    question: p.title,
                    image: p.icon,
                    marketSlug: p.market_slug
                });
            }
            return positions;
        } catch(e) { return []; }
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
            let negRisk = false;
            let minOrderSize = 5; 
            let tickSize = 0.01;

            try {
                const market = await this.client.getMarket(params.marketId);
                negRisk = market.neg_risk;
                if (market.minimum_order_size) minOrderSize = Number(market.minimum_order_size);
                if (market.minimum_tick_size) tickSize = Number(market.minimum_tick_size);
            } catch (e) {
                // Fallback: Get from orderbook metadata
                try {
                    const book = await this.getOrderBook(params.tokenId);
                    if (book.min_order_size) minOrderSize = book.min_order_size;
                    if (book.tick_size) tickSize = book.tick_size;
                    if (book.neg_risk !== undefined) negRisk = book.neg_risk;
                } catch(e2) {
                    this.logger.debug(`[Order] Market info fetch fallback for ${params.marketId}`);
                }
            }

            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            let rawPrice = params.priceLimit;

            if (rawPrice === undefined || rawPrice === 0) {
                 const book = await this.client.getOrderBook(params.tokenId);
                 if (side === Side.BUY) {
                     if (!book.asks || book.asks.length === 0) throw new Error("skipped_no_liquidity");
                     rawPrice = Number(book.asks[0].price);
                 } else {
                     if (book.bids && book.bids.length > 0) {
                        rawPrice = Number(book.bids[0].price);
                     } else {
                        throw new Error("skipped_no_liquidity");
                     }
                 }
            }

            if (rawPrice >= 0.99) rawPrice = 0.99;
            if (rawPrice <= 0.01) rawPrice = 0.01;

            // DIRECTIONAL TICK ROUNDING
            const inverseTick = Math.round(1 / tickSize);
            let roundedPrice: number;
            
            if (side === Side.BUY) {
                roundedPrice = Math.ceil(rawPrice * inverseTick) / inverseTick;
            } else {
                roundedPrice = Math.floor(rawPrice * inverseTick) / inverseTick;
            }

            if (roundedPrice > 0.99) roundedPrice = 0.99;
            if (roundedPrice < 0.01) roundedPrice = 0.01;
            
            let shares = params.sizeShares || Math.floor(params.sizeUsd / roundedPrice);

            // CRITICAL FIX: Polymarket enforces a 2-decimal limit on the Maker collateral amount (USDC) for BUY orders.
            // Additionally, marketable orders (FOK) must be AT LEAST $1.00 USDC in total value.
            if (side === Side.BUY) {
                const MIN_ORDER_VALUE = 1.01; // $1.01 buffer to avoid being right on the edge
                
                // 1. Ensure total value >= $1.00
                if (shares * roundedPrice < MIN_ORDER_VALUE) {
                    shares = Math.ceil(MIN_ORDER_VALUE / roundedPrice);
                }

                // 2. Ensure the product has exactly 2 decimals of precision
                // We adjust shares up/down slightly to find a valid product if needed
                let totalCost = shares * roundedPrice;
                let attempts = 0;
                while (attempts < 10 && (Math.round(shares * roundedPrice * 100) / 100) !== (shares * roundedPrice)) {
                    shares++; // Incrementing is safer as it keeps us above the $1 floor
                    attempts++;
                }
                
                // Final safety truncate/rounding
                const finalMakerAmount = Math.floor(shares * roundedPrice * 100) / 100;
                if (finalMakerAmount < 1.00) {
                     this.logger.warn(`⚠️ Cannot meet $1.00 minimum at price $${roundedPrice}. Skipping.`);
                     return { success: false, error: "skipped_min_value_limit", sharesFilled: 0, priceFilled: 0 };
                }
            }

            if (shares < minOrderSize) {
                this.logger.warn(`⚠️ Order Rejected: Size (${shares}) < Minimum (${minOrderSize} shares). Req: $${params.sizeUsd.toFixed(2)} @ ${roundedPrice.toFixed(2)}`);
                return { success: false, error: "skipped_min_size_limit", sharesFilled: 0, priceFilled: 0 };
            }

            const order: any = {
                tokenID: params.tokenId,
                price: roundedPrice,
                side: side,
                size: shares,
                feeRateBps: 0,
                taker: "0x0000000000000000000000000000000000000000"
            };

            this.logger.info(`📝 Placing Order (Safe): ${params.side} ${shares} shares @ $${roundedPrice.toFixed(2)}`);

            const res = await this.client.createAndPostOrder(
                order, 
                { negRisk, tickSize: tickSize as any }, 
                OrderType.FOK as any
            );

            if (res && res.success) {
                this.logger.success(`✅ Order Accepted. Tx: ${res.transactionHash || res.orderID || 'OK'}`);
                return { success: true, orderId: res.orderID, txHash: res.transactionHash, sharesFilled: shares, priceFilled: roundedPrice };
            }
            throw new Error(res.errorMsg || "Order failed response");

        } catch (error: any) {
            if (retryCount < 1 && (String(error).includes("401") || String(error).includes("signature"))) {
                await this.deriveAndSaveKeys();
                this.initClobClient(this.config.l2ApiCredentials);
                return this.createOrder(params, retryCount + 1);
            }
            return { success: false, error: error.message, sharesFilled: 0, priceFilled: 0 };
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
