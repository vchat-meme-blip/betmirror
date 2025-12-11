export interface TraderProfile {
  address: string;
  ens?: string;
  winRate: number;
  totalPnl: number;
  tradesLast30d: number;
  followers: number;
  isVerified?: boolean;
  // The 'Finder' of this wallet who gets 1% fee
  listedBy: string; 
  listedAt: string;
}

export interface FeeDistributionEvent {
  tradeId: string;
  profitAmount: number;
  listerFee: number;
  platformFee: number;
  listerAddress: string;
  platformAddress: string;
  txHash?: string;
}
