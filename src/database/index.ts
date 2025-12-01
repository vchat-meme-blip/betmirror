
import mongoose, { Schema, Document, Model } from 'mongoose';
import { TraderProfile } from '../domain/alpha.types';
import { ProxyWalletConfig } from '../domain/wallet.types';
import { ActivePosition, TradeHistoryEntry } from '../domain/trade.types';
import { UserStats } from '../domain/user.types';
import { BotConfig } from '../server/bot-engine';
import { BridgeTransactionRecord } from '../services/lifi-bridge.service';

// --- Interfaces ---

export interface IUser extends Document {
  address: string;
  proxyWallet?: ProxyWalletConfig;
  activeBotConfig?: BotConfig;
  isBotRunning: boolean;
  activePositions: ActivePosition[];
  stats: UserStats;
  cashoutHistory: any[];
  createdAt: Date;
  lastActive: Date;
}

export interface ITrade extends Document {
  userId: string;
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  pnl?: number;
  status: string;
  txHash?: string;
  aiReasoning?: string;
  riskScore?: number;
  timestamp: Date;
}

export interface IRegistry extends Document, TraderProfile {
    isSystem?: boolean; // If true, added by env var/admin
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
  bridgeId: string; // Internal ID
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

// --- Schemas ---

const ActivePositionSchema = new Schema({
  marketId: String,
  tokenId: String,
  outcome: String,
  entryPrice: Number,
  sizeUsd: Number,
  timestamp: Number
}, { _id: false });

const ProxyWalletSchema = new Schema({
  address: String,
  type: String,
  serializedSessionKey: String,
  sessionPrivateKey: String,
  ownerAddress: String,
  createdAt: String
}, { _id: false });

const UserSchema = new Schema<IUser>({
  address: { type: String, required: true, unique: true, index: true },
  proxyWallet: ProxyWalletSchema,
  activeBotConfig: { type: Schema.Types.Mixed }, // Store flex config
  isBotRunning: { type: Boolean, default: false },
  activePositions: [ActivePositionSchema],
  stats: {
    totalPnl: { type: Number, default: 0 },
    totalVolume: { type: Number, default: 0 },
    totalFeesPaid: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    tradesCount: { type: Number, default: 0 },
    allowanceApproved: { type: Boolean, default: false }
  },
  cashoutHistory: [Schema.Types.Mixed],
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

const TradeSchema = new Schema<ITrade>({
  userId: { type: String, required: true, index: true },
  marketId: { type: String, required: true },
  outcome: String,
  side: String,
  size: Number,
  price: Number,
  pnl: Number,
  status: String,
  txHash: String,
  aiReasoning: String,
  riskScore: Number,
  timestamp: { type: Date, default: Date.now }
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
  timestamp: { type: Date, default: Date.now, expires: 86400 * 3 } // TTL 3 days
});

// --- Models ---

export const User = mongoose.model<IUser>('User', UserSchema);
export const Trade = mongoose.model<ITrade>('Trade', TradeSchema);
export const Registry = mongoose.model<IRegistry>('Registry', RegistrySchema);
export const Feedback = mongoose.model<IFeedback>('Feedback', FeedbackSchema);
export const BridgeTransaction = mongoose.model<IBridgeTransaction>('BridgeTransaction', BridgeTransactionSchema);
export const DepositLog = mongoose.model<IDepositLog>('DepositLog', DepositLogSchema);
export const BotLog = mongoose.model<IBotLog>('BotLog', BotLogSchema);

// --- Connection ---

export const connectDB = async (uri: string) => {
  try {
    mongoose.set('strictQuery', true);
    
    // Mask URI for safety in logs
    const maskedUri = uri.replace(/:\/\/.*@/, '://***:***@');
    console.log(`🔌 Attempting to connect to MongoDB...`);
    
    await mongoose.connect(uri);

    // --- FIX: Drop Legacy Index ---
    // The error 'E11000 ... index: handle_1 dup key: { handle: null }' happens because
    // an old index exists on 'handle' but our schema doesn't use it, causing all new users
    // to default to null, which violates uniqueness. We drop it here.
    try {
        if (mongoose.connection.db) {
            const indexName = 'handle_1';
            const indexExists = await mongoose.connection.db.collection('users').indexExists(indexName);
            if (indexExists) {
                await mongoose.connection.db.collection('users').dropIndex(indexName);
                console.log('🧹 Cleaned up legacy index: handle_1 (Fixed Activation Error)');
            }
        }
    } catch (e: any) {
        // Ignore if index doesn't exist or other non-critical error
        if (e.code !== 27) { 
            console.warn('⚠️ Index cleanup check:', e.message);
        }
    }
    
    console.log(`📦 Connected to MongoDB successfully (${uri.includes('mongodb.net') ? 'Atlas Cloud' : 'Local'})`);
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    process.exit(1);
  }
};
