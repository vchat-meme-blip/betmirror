import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';
import mongoose from 'mongoose';
import { ethers, JsonRpcProvider } from 'ethers';
import { BotEngine, BotConfig } from './bot-engine.js';
import { TradingWalletConfig } from '../domain/wallet.types.js';
import { connectDB, User, Registry, Trade, Feedback, BridgeTransaction, BotLog, DepositLog, HunterEarning } from '../database/index.js';
import { loadEnv, TOKENS } from '../config/env.js';
import { DbRegistryService } from '../services/db-registry.service.js';
import { registryAnalytics } from '../services/registry-analytics.service.js';
import { EvmWalletService } from '../services/evm-wallet.service.js';
import { SafeManagerService } from '../services/safe-manager.service.js';
import { BuilderVolumeData } from '../domain/alpha.types.js';
import axios from 'axios';
import { Logger } from '../utils/logger.util.js';
import fs from 'fs';

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ENV = loadEnv();

// Service Singletons
const dbRegistryService = new DbRegistryService();
const evmWalletService = new EvmWalletService(ENV.rpcUrl, ENV.mongoEncryptionKey);

// In-Memory Bot Instances (Runtime State)
const ACTIVE_BOTS = new Map<string, BotEngine>();

// Simple Logger for Server context
const serverLogger: Logger = {
    info: (msg) => console.log(`[SERVER] ${msg}`),
    warn: (msg) => console.warn(`[SERVER WARN] ${msg}`),
    error: (msg, err) => console.error(`[SERVER ERROR] ${msg}`, err),
    debug: (msg) => console.debug(`[SERVER DEBUG] ${msg}`),
    success: (msg) => console.log(`[SERVER SUCCESS] ${msg}`)
};

app.use(cors());
app.use(express.json({ limit: '10mb' }) as any); 

// --- STATIC FILES (For Production) ---
const distPath = path.join(__dirname, '../../dist');
app.use(express.static(distPath) as any);


// --- HELPER: Start Bot Instance ---
async function startUserBot(userId: string, config: BotConfig) {
    const normId = userId.toLowerCase();
    
    if (ACTIVE_BOTS.has(normId)) {
        ACTIVE_BOTS.get(normId)?.stop();
    }

    const startCursor = config.startCursor || Math.floor(Date.now() / 1000);
    const engineConfig = { ...config, userId: normId, startCursor };

    const engine = new BotEngine(engineConfig, dbRegistryService, {
        onPositionsUpdate: async (positions) => {
            // We still update DB for persistence/backup, but UI will prefer live feed
            await User.updateOne({ address: normId }, { activePositions: positions });
        },
        onCashout: async (record) => {
            await User.updateOne({ address: normId }, { $push: { cashoutHistory: record } });
        },
        onTradeComplete: async (trade) => {
            try {
                // ATOMIC STATS UPDATE
                // We use $inc to prevent race conditions and ensure accurate accounting
                const update: any = {
                    $inc: {
                        'stats.totalVolume': trade.executedSize || 0,
                        'stats.tradesCount': 1
                    }
                };

                if (trade.side === 'SELL' && trade.pnl !== undefined) {
                    update.$inc['stats.totalPnl'] = trade.pnl;
                    if (trade.pnl >= 0) update.$inc['stats.winCount'] = 1;
                    else update.$inc['stats.lossCount'] = 1;
                }

                await User.updateOne({ address: normId }, update);

                const exists = await Trade.findById(trade.id);
                if (!exists) {
                    await Trade.create({
                        _id: trade.id,
                        userId: normId,
                        marketId: trade.marketId,
                        outcome: trade.outcome,
                        side: trade.side,
                        size: trade.size,
                        executedSize: trade.executedSize || 0,
                        price: trade.price,
                        pnl: trade.pnl,
                        status: trade.status,
                        txHash: trade.txHash,
                        clobOrderId: trade.clobOrderId, 
                        assetId: trade.assetId,         
                        aiReasoning: trade.aiReasoning,
                        riskScore: trade.riskScore,
                        timestamp: trade.timestamp,
                        marketSlug: trade.marketSlug,
                        eventSlug: trade.eventSlug
                    });
                }
            } catch (err: any) {
                serverLogger.error(`Failed to save trade for ${normId}: ${err.message}`);
            }
        },
        onStatsUpdate: async (stats) => {
            await User.updateOne({ address: normId }, { stats });
        },
        onFeePaid: async (event) => {
             const lister = await Registry.findOne({ address: { $regex: new RegExp(`^${event.listerAddress}$`, "i") } });
             if (lister) {
                 lister.copyCount = (lister.copyCount || 0) + 1;
                 lister.copyProfitGenerated = (lister.copyProfitGenerated || 0) + event.profitAmount;
                 await lister.save();
             }
        }
    });

    ACTIVE_BOTS.set(normId, engine);
    engine.start().catch(err => console.error(`[Bot Error] ${normId}:`, err.message));
}

// 0. Health Check
app.get('/health', (req, res) => {
    const dbState = mongoose.connection.readyState;
    const dbStatusMap = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
    
    res.status(200).json({ 
        status: 'ok', 
        db: (dbStatusMap as any)[dbState] || 'unknown',
        uptime: process.uptime(),
        activeBots: ACTIVE_BOTS.size,
        timestamp: new Date()
    });
});

// 1. Check Status / Init
app.post('/api/wallet/status', async (req: any, res: any) => {
  const { userId } = req.body; 
  if (!userId) { res.status(400).json({ error: 'User Address required' }); return; }
  const normId = userId.toLowerCase();

  try {
      console.log(`[STATUS CHECK] Querying user: ${normId}`);
      const user = await User.findOne({ address: normId });
      
      // If user has a wallet, return it
      if (!user || !user.tradingWallet) {
        console.log(`[STATUS CHECK] User ${normId} needs activation.`);
        res.json({ status: 'NEEDS_ACTIVATION' });
      } else {
        let safeAddr = user.tradingWallet.safeAddress || null;
        
        if (user.tradingWallet.address) {
            try {
                /**
                 * DERIVATION GUARD:
                 * We recalculate the address now to ensure parity with the Polymarket SDK logic.
                 * If the address in the DB was derived using a different factory, we override it here.
                 */
                const correctSafeAddr = await SafeManagerService.computeAddress(user.tradingWallet.address);
                if (!safeAddr || safeAddr.toLowerCase() !== correctSafeAddr.toLowerCase()) {
                    safeAddr = correctSafeAddr;
                    user.tradingWallet.safeAddress = safeAddr;
                    user.tradingWallet.type = 'GNOSIS_SAFE';
                    await user.save();
                    console.log(`[STATUS CHECK] Repaired/Aligned Safe address: ${safeAddr}`);
                }
            } catch (err) {
                console.warn("Failed to compute safe address", err);
            }
        }

        console.log(`[STATUS CHECK] Active. Proxy(Safe): ${safeAddr} | Signer: ${user.tradingWallet.address}`);
        
        res.json({ 
            status: 'ACTIVE', 
            address: user.tradingWallet.address, // EOA (Signer)
            safeAddress: safeAddr,               // Gnosis (Funder)
            type: user.tradingWallet.type,
            recoveryOwnerAdded: user.tradingWallet.recoveryOwnerAdded || false
        });
      }
  } catch (e: any) {
      console.error("[STATUS CHECK ERROR]", e);
      res.status(500).json({ error: 'DB Error: ' + e.message });
  }
});

// 2. Activate Trading Wallet (EOA + Safe Calculation)
app.post('/api/wallet/activate', async (req: any, res: any) => {
    console.log(`[ACTIVATION REQUEST] Received payload for user: ${req.body?.userId}`);
    const { userId } = req.body;
    
    if (!userId) { 
        res.status(400).json({ error: 'Missing userId' }); 
        return; 
    }
    const normId = userId.toLowerCase();

    try {
        let user = await User.findOne({ address: normId });
        
        if (user && user.tradingWallet && user.tradingWallet.address) {
            console.log(`[ACTIVATION] User ${normId} already has wallet.`);
            
            // Force SDK-aligned derivation
            const safeAddr = await SafeManagerService.computeAddress(user.tradingWallet.address);
            user.tradingWallet.safeAddress = safeAddr;
            user.tradingWallet.type = 'GNOSIS_SAFE';
            await user.save();

            res.json({ 
                success: true, 
                address: user.tradingWallet.address,
                safeAddress: safeAddr,
                restored: true 
            });
            return;
        }

        console.log(`[ACTIVATION] Generating NEW keys for ${normId}...`);
        const walletConfig = await evmWalletService.createTradingWallet(normId);
        
        // Force SDK-aligned derivation from the start
        const safeAddr = await SafeManagerService.computeAddress(walletConfig.address);
        
        const configToSave: TradingWalletConfig = {
            ...walletConfig,
            type: 'GNOSIS_SAFE',
            safeAddress: safeAddr, 
            isSafeDeployed: false,
            recoveryOwnerAdded: false
        };

        await User.findOneAndUpdate(
            { address: normId },
            { tradingWallet: configToSave },
            { upsert: true, new: true }
        );
        console.log(`[ACTIVATION SUCCESS] EOA: ${configToSave.address} | Safe: ${safeAddr}`);
        
        res.json({ 
            success: true, 
            address: configToSave.address,
            safeAddress: safeAddr
        });
    } catch (e: any) {
        console.error("[ACTIVATION DB ERROR]", e);
        res.status(500).json({ error: e.message || 'Failed to activate' });
    }
});

// 2b. Add Recovery Owner (Multi-Owner Safe)
app.post('/api/wallet/add-recovery', async (req: any, res: any) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing User ID' });
    const normId = userId.toLowerCase();

    try {
        const user = await User.findOne({ address: normId });
        if (!user || !user.tradingWallet || !user.tradingWallet.encryptedPrivateKey) {
            return res.status(404).json({ error: 'User wallet not found' });
        }

        const walletConfig = user.tradingWallet;
        const safeAddr = walletConfig.safeAddress || await SafeManagerService.computeAddress(walletConfig.address);

        const signer = await evmWalletService.getWalletInstance(walletConfig.encryptedPrivateKey);
        const safeManager = new SafeManagerService(
            signer, ENV.builderApiKey, ENV.builderApiSecret, ENV.builderApiPassphrase, serverLogger, safeAddr
        );

        // Execute Add Owner
        const txHash = await safeManager.addOwner(normId);
        
        if (txHash === "ALREADY_OWNER" || txHash.startsWith("0x")) {
            user.tradingWallet.recoveryOwnerAdded = true;
            await user.save();
            res.json({ success: true, txHash: txHash === "ALREADY_OWNER" ? null : txHash, alreadyOwner: txHash === "ALREADY_OWNER" });
        } else {
             throw new Error("Failed to add owner");
        }

    } catch (e: any) {
        serverLogger.error(`Recovery Add Failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// 3. Global Stats (No Change)
app.get('/api/stats/global', async (req: any, res: any) => {
    try {
        const userCount = await User.countDocuments();
        const tradeAgg = await Trade.aggregate([
            { $group: { _id: null, signalVolume: { $sum: "$size" }, executedVolume: { $sum: "$executedSize" }, count: { $sum: 1 } } }
        ]);
        const signalVolume = tradeAgg[0]?.signalVolume || 0;
        const executedVolume = tradeAgg[0]?.executedVolume || 0;
        const internalTrades = tradeAgg[0]?.count || 0;

        const revenueAgg = await User.aggregate([
            { $group: { _id: null, total: { $sum: "$stats.totalFeesPaid" } } }
        ]);
        const totalRevenue = revenueAgg[0]?.total || 0;

        const bridgeAgg = await BridgeTransaction.aggregate([
             { $match: { status: 'COMPLETED' } },
             { $group: { _id: null, total: { $sum: { $toDouble: "$amountIn" } } } }
        ]);
        const directAgg = await DepositLog.aggregate([
             { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        
        const totalBridged = bridgeAgg[0]?.total || 0;
        const totalDirect = directAgg[0]?.total || 0;
        const totalLiquidity = totalBridged + totalDirect;

        let builderStats: BuilderVolumeData | null = null;
        let leaderboard: BuilderVolumeData[] = [];
        let ecosystemVolume = 0;
        const myBuilderId = ENV.builderId || 'BetMirror'; 

        try {
            const lbUrl = `https://data-api.polymarket.com/v1/builders/leaderboard?timePeriod=ALL&limit=50`;
            const lbResponse = await axios.get<BuilderVolumeData[]>(lbUrl, { timeout: 4000 });
            
            if (Array.isArray(lbResponse.data)) {
                 leaderboard = lbResponse.data;
                 ecosystemVolume = leaderboard.reduce((acc, curr) => acc + (curr.volume || 0), 0);
                 const myEntry = leaderboard.find(b => b.builder.toLowerCase() === myBuilderId.toLowerCase());
                 
                 if (myEntry) {
                     builderStats = myEntry;
                 } else {
                     builderStats = {
                         builder: myBuilderId,
                         rank: 'Unranked',
                         volume: 0,
                         activeUsers: 0,
                         verified: false,
                         builderLogo: ''
                     };
                 }
            }
        } catch (e) {
            console.warn("Failed to fetch external builder stats:", e instanceof Error ? e.message : 'Unknown');
            builderStats = { builder: myBuilderId, rank: 'Error', volume: 0, activeUsers: 0, verified: false };
        }

        res.json({
            internal: {
                totalUsers: userCount,
                signalVolume: signalVolume,
                executedVolume: executedVolume,
                totalTrades: internalTrades,
                totalRevenue,
                totalLiquidity,
                activeBots: ACTIVE_BOTS.size
            },
            builder: {
                current: builderStats,
                history: leaderboard,
                builderId: myBuilderId,
                ecosystemVolume
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Stats Error' });
    }
});

// 4. Feedback
app.post('/api/feedback', async (req: any, res: any) => {
    const { userId, rating, comment } = req.body;
    try {
        await Feedback.create({ userId: userId.toLowerCase(), rating, comment });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed' });
    }
});

// 5. Start Bot
app.post('/api/bot/start', async (req: any, res: any) => {
  const { userId, userAddresses, rpcUrl, geminiApiKey, multiplier, riskProfile, autoTp, notifications, autoCashout, maxTradeAmount } = req.body;
  
  if (!userId) { res.status(400).json({ error: 'Missing userId' }); return; }
  const normId = userId.toLowerCase();

  try {
      const user = await User.findOne({ address: normId });
      if (!user || !user.tradingWallet) { 
          res.status(400).json({ error: 'Trading Wallet not activated.' }); 
          return; 
      }

      const l2Creds = user.tradingWallet.l2ApiCredentials;
      
      const config: BotConfig = {
        userId: normId,
        walletConfig: user.tradingWallet,
        userAddresses: Array.isArray(userAddresses) ? userAddresses : userAddresses.split(',').map((s: string) => s.trim()),
        rpcUrl,
        geminiApiKey,
        multiplier: Number(multiplier),
        riskProfile,
        autoTp: autoTp ? Number(autoTp) : undefined,
        enableNotifications: notifications?.enabled,
        userPhoneNumber: notifications?.phoneNumber,
        autoCashout: autoCashout,
        maxTradeAmount: maxTradeAmount ? Number(maxTradeAmount) : 100, 
        activePositions: user.activePositions || [],
        stats: user.stats,
        l2ApiCredentials: l2Creds,
        mongoEncryptionKey: ENV.mongoEncryptionKey,
        builderApiKey: ENV.builderApiKey,
        builderApiSecret: ENV.builderApiSecret,
        builderApiPassphrase: ENV.builderApiPassphrase,
        startCursor: Math.floor(Date.now() / 1000) 
      };

      await startUserBot(normId, config);
      
      user.activeBotConfig = config;
      user.isBotRunning = true;
      await user.save();

      res.json({ success: true, status: 'RUNNING' });
  } catch (e: any) {
      console.error("Failed to start bot:", e);
      res.status(500).json({ error: e.message });
  }
});

// 6. Stop Bot
app.post('/api/bot/stop', async (req: any, res: any) => {
    const { userId } = req.body;
    const normId = userId.toLowerCase();
    
    const engine = ACTIVE_BOTS.get(normId);
    if (engine) engine.stop();
    
    await User.updateOne({ address: normId }, { isBotRunning: false });
    res.json({ success: true, status: 'STOPPED' });
});

// 6b. Live Update Bot (NEW)
app.post('/api/bot/update', async (req: any, res: any) => {
    const { userId, targets, multiplier, riskProfile, autoTp, autoCashout, notifications, maxTradeAmount } = req.body;
    
    if (!userId) { res.status(400).json({ error: 'Missing userId' }); return; }
    const normId = userId.toLowerCase();

    try {
        const user = await User.findOne({ address: normId });
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }

        if (!user.activeBotConfig) user.activeBotConfig = {} as any;
        const cfg = user.activeBotConfig!;

        if (targets) cfg.userAddresses = targets;
        if (multiplier) cfg.multiplier = multiplier;
        if (riskProfile) cfg.riskProfile = riskProfile;
        if (autoTp) cfg.autoTp = autoTp;
        if (autoCashout) cfg.autoCashout = autoCashout;
        if (maxTradeAmount) cfg.maxTradeAmount = maxTradeAmount;
        if (notifications) {
            cfg.enableNotifications = notifications.enabled;
            cfg.userPhoneNumber = notifications.phoneNumber;
        }

        await User.updateOne({ address: normId }, { activeBotConfig: cfg });

        const engine = ACTIVE_BOTS.get(normId);
        if (engine && engine.isRunning) {
            engine.updateConfig({
                userAddresses: targets,
                multiplier: multiplier ? Number(multiplier) : undefined,
                riskProfile: riskProfile,
                autoTp: autoTp ? Number(autoTp) : undefined,
                autoCashout: autoCashout,
                maxTradeAmount: maxTradeAmount ? Number(maxTradeAmount) : undefined
            });
        }

        res.json({ success: true });
    } catch (e: any) {
        console.error("Failed to update bot config:", e);
        res.status(500).json({ error: e.message });
    }
});

// 7. Bot Status & Logs
app.get('/api/bot/status/:userId', async (req: any, res: any) => {
    const { userId } = req.params;
    const normId = userId.toLowerCase();
    
    const engine = ACTIVE_BOTS.get(normId);
    
    try {
        const tradeHistory = await Trade.find({ userId: normId }).sort({ timestamp: -1 }).limit(50).lean();
        const user = await User.findOne({ address: normId }).lean();
        const dbLogs = await BotLog.find({ userId: normId }).sort({ timestamp: -1 }).limit(100).lean();
        
        const formattedLogs = dbLogs.map(l => ({
            id: l._id.toString(),
            time: l.timestamp.toLocaleTimeString(),
            type: l.type,
            message: l.message
        }));

        const historyUI = tradeHistory.map((t: any) => ({
             ...t,
             timestamp: t.timestamp.toISOString(),
             id: t._id.toString()
        }));

        // LIVE FEED:
        // Use active memory state if running, else DB state.
        let livePositions = [];
        
        if (engine) {
            // Priority: Active Engine Memory (which is synced from DB)
            livePositions = (engine as any).activePositions || [];
        } else if (user && user.activePositions) {
            // Fallback: Database State
            livePositions = user.activePositions;
        }

        // --- DEBUG LOG FOR POSITIONS ---
        // CLARIFICATION: This logs the payload for the current USER VIEWING THE DASHBOARD (normId),
        // but the positions themselves are fetched for the SAFE associated with that user.
        if (livePositions.length > 0) {
            console.log(`\n📦 [DEBUG] Raw Positions Payload for User ${normId.slice(0, 6)}... (Safe: ${user?.tradingWallet?.safeAddress?.slice(0,6) || 'Unknown'}) :`);
            console.dir(livePositions, { depth: null, colors: true });
        }
        // -------------------------------

        res.json({ 
            isRunning: engine ? engine.isRunning : (user?.isBotRunning || false),
            logs: formattedLogs,
            history: historyUI,
            positions: livePositions, 
            stats: user?.stats || null,
            config: user?.activeBotConfig || null
        });
    } catch (e) {
        console.error("Status Error:", e);
        res.status(500).json({ error: 'DB Error' });
    }
});

// 8. Registry Routes
app.get('/api/registry', async (req, res) => {
    try {
        const profiles = await Registry.find().sort({ copyCount: -1, totalPnl: -1 });
        res.json(profiles);
    } catch (e) { res.status(500).json({error: 'DB Error'}); }
});

app.get('/api/registry/:address/earnings', async (req, res) => {
    try {
        const address = req.params.address.toLowerCase();
        
        const earnings = await HunterEarning.find({ hunterAddress: address })
            .sort({ timestamp: -1 })
            .limit(50);
        
        const totalEarned = earnings.reduce((sum, e) => sum + e.hunterFeeUsd, 0);
        const totalTrades = earnings.length;
        const uniqueCopiers = new Set(earnings.map(e => e.copierUserId)).size;
        
        res.json({
            totalEarned,
            totalTrades,
            uniqueCopiers,
            recentEarnings: earnings.slice(0, 10)
        });
    } catch (e) { 
        res.status(500).json({error: 'DB Error'}); 
    }
});

app.get('/api/registry/:address', async (req: any, res: any) => {
    const { address } = req.params;
    try {
        const profile = await Registry.findOne({ address: { $regex: new RegExp(`^${address}$`, "i") } }).lean();
        if(!profile) return res.status(404).json({error: 'Not found'});
        res.json(profile);
    } catch (e) { res.status(500).json({error: 'DB Error'}); }
});

app.post('/api/registry', async (req, res) => {
    const { address, listedBy } = req.body;
    if (!address || !address.startsWith('0x')) { res.status(400).json({error:'Invalid address'}); return; }
    
    try {
        const existing = await Registry.findOne({ address: { $regex: new RegExp(`^${address}$`, "i") } });
        if (existing) { res.status(409).json({error:'Already listed', profile: existing}); return; }

        const profile = await Registry.create({
            address, 
            listedBy: listedBy.toLowerCase(), 
            listedAt: new Date().toISOString(),
            isSystem: false,
            tags: [], 
            winRate: 0, totalPnl: 0, tradesLast30d: 0, followers: 0, copyCount: 0, copyProfitGenerated: 0
        });
        
        registryAnalytics.analyzeWallet(address);
        
        res.json({success:true, profile});
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// PROXY: Get raw trades
app.get('/api/proxy/trades/:address', async (req: any, res: any) => {
    const { address } = req.params;
    try {
        const url = `https://data-api.polymarket.com/trades?user=${address}&limit=50`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch trades from Polymarket" });
    }
});

// 9. Bridge Routes
app.get('/api/bridge/history/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const history = await BridgeTransaction.find({ userId: userId.toLowerCase() }).sort({ timestamp: -1 }).lean();
        res.json(history.map((h: any) => ({ ...h, id: h.bridgeId })));
    } catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});

app.post('/api/bridge/record', async (req: any, res: any) => {
    const { userId, transaction } = req.body;
    if (!userId || !transaction) { res.status(400).json({ error: 'Missing Data' }); return; }
    const normId = userId.toLowerCase();
    try {
        await BridgeTransaction.findOneAndUpdate({ userId: normId, bridgeId: transaction.id }, { userId: normId, bridgeId: transaction.id, ...transaction }, { upsert: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});

app.post('/api/deposit/record', async (req: any, res: any) => {
    const { userId, amount, txHash } = req.body;
    if (!userId || !amount || !txHash) { res.status(400).json({ error: 'Missing Data' }); return; }
    try {
        await DepositLog.create({ userId: userId.toLowerCase(), amount: Number(amount), txHash });
        res.json({ success: true });
    } catch (e) {
        res.json({ success: true, exists: true });
    }
});

app.post('/api/wallet/withdraw', async (req: any, res: any) => {
    const { userId, tokenType, toAddress, forceEoa, targetSafeAddress } = req.body;
    const normId = userId.toLowerCase();
    const isForceEoa = forceEoa === true; // Explicit boolean conversion
    try {
        const user = await User.findOne({ address: normId });
        if (!user || !user.tradingWallet || !user.tradingWallet.encryptedPrivateKey) { res.status(400).json({ error: 'Wallet not configured' }); return; }
        const walletConfig = user.tradingWallet;
        let txHash = '';
        const provider = new JsonRpcProvider(ENV.rpcUrl);
        const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];
        const usdcContract = new ethers.Contract(TOKENS.USDC_BRIDGED, USDC_ABI, provider);
        let safeAddr = targetSafeAddress || walletConfig.safeAddress;
        if (!safeAddr) { safeAddr = await SafeManagerService.computeAddress(walletConfig.address); }
        
        // Calculate balances ONCE - available to both Safe and EOA paths
        let balanceToWithdraw = 0n;
        let eoaBalance = 0n;
        if (tokenType === 'POL') { 
            balanceToWithdraw = await provider.getBalance(safeAddr); 
            if (!targetSafeAddress) eoaBalance = await provider.getBalance(walletConfig.address);
        } else { 
            try { 
                balanceToWithdraw = await usdcContract.balanceOf(safeAddr); 
                if (!targetSafeAddress) eoaBalance = await usdcContract.balanceOf(walletConfig.address);
            } catch(e) {} 
        }
        
        if (!isForceEoa) {
             if (balanceToWithdraw > 0n) {
                 const signer = await evmWalletService.getWalletInstance(walletConfig.encryptedPrivateKey);
                 const safeManager = new SafeManagerService(signer, ENV.builderApiKey, ENV.builderApiSecret, ENV.builderApiPassphrase, serverLogger, safeAddr);
                 
                 if (tokenType === 'POL') { 
                    // Use Safe's on-chain withdrawal to move POL from Safe to user
                    const reserve = ethers.parseEther("0.05");
                    if (balanceToWithdraw > reserve) {
                        const amountStr = ethers.formatEther(balanceToWithdraw - reserve);
                        txHash = await safeManager.withdrawNativeOnChain(toAddress || normId, amountStr);
                    } else {
                        throw new Error("Insufficient POL in Safe to cover gas for withdrawal.");
                    }
                } else { 
                    txHash = await safeManager.withdrawUSDC(toAddress || normId, balanceToWithdraw.toString()); 
                }
             } else if (eoaBalance > 0n && !targetSafeAddress) {
                 let tokenAddr = TOKENS.USDC_BRIDGED;
                 if (tokenType === 'POL') tokenAddr = TOKENS.POL;
                 let amountStr: string = "";
                 if (tokenType === 'POL') { const reserve = ethers.parseEther("0.05"); if (eoaBalance > reserve) { amountStr = ethers.formatEther(eoaBalance - reserve); } else { throw new Error("Insufficient POL in EOA to cover gas for rescue."); } }
                 txHash = await evmWalletService.withdrawFunds(walletConfig.encryptedPrivateKey, toAddress || normId, tokenAddr, amountStr);
             } else { return res.status(400).json({ error: `Insufficient ${tokenType || 'USDC'} funds.` }); }
        } else if (isForceEoa) {
            let tokenAddress = TOKENS.USDC_BRIDGED;
            const signer = await evmWalletService.getWalletInstance(walletConfig.encryptedPrivateKey);
            const safeManager = new SafeManagerService(signer, ENV.builderApiKey, ENV.builderApiSecret, ENV.builderApiPassphrase, serverLogger, safeAddr);
            
            if (tokenType === 'POL') {
                // Use Safe's on-chain withdrawal to move POL from Safe to user
                const reserve = ethers.parseEther("0.05");
                if (balanceToWithdraw > reserve) {
                    const amountStr = ethers.formatEther(balanceToWithdraw - reserve);
                    txHash = await safeManager.withdrawNativeOnChain(toAddress || normId, amountStr);
                } else {
                    throw new Error("Insufficient POL in Safe to cover gas for withdrawal.");
                }
            } else {
                txHash = await safeManager.withdrawUSDC(toAddress || normId, balanceToWithdraw.toString());
            }
        }
        res.json({ success: true, txHash });
    } catch (e: any) {
        console.error('=== WITHDRAWAL ERROR DEBUG ===');
        console.error('Error type:', typeof e);
        console.error('Error name:', e?.name);
        console.error('Error message:', e?.message);
        console.error('Error stack:', e?.stack);
        console.error('Error details:', JSON.stringify(e, null, 2));
        console.error('Request body:', { userId, tokenType, toAddress, forceEoa, targetSafeAddress });
        console.error('=== END DEBUG ===');
        
        // User-friendly error messages
        let userMessage = 'Withdrawal failed. Please try again.';
        
        if (e?.code === 'INSUFFICIENT_FUNDS') {
            userMessage = 'Insufficient funds for withdrawal. Please ensure you have enough POL for gas fees.';
        } else if (e?.message?.includes('insufficient funds')) {
            userMessage = 'Insufficient funds for withdrawal. Please ensure you have enough POL for gas fees.';
        } else if (e?.message?.includes('RelayerError')) {
            userMessage = 'Withdrawal service temporarily unavailable. Please try again in a few minutes.';
        } else if (e?.message?.includes('invalid signature')) {
            userMessage = 'Withdrawal signature validation failed. Please try again.';
        } else if (e?.message?.includes('nonce too low')) {
            userMessage = 'Transaction conflict detected. Please try again.';
        } else if (e?.message?.includes('gas')) {
            userMessage = 'Gas estimation failed. Please try again.';
        } else if (e?.message) {
            userMessage = e?.message;
        }
        
        res.status(500).json({ 
            error: userMessage,
            type: e?.name || 'Unknown',
            details: e?.stack || 'No stack trace available',
            debug: {
                originalError: e?.message || 'Unknown error',
                code: e?.code || null,
                tokenType,
                requestTime: new Date().toISOString()
            }
        });
    }
});

app.post('/api/wallet/add-recovery', async (req: any, res: any) => {
    const { userId } = req.body;
    const normId = userId.toLowerCase();
    try {
        const user = await User.findOne({ address: normId });
        if (!user || !user.tradingWallet || !user.tradingWallet.encryptedPrivateKey) throw new Error("Wallet not configured");
        const signer = await evmWalletService.getWalletInstance(user.tradingWallet.encryptedPrivateKey);
        const safeAddr = user.tradingWallet.safeAddress || await SafeManagerService.computeAddress(user.tradingWallet.address);
        const safeManager = new SafeManagerService(signer, ENV.builderApiKey, ENV.builderApiSecret, ENV.builderApiPassphrase, serverLogger, safeAddr);
        const txHash = await safeManager.addOwner(normId);
        user.tradingWallet.recoveryOwnerAdded = true;
        await user.save();
        res.json({ success: true, txHash });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/trade/sync', async (req: any, res: any) => {
    const { userId, force } = req.body;
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    if (!engine) return res.status(404).json({ error: "Bot not running" });
    try {
        await engine.syncPositions(force);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/trade/exit', async (req: any, res: any) => {
    const { userId, marketId, outcome } = req.body;
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    if (!engine) return res.status(404).json({ error: "Bot not running" });
    try {
        const result = await engine.emergencySell(marketId, outcome);
        res.json({ success: true, result });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// --- ORDER MANAGEMENT ENDPOINTS ---
app.get('/api/orders/open', async (req: any, res: any) => {
    const { userId } = req.query;
    if (!userId) { res.status(400).json({ error: 'User ID required' }); return; }
    const normId = userId.toLowerCase();
    
    try {
        const engine = ACTIVE_BOTS.get(normId);
        if (!engine) return res.status(404).json({ error: 'Bot not running' });
        
        // Get open orders from adapter
        const adapter = engine.getAdapter();
        if (!adapter) return res.status(500).json({ error: 'Adapter not initialized' });
        
        const orders = await adapter.getOpenOrders();
        res.json({ success: true, orders });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/orders/cancel', async (req: any, res: any) => {
    const { userId, orderId } = req.body;
    if (!userId || !orderId) { 
        res.status(400).json({ error: 'User ID and Order ID required' }); 
        return; 
    }
    const normId = userId.toLowerCase();
    
    try {
        const engine = ACTIVE_BOTS.get(normId);
        if (!engine) return res.status(404).json({ error: 'Bot not running' });
        
        const adapter = engine.getAdapter();
        if (!adapter) return res.status(500).json({ error: 'Adapter not initialized' });
        
        const success = await adapter.cancelOrder(orderId);
        
        if (success) {
            res.json({ success: true, message: 'Order cancelled successfully' });
        } else {
            res.status(400).json({ error: 'Failed to cancel order' });
        }
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/redeem', async (req: any, res: any) => {
    const { userId, marketId, outcome } = req.body;
    if (!userId || !marketId || !outcome) { 
        res.status(400).json({ error: 'User ID, Market ID, and Outcome required' }); 
        return; 
    }
    const normId = userId.toLowerCase();
    
    try {
        const engine = ACTIVE_BOTS.get(normId);
        if (!engine) return res.status(404).json({ error: 'Bot not running' });
        
        const adapter = engine.getAdapter();
        // For now, return success - actual redemption implementation would go here
        res.json({ success: true, message: 'Redemption functionality coming soon' });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/feedback', async (req: any, res: any) => {
  const { userId, rating, comment } = req.body;
  try {
      await Feedback.create({
          userId: userId?.toLowerCase() || "anonymous",
          rating: Number(rating),
          comment,
          timestamp: new Date()
      });
      res.json({ success: true });
  } catch (e: any) {
      res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
    const indexPath = path.join(distPath, 'index.html');
    if (!fs.existsSync(indexPath)) {
        console.error(`[SERVER] Missing index.html at ${indexPath}. Frontend not built?`);
        return res.status(500).send("Application frontend not found. Ensure 'npm run build' was executed.");
    }
    res.sendFile(indexPath);
});

// --- SYSTEM RESTORE ---
async function restoreBots() {
    console.log("🔄 Restoring Active Bots from Database...");
    try {
        const activeUsers = await User.find({ isBotRunning: true, "tradingWallet.address": { $exists: true } });
        console.log(`Found ${activeUsers.length} bots to restore.`);

        for (const user of activeUsers) {
            if (user.activeBotConfig && user.tradingWallet) {
                 const normId = user.address.toLowerCase();
                 // ALIGNMENT CHECK
                 const correctSafeAddr = await SafeManagerService.computeAddress(user.tradingWallet.address);
                 if (user.tradingWallet.safeAddress !== correctSafeAddr) {
                     console.log(`[RESTORE] Aligning mismatched safe for ${normId}`);
                     user.tradingWallet.safeAddress = correctSafeAddr;
                     await user.save();
                 }

                 const lastTrade = await Trade.findOne({ userId: normId }).sort({ timestamp: -1 });
                 const lastTime = lastTrade ? Math.floor(lastTrade.timestamp.getTime() / 1000) + 1 : Math.floor(Date.now() / 1000) - 3600;

                 const l2Creds = user.tradingWallet.l2ApiCredentials;

                 const config: BotConfig = {
                     ...user.activeBotConfig,
                     walletConfig: user.tradingWallet,
                     stats: user.stats,
                     activePositions: user.activePositions,
                     startCursor: lastTime,
                     l2ApiCredentials: l2Creds,
                     mongoEncryptionKey: ENV.mongoEncryptionKey,
                     builderApiKey: ENV.builderApiKey,
                     builderApiSecret: ENV.builderApiSecret,
                     builderApiPassphrase: ENV.builderApiPassphrase
                 };
                 
                 try {
                    await startUserBot(normId, config);
                    console.log(`✅ Restored Bot: ${normId}`);
                 } catch (err: any) {
                    console.error(`Bot Start Error for ${normId}: ${err.message}`);
                 }
            }
        }
    } catch (e) {
        console.error("Restore failed:", e);
    }
}

// --- REGISTRY SEEDER ---
async function seedRegistry() {
    const systemWallets = ENV.userAddresses; 
    if (!systemWallets || systemWallets.length === 0) return;

    console.log(`🌱 Seeding Registry with ${systemWallets.length} system wallets from wallets.txt...`);

    for (const address of systemWallets) {
        if (!address || !address.startsWith('0x')) continue;

        const normalized = address.toLowerCase();
        try {
            const exists = await Registry.findOne({ address: { $regex: new RegExp(`^${normalized}$`, "i") } });

            if (!exists) {
                await Registry.create({
                    address: normalized,
                    listedBy: 'SYSTEM',
                    listedAt: new Date().toISOString(),
                    isSystem: true,
                    tags: ['OFFICIAL', 'WHALE'],
                    winRate: 0,
                    totalPnl: 0,
                    tradesLast30d: 0,
                    followers: 0,
                    copyCount: 0,
                    copyProfitGenerated: 0
                });
                console.log(`   + Added ${normalized.slice(0,8)}...`);
            } else if (!exists.isSystem) {
                exists.isSystem = true;
                if (!exists.tags?.includes('OFFICIAL')) {
                    exists.tags = [...(exists.tags || []), 'OFFICIAL'];
                }
                await exists.save();
                console.log(`   ^ Upgraded ${normalized.slice(0,8)}... to Official`);
            }
        } catch(e) {
            console.warn(`Failed to seed ${normalized}:`, e);
        }
    }
    
    await registryAnalytics.updateAllRegistryStats();
}

// --- BOOTSTRAP ---
const server = app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🌍 Bet Mirror Server running on port ${PORT}`);
});

connectDB()
    .then(async () => {
        console.log("✅ DB Connected. Syncing system...");
        await seedRegistry(); 
        restoreBots();
    })
    .catch((err) => {
        console.error("❌ CRITICAL: DB Connection Failed. " + err.message);
    });