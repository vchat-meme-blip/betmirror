
import { OrderBook, PositionData } from '../domain/market.types.js';
import { TradeSignal, TradeHistoryEntry } from '../domain/trade.types.js';

export type OrderSide = 'BUY' | 'SELL';

export enum LiquidityHealth {
    HIGH = 'HIGH',       // Tight spread, deep book
    MEDIUM = 'MEDIUM',   // Moderate spread/depth
    LOW = 'LOW',         // Wide spread or thin book
    CRITICAL = 'CRITICAL' // No liquidity or extreme spread
}

export interface LiquidityMetrics {
    health: LiquidityHealth;
    spread: number;
    spreadPercent: number;
    availableDepthUsd: number;
    bestPrice: number;
}

/**
 * Updated for Market Making / Spread Capture
 */
export interface ArbitrageOpportunity {
    marketId: string;
    tokenId: string;
    question: string;
    bestBid: number;
    bestAsk: number;
    spread: number;
    spreadPct: number;
    spreadCents: number;
    midpoint: number;
    volume?: number;
    liquidity?: number;
    rewardsMaxSpread?: number;
    rewardsMinSize?: number;
    timestamp: number;
    // Compatibility fields for UI
    roi: number; 
    combinedCost: number;
    capacityUsd: number;
    // Risk metrics
    skew?: number;
}

export interface OrderParams {
    marketId: string;
    tokenId: string;
    outcome: string;
    side: OrderSide;
    sizeUsd: number;
    priceLimit?: number;
    // Allow specifying raw share count for sells
    sizeShares?: number;
    // Order type: GTC (Good Till Cancelled), IOC (Immediate or Cancel), FOK (Fill or Kill), FAK (Fill and Kill)
    orderType?: 'GTC' | 'IOC' | 'FOK' | 'FAK';
}

export interface OrderResult {
    success: boolean;
    orderId?: string;
    txHash?: string;
    sharesFilled: number;
    priceFilled: number;
    usdFilled?: number; // Actual USD value moved (received for sells, spent for buys)
    error?: string;
}

/**
 * Standard Interface for any Prediction Market Exchange (Polymarket, Kalshi, etc.)
 */
export interface IExchangeAdapter {
    readonly exchangeName: string;
    
    // Lifecycle
    initialize(): Promise<void>;
    
    // Auth & Setup
    validatePermissions(): Promise<boolean>;
    authenticate(): Promise<void>;
    
    // Market Data
    fetchBalance(address: string): Promise<number>;
    getPortfolioValue(address: string): Promise<number>; 
    getMarketPrice(marketId: string, tokenId: string, side?: 'BUY' | 'SELL'): Promise<number>;
    getOrderBook(tokenId: string): Promise<OrderBook>;
    getPositions(address: string): Promise<PositionData[]>; 
    
    // Redeem Winnings
    redeemPosition(marketId: string, tokenId: string): Promise<{ success: boolean; amountUsd?: number; txHash?: string; error?: string }>;

    // Liquidity Analysis
    getLiquidityMetrics?(tokenId: string, side: 'BUY' | 'SELL'): Promise<LiquidityMetrics>;

    // Inventory Management
    mergePositions(conditionId: string, amount: number): Promise<string>;

    // Monitoring
    fetchPublicTrades(address: string, limit?: number): Promise<TradeSignal[]>;
    
    // History Sync
    getTradeHistory(address: string, limit?: number): Promise<TradeHistoryEntry[]>;

    // Execution
    createOrder(params: OrderParams): Promise<OrderResult>; 
    cancelOrder(orderId: string): Promise<boolean>;
    cancelAllOrders(): Promise<boolean>;
    
    // Order Management
    cashout(amount: number, destination: string): Promise<string>;
    
    // Arbitrage Discovery
    getNegRiskMarkets?(): Promise<any[]>;

    getRawClient?(): any;
    getSigner?(): any;
    getFunderAddress?(): string | undefined; 
    
    // Order Management
    getOpenOrders?(): Promise<any[]>;
}
