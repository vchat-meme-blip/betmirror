
export type TradeSignal = {
  trader: string;
  marketId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  sizeUsd: number;
  price: number;
  timestamp: number;
};

export type TradeEvent = {
  trader: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  sizeUsd: number;
  price: number;
  timestamp: number;
};

export type TradeHistoryEntry = {
  id: string;
  timestamp: string;
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  executedSize?: number;
  price: number;
  pnl?: number;
  status: 'OPEN' | 'CLOSED' | 'SKIPPED' | 'FAILED' | 'FILLED';
  txHash?: string;
  // Metadata for UI
  aiReasoning?: string;
  riskScore?: number;
  // CLOB Tracking
  clobOrderId?: string;
  assetId?: string;
};

// Tracks open positions to calculate REAL PnL on sell
export interface ActivePosition {
  tradeId: string; // Link to the original TradeHistoryEntry._id
  clobOrderId?: string; // The specific order ID on Polymarket
  marketId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  entryPrice: number;
  shares: number; // Exact number of shares held (Critical for selling)
  sizeUsd: number; // Initial invested amount
  timestamp: number;
  // Rich Data (Synced from Chain)
  currentPrice?: number;
  question?: string;
  image?: string;
  endDate?: string;
  marketSlug?: string; // ADDED
}
