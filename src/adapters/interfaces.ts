import { OrderBook, PositionData } from '../domain/market.types.js';
import { TradeSignal, TradeHistoryEntry } from '../domain/trade.types.js';

export type OrderSide = 'BUY' | 'SELL';

export interface OrderParams {
    marketId: string;
    tokenId: string;
    outcome: string;
    side: OrderSide;
    sizeUsd: number;
    priceLimit?: number;
    // New: Allow specifying raw share count for sells to ensure 100% closure
    sizeShares?: number; 
}

export interface OrderResult {
    success: boolean;
    orderId?: string;
    txHash?: string;
    sharesFilled: number;
    priceFilled: number;
    error?: string;
}

/**
 * Standard Interface for any Prediction Market Exchange (Polymarket, Kalshi, etc.)
 * This allows the BotEngine to switch between exchanges or auth methods without code changes.
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
    /**
     * Fetches market price.
     * @param side Optional. Use 'BUY' for Ask (execution cost) or 'SELL' for Bid (liquidation value).
     */
    getMarketPrice(marketId: string, tokenId: string, side?: OrderSide): Promise<number>;
    getOrderBook(tokenId: string): Promise<OrderBook>;
    getPositions(address: string): Promise<PositionData[]>; // Sync positions
    
    // Monitoring
    // Returns normalized TradeSignals for the monitoring loop
    fetchPublicTrades(address: string, limit?: number): Promise<TradeSignal[]>;
    
    // History Sync
    getTradeHistory(address: string, limit?: number): Promise<TradeHistoryEntry[]>;

    // Execution
    createOrder(params: OrderParams): Promise<OrderResult>; 
    cancelOrder(orderId: string): Promise<boolean>;
    
    // Order Management
    cashout(amount: number, destination: string): Promise<string>;
    
    // Legacy Accessors (Temporary during migration phase)
    getRawClient?(): any;
    getSigner?(): any;
    getFunderAddress?(): string | undefined; 
}