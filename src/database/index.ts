
import mongoose, { Schema, Document, Model } from 'mongoose';
import { TraderProfile } from '../domain/alpha.types.js';
import { TradingWalletConfig } from '../domain/wallet.types.js';
import { ActivePosition, TradeHistoryEntry } from '../domain/trade.types.js';
import { UserStats } from '../domain/user.types.js';
import { BotConfig } from '../server/bot-engine.js';
import { BridgeTransactionRecord } from '../services/lifi-bridge.service.js';

// --- Interfaces ---

export interface IUser extends Document {
  address: string;
  tradingWallet?: TradingWalletConfig; // RENAMED from proxyWallet
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
  size: number;         // Signal Size (Whale)
  executedSize: number; // Bot Size (Real)
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

const TradingWalletSchema = new Schema({
  address: String,
  type: String,
  encryptedPrivateKey: String,
  ownerAddress: String,
  createdAt: String,
  // L2 CLOB Credentials (Not Private Keys, just API Access tokens)
  l2ApiCredentials: {
      key: String,
      secret: String,
      passphrase: String
  }
}, { _id: false });

const UserSchema = new Schema<IUser>({
  address: { type: String, required: true, unique: true, index: true },
  tradingWallet: TradingWalletSchema, // Updated field name
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
  executedSize: { type: Number, default: 0 }, // NEW: Track actual bot volume
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
    
    // Optimized connection options for cloud containers
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 15000, // Wait 15s before giving up
      socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
      family: 4, // FORCE IPv4
      dbName: 'betmirror' // Explicitly set DB name to avoid defaulting to 'test'
    });

    // --- FIX: Drop Legacy Index ---
    try {
        if (mongoose.connection.db) {
            const indexName = 'handle_1';
            const indexExists = await mongoose.connection.db.collection('users').indexExists(indexName);
            if (indexExists) {
                await mongoose.connection.db.collection('users').dropIndex(indexName);
            }
        }
    } catch (e: any) {
        // Ignore
    }
    
    // Detailed Connection Logging
    const dbName = mongoose.connection.name;
    const dbHost = mongoose.connection.host;
    console.log(`📦 Connected to MongoDB successfully!`);
    console.log(`   - Host: ${dbHost}`);
    console.log(`   - DB Name: ${dbName}`);
    console.log(`   - Environment: ${uri.includes('mongodb.net') ? 'Atlas Cloud' : 'Local/Self-Hosted'}`);

  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    // Do NOT exit process. This kills the container and fails deployment health checks.
    // Instead, throw error so the caller knows, but keeps the HTTP server alive.
    throw error;
  }
};
