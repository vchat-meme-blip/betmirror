
import mongoose, { Schema, Document } from 'mongoose';
import { TraderProfile } from '../domain/alpha.types.js';
import { TradingWalletConfig } from '../domain/wallet.types.js';
import { ActivePosition } from '../domain/trade.types.js';
import { UserStats } from '../domain/user.types.js';
import { BotConfig } from '../server/bot-engine.js';
import { BridgeTransactionRecord } from '../services/lifi-bridge.service.js';
import { DatabaseEncryptionService } from '../services/database-encryption.service.js';

export interface IUser extends Document {
  address: string;
  tradingWallet?: TradingWalletConfig; 
  activeBotConfig?: BotConfig;
  isBotRunning: boolean;
  activePositions: ActivePosition[];
  stats: UserStats;
  cashoutHistory: any[];
  createdAt: Date;
  lastActive: Date;
}

export interface ITrade extends Document {
  _id: any; 
  userId: string;
  marketId: string;
  clobOrderId?: string; 
  assetId?: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;         
  executedSize: number; 
  price: number;
  pnl?: number;
  status: string;
  txHash?: string;
  aiReasoning?: string;
  riskScore?: number;
  timestamp: Date;
  marketSlug?: string;
  eventSlug?: string;
}

export interface IRegistry extends Document, TraderProfile {
    isSystem?: boolean; 
    tags?: string[];
}

export interface IFeedback extends Document {
  userId: string;
  rating: number;
  comment: string;
  timestamp: Date;
}

export interface IBridgeTransaction extends Document, Omit<BridgeTransactionRecord, 'id'> {
  userId: string;
  bridgeId: string; 
  timestamp: string;
  fromChain: string;
  toChain: string;
  amountIn: string;
  amountOut: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  txHash: string;
  tool: string;
  fees: string;
}

export interface IDepositLog extends Document {
  userId: string;
  amount: number;
  txHash: string;
  timestamp: Date;
}

export interface IBotLog extends Document {
  userId: string;
  type: 'info' | 'warn' | 'error' | 'success';
  message: string;
  timestamp: Date;
}

const ActivePositionSchema = new Schema<ActivePosition>({
  tradeId: String,
  clobOrderId: String,
  marketId: String,
  tokenId: String,
  outcome: String,
  entryPrice: Number,
  shares: Number, 
  sizeUsd: Number,
  timestamp: Number,
  currentPrice: Number,
  question: String,
  image: String,
  marketSlug: { 
    type: String, 
    default: "",
    validate: {
        validator: function(v: string) {
            return !v || /^[a-z0-9-]+$/.test(v);
        },
        message: 'marketSlug must be lowercase with hyphens only'
    }
},
  eventSlug: { 
    type: String, 
    default: "",
    validate: {
        validator: function(v: string) {
            return !v || /^[a-z0-9-]+$/.test(v);
        },
        message: 'eventSlug must be lowercase with hyphens only'
    }
}
}, { _id: false });

const TradingWalletSchema = new Schema({
  address: { type: String, required: true },
  type: { type: String, required: true },
  encryptedPrivateKey: { 
    type: String, 
    required: true,
    select: false // Never include in queries by default
  },
  ownerAddress: { type: String, required: true },
  createdAt: { type: String, required: true },
  safeAddress: { type: String, required: true },
  isSafeDeployed: { type: Boolean, default: false },
  recoveryOwnerAdded: { type: Boolean, default: false }, 
  l2ApiCredentials: {
      key: { 
        type: String,
        select: false // Never include in queries by default
      },
      secret: { 
        type: String,
        select: false // Never include in queries by default
      },
      passphrase: { 
        type: String,
        select: false // Never include in queries by default
      }
  }
}, { _id: false });

// Apply field-level encryption to sensitive fields
DatabaseEncryptionService.createEncryptionMiddleware(TradingWalletSchema, 'encryptedPrivateKey');
DatabaseEncryptionService.createEncryptionMiddleware(TradingWalletSchema, 'l2ApiCredentials.key');
DatabaseEncryptionService.createEncryptionMiddleware(TradingWalletSchema, 'l2ApiCredentials.secret');
DatabaseEncryptionService.createEncryptionMiddleware(TradingWalletSchema, 'l2ApiCredentials.passphrase');

const UserSchema = new Schema<IUser>({
  address: { type: String, required: true, unique: true, index: true },
  tradingWallet: TradingWalletSchema, 
  activeBotConfig: { type: Schema.Types.Mixed }, 
  isBotRunning: { type: Boolean, default: false },
  activePositions: [ActivePositionSchema],
  stats: {
    totalPnl: { type: Number, default: 0 },
    totalVolume: { type: Number, default: 0 },
    totalFeesPaid: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    tradesCount: { type: Number, default: 0 },
    allowanceApproved: { type: Boolean, default: false },
    portfolioValue: { type: Number, default: 0 },
    cashBalance: { type: Number, default: 0 }
  },
  cashoutHistory: [Schema.Types.Mixed],
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

const TradeSchema = new Schema<ITrade>({
  _id: { type: String, required: true }, 
  userId: { type: String, required: true, index: true },
  marketId: { type: String, required: true },
  clobOrderId: { type: String, index: true }, 
  assetId: String,
  outcome: String,
  side: String,
  size: Number,
  executedSize: { type: Number, default: 0 }, 
  price: Number,
  pnl: Number,
  status: String,
  txHash: String,
  aiReasoning: String,
  riskScore: Number,
  timestamp: { type: Date, default: Date.now },
  marketSlug: { 
    type: String, 
    default: "",
    validate: {
        validator: function(v: string) {
            return !v || /^[a-z0-9-]+$/.test(v);
        },
        message: 'marketSlug must be lowercase with hyphens only'
    }
},
  eventSlug: { 
    type: String, 
    default: "",
    validate: {
        validator: function(v: string) {
            return !v || /^[a-z0-9-]+$/.test(v);
        },
        message: 'eventSlug must be lowercase with hyphens only'
    }
}
});

const RegistrySchema = new Schema<IRegistry>({
  address: { type: String, required: true, unique: true },
  ens: String,
  winRate: { type: Number, default: 0 },
  totalPnl: { type: Number, default: 0 },
  tradesLast30d: { type: Number, default: 0 },
  followers: { type: Number, default: 0 },
  isVerified: { type: Boolean, default: false },
  isSystem: { type: Boolean, default: false },
  tags: [String],
  listedBy: String,
  listedAt: String,
  copyCount: { type: Number, default: 0 },
  copyProfitGenerated: { type: Number, default: 0 }
});

const FeedbackSchema = new Schema<IFeedback>({
  userId: String,
  rating: Number,
  comment: String,
  timestamp: { type: Date, default: Date.now }
});

const BridgeTransactionSchema = new Schema<IBridgeTransaction>({
  userId: { type: String, required: true, index: true },
  bridgeId: String,
  timestamp: String,
  fromChain: String,
  toChain: String,
  amountIn: String,
  amountOut: String,
  status: String,
  txHash: String,
  tool: String,
  fees: String
});

const DepositLogSchema = new Schema<IDepositLog>({
  userId: { type: String, required: true, index: true },
  amount: { type: Number, required: true },
  txHash: { type: String, required: true, unique: true },
  timestamp: { type: Date, default: Date.now }
});

const BotLogSchema = new Schema<IBotLog>({
  userId: { type: String, required: true, index: true },
  type: String,
  message: String,
  timestamp: { type: Date, default: Date.now, expires: 86400 * 3 } 
});

// --- Models ---

export const User = mongoose.model<IUser>('User', UserSchema);
export const Trade = mongoose.model<ITrade>('Trade', TradeSchema);
export const Registry = mongoose.model<IRegistry>('Registry', RegistrySchema);
export const Feedback = mongoose.model<IFeedback>('Feedback', FeedbackSchema);

// Re-export trade tracking models
export { CopiedTrade, HunterEarning, WalletAnalytics } from './trade-tracking.schema.js';

export const BridgeTransaction = mongoose.model<IBridgeTransaction>('BridgeTransaction', BridgeTransactionSchema);
export const DepositLog = mongoose.model<IDepositLog>('DepositLog', DepositLogSchema);
export const BotLog = mongoose.model<IBotLog>('BotLog', BotLogSchema);

// --- Connection ---

export const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGO_URI environment variable is not defined');
  }
  
  // Validate database encryption key
  if (!DatabaseEncryptionService.validateEncryptionKey()) {
    console.warn('Database encryption key is not properly configured. Please set DB_ENCRYPTION_KEY in your environment variables.');
  }
  try {
    mongoose.set('strictQuery', true);
    console.log(`🔌 Attempting to connect to MongoDB...`);
    await mongoose.connect(uri, {
      dbName: 'betmirror' 
    } as any);
    console.log(`📦 Connected to MongoDB successfully!`);
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    throw error;
  }
};
