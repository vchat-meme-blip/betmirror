
import { OrderBook, PositionData } from '../domain/market.types.js';
import { TradeSignal, TradeHistoryEntry } from '../domain/trade.types.js';

/**
 * Side of an order
 */
export type OrderSide = 'BUY' | 'SELL';

/**
 * Parameters for creating an order
 */
export interface OrderParams {
    marketId: string;
    tokenId: string;
    outcome: string;
    side: OrderSide;
    sizeUsd: number;
    sizeShares?: number;
    priceLimit?: number;
    orderType?: 'GTC' | 'FOK' | 'FAK';
}

/**
 * Result of an order execution
 */
export interface OrderResult {
    success: boolean;
    orderId?: string;
    txHash?: string;
    sharesFilled: number;
    priceFilled: number;
    usdFilled?: number;
    error?: string;
}

/**
 * Qualitative measure of liquidity
 */
export enum LiquidityHealth {
    HIGH = 'HIGH',
    MEDIUM = 'MEDIUM',
    LOW = 'LOW',
    CRITICAL = 'CRITICAL'
}

/**
 * Quantitative metrics for market liquidity
 */
export interface LiquidityMetrics {
    health: LiquidityHealth;
    spread: number;
    spreadPercent: number;
    availableDepthUsd: number;
    bestPrice: number;
}

/**
 * Opportunity found in prediction markets (Market Making / Spread Capture)
 */
export interface ArbitrageOpportunity {
    marketId: string;
    tokenId: string;
    question: string;
    image?: string;
    marketSlug?: string;
    bestBid: number;
    bestAsk: number;
    spread: number;
    spreadPct: number;
    spreadCents: number;
    midpoint: number;
    volume: number;
    liquidity: number;
    isNew: boolean;
    rewardsMaxSpread?: number;
    rewardsMinSize?: number;
    timestamp: number;
    roi: number;
    combinedCost: number;
    capacityUsd: number;
}

/**
 * Unified interface for prediction market exchange interactions
 */
export interface IExchangeAdapter {
    readonly exchangeName: string;
    initialize(): Promise<void>;
    validatePermissions(): Promise<boolean>;
    authenticate(): Promise<void>;
    fetchBalance(address: string): Promise<number>;
    getPortfolioValue(address: string): Promise<number>;
    getMarketPrice(marketId: string, tokenId: string, side?: 'BUY' | 'SELL'): Promise<number>;
    getOrderBook(tokenId: string): Promise<OrderBook>;
    getLiquidityMetrics?(tokenId: string, side: 'BUY' | 'SELL'): Promise<LiquidityMetrics>;
    getNegRiskMarkets?(): Promise<any[]>;
    getPositions(address: string): Promise<PositionData[]>;
    fetchPublicTrades(address: string, limit?: number): Promise<TradeSignal[]>;
    getTradeHistory(address: string, limit?: number): Promise<TradeHistoryEntry[]>;
    createOrder(params: OrderParams): Promise<OrderResult>;
    cancelOrder(orderId: string): Promise<boolean>;
    cancelAllOrders(): Promise<boolean>;
    getOpenOrders(): Promise<any[]>;
    mergePositions(conditionId: string, amount: number): Promise<string>;
    cashout(amount: number, destination: string): Promise<string>;
    getFunderAddress(): string;
    redeemPosition(conditionId: string, tokenId: string): Promise<{ success: boolean; amountUsd?: number; txHash?: string; error?: string }>;
}
