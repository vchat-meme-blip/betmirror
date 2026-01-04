export interface MarketData {
    id: string;
    question: string;
    outcomes: string[];
    active: boolean;
    closed: boolean;
    volume: number;
    endDate?: string;
}

export interface OrderBook {
    bids: { price: number; size: number }[];
    asks: { price: number; size: number }[];
    // NEW: Market metadata returned by getOrderBook()
    min_order_size?: number;
    tick_size?: number;
    neg_risk?: boolean;
}

export interface PositionData {
    marketId: string;
    tokenId: string;
    // FIX: Added conditionId to satisfy bot-engine requirements and align with Polymarket CLOB API structure
    conditionId: string;
    outcome: string;
    balance: number; // Number of shares
    valueUsd: number;
    investedValue?: number; // NEW: Total USD cost basis
    entryPrice: number;
    currentPrice: number;
    unrealizedPnL?: number; // NEW: valueUsd - investedValue
    unrealizedPnLPercent?: number; // NEW: PnL / investedValue
    // Rich Data Fields
    question?: string;
    image?: string;
    endDate?: string;
    marketSlug?: string;
    eventSlug?: string;
    // FIX: Added clobOrderId to satisfy bot-engine requirements and internal tracking
    clobOrderId?: string;
}