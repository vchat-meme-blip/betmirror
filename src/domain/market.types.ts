
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
}

export interface PositionData {
    marketId: string;
    tokenId: string;
    outcome: string;
    balance: number; // Number of shares
    valueUsd: number;
    entryPrice: number;
    currentPrice: number;
    // Rich Data Fields
    question?: string;
    image?: string;
    endDate?: string;
    marketSlug?: string; // ADDED
}
