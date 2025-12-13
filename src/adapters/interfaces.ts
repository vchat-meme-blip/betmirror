
import { OrderBook } from '../domain/market.types.js';
import { TradeSignal } from '../domain/trade.types.js';

export type OrderSide = 'BUY' | 'SELL';

export interface OrderParams {
    marketId: string;
    tokenId: string;
    outcome: string;
    side: OrderSide;
    sizeUsd: number;
    priceLimit?: number;
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
    getMarketPrice(marketId: string, tokenId: string): Promise<number>;
    getOrderBook(tokenId: string): Promise<OrderBook>;
    
    // Monitoring
    // Returns normalized TradeSignals for the monitoring loop
    fetchPublicTrades(address: string, limit?: number): Promise<TradeSignal[]>;

    // Execution
    createOrder(params: OrderParams): Promise<string>; // Returns Order ID / Tx Hash
    cancelOrder(orderId: string): Promise<boolean>;
    
    // Order Management
    cashout(amount: number, destination: string): Promise<string>;
    
    // Legacy Accessors (Temporary during migration phase)
    getRawClient?(): any;
    getSigner?(): any;
    getFunderAddress?(): string | undefined; 
}
