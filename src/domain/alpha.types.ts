
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
  
  // Bet Mirror Specific Stats
  copyCount: number;         // How many times this wallet was copied on our platform
  copyProfitGenerated: number; // Total profit generated for copiers
}

export interface FeeDistributionEvent {
  tradeId: string;
  profitAmount: number;
  listerFee: number;
  platformFee: number;
  listerAddress: string;
  platformAddress: string;
  txHash?: string;
  timestamp: string;
}

export interface CashoutRecord {
  id: string;
  amount: number;
  txHash: string;
  timestamp: string;
  destination: string;
}

export interface UserRewardRecord {
  id: string;
  source: 'LISTING_FEE' | 'REFERRAL';
  amount: number;
  fromWallet: string;
  timestamp: string;
}

// Interface to decouple Data Access (DB vs HTTP)
export interface IRegistryService {
  getListerForWallet(walletAddress: string): Promise<string | null>;
}

export interface BuilderVolumeData {
    dt: string;
    builder: string;
    builderLogo: string;
    verified: boolean;
    volume: number;
    activeUsers: number;
    rank: string;
}
