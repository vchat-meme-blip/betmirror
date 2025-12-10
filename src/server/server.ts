
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';
import { BotEngine, BotConfig } from './bot-engine.js';
import { ProxyWalletConfig } from '../domain/wallet.types.js';
import { connectDB, User, Registry, Trade, Feedback, BridgeTransaction, BotLog, DepositLog } from '../database/index.js';
import { loadEnv } from '../config/env.js';
import { DbRegistryService } from '../services/db-registry.service.js';
import { registryAnalytics } from '../services/registry-analytics.service.js';
import { BuilderVolumeData } from '../domain/alpha.types.js';
import axios from 'axios';

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ENV = loadEnv();

// Service Singletons
const dbRegistryService = new DbRegistryService();

// In-Memory Bot Instances (Runtime State)
const ACTIVE_BOTS = new Map<string, BotEngine>();

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

    // --- CRITICAL CHECK ---
    // If the user hasn't migrated to the new Session Key system (EOA Signer),
    // we cannot start the bot. Skip it to avoid "Missing Private Key" crash loops.
    if (config.walletConfig?.type === 'SMART_ACCOUNT' && !config.walletConfig.sessionPrivateKey) {
        console.warn(`[SKIP] Bot ${normId} skipped. Requires 'RESTORE SESSION' to generate new keys.`);
        return;
    }

    const startCursor = config.startCursor || Math.floor(Date.now() / 1000);
    const engineConfig = { ...config, userId: normId, startCursor };

    const engine = new BotEngine(engineConfig, dbRegistryService, {
        onPositionsUpdate: async (positions) => {
            await User.updateOne({ address: normId }, { activePositions: positions });
        },
        onCashout: async (record) => {
            await User.updateOne({ address: normId }, { $push: { cashoutHistory: record } });
        },
        onTradeComplete: async (trade) => {
            await Trade.create({
                userId: normId,
                marketId: trade.marketId,
                outcome: trade.outcome,
                side: trade.side,
                size: trade.size,
                executedSize: (trade as any).executedSize || 0,
                price: trade.price,
                pnl: trade.pnl,
                status: trade.status,
                txHash: trade.txHash,
                aiReasoning: trade.aiReasoning,
                riskScore: trade.riskScore,
                timestamp: trade.timestamp
            });
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
    // Non-blocking start
    engine.start().catch(err => console.error(`[Bot Error] ${normId}:`, err.message));
}

// ... [Keep existing stats/registry/feedback routes identical] ...

// 0. Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
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
      const user = await User.findOne({ address: normId });
      
      // Check if user exists AND has the new session private key
      // If they have proxyWallet but NO private key, force re-activation
      if (!user || !user.proxyWallet) {
        res.json({ status: 'NEEDS_ACTIVATION' });
      } else if (user.proxyWallet.type === 'SMART_ACCOUNT' && !user.proxyWallet.sessionPrivateKey) {
         // Migration path for existing users
         res.json({ status: 'NEEDS_ACTIVATION', address: user.proxyWallet.address });
      } else {
        res.json({ 
            status: 'ACTIVE', 
            address: user.proxyWallet.address,
            type: 'SMART_ACCOUNT'
        });
      }
  } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'DB Error' });
  }
});

// 2. Activate Smart Account
app.post('/api/wallet/activate', async (req: any, res: any) => {
    console.log(`[ACTIVATION REQUEST] Received payload for user: ${req.body?.userId}`);
    
    // IMPORTANT: Receive sessionPrivateKey now
    const { userId, serializedSessionKey, smartAccountAddress, sessionPrivateKey } = req.body;
    
    if (!userId || !serializedSessionKey || !smartAccountAddress) { 
        console.error('[ACTIVATION ERROR] Missing fields:', { userId, hasKey: !!serializedSessionKey, hasAddress: !!smartAccountAddress });
        res.status(400).json({ error: 'Missing activation parameters' }); 
        return; 
    }
    const normId = userId.toLowerCase();

    const walletConfig: ProxyWalletConfig = {
        type: 'SMART_ACCOUNT',
        address: smartAccountAddress,
        serializedSessionKey: serializedSessionKey,
        sessionPrivateKey: sessionPrivateKey, // Save this!
        ownerAddress: normId,
        createdAt: new Date().toISOString()
    };

    try {
        await User.findOneAndUpdate(
            { address: normId },
            { proxyWallet: walletConfig },
            { upsert: true, new: true }
        );
        console.log(`[ACTIVATION SUCCESS] Smart Account Activated: ${smartAccountAddress} (Owner: ${normId})`);
        res.json({ success: true, address: smartAccountAddress });
    } catch (e: any) {
        console.error("[ACTIVATION DB ERROR]", e);
        res.status(500).json({ error: e.message || 'Failed to activate' });
    }
});

// 3. Global Stats & Builder Data
app.get('/api/stats/global', async (req: any, res: any) => {
    try {
        // Internal Stats (DB)
        const userCount = await User.countDocuments();
        const tradeAgg = await Trade.aggregate([
            { $group: { _id: null, signalVolume: { $sum: "$size" }, executedVolume: { $sum: "$executedSize" }, count: { $sum: 1 } } }
        ]);
        const signalVolume = tradeAgg[0]?.signalVolume || 0;
        const executedVolume = tradeAgg[0]?.executedVolume || 0;
        const internalTrades = tradeAgg[0]?.count || 0;

        // Platform Revenue (1% Fees)
        const revenueAgg = await User.aggregate([
            { $group: { _id: null, total: { $sum: "$stats.totalFeesPaid" } } }
        ]);
        const totalRevenue = revenueAgg[0]?.total || 0;

        // Total Liquidity (Bridged + Direct Deposits)
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

        // External Builder API Stats (Polymarket)
        let builderStats: BuilderVolumeData | null = null;
        let leaderboard: BuilderVolumeData[] = [];
        let ecosystemVolume = 0;
        const myBuilderId = ENV.builderId || 'BetMirror'; 

        try {
            // Fetch Global Leaderboard (Top 50)
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
  const { userId, userAddresses, rpcUrl, geminiApiKey, multiplier, riskProfile, autoTp, notifications, autoCashout } = req.body;
  
  if (!userId) { res.status(400).json({ error: 'Missing userId' }); return; }
  const normId = userId.toLowerCase();

  try {
      const user = await User.findOne({ address: normId });
      if (!user || !user.proxyWallet) { 
          res.status(400).json({ error: 'Bot Wallet not activated.' }); 
          return; 
      }

      // Check for missing key AGAIN - Double protection
      if (!user.proxyWallet.sessionPrivateKey && user.proxyWallet.type === 'SMART_ACCOUNT') {
          res.status(400).json({ error: "Session Key outdated. Please click 'RESTORE SESSION' to update." });
          return;
      }

      // --- EXTRACT L2 CREDENTIALS FROM DB ---
      // This is crucial for the "Use API Keys" step
      const l2Creds = user.proxyWallet.l2ApiCredentials;
      
      const config: BotConfig = {
        userId: normId,
        walletConfig: user.proxyWallet,
        userAddresses: Array.isArray(userAddresses) ? userAddresses : userAddresses.split(',').map((s: string) => s.trim()),
        rpcUrl,
        geminiApiKey,
        multiplier: Number(multiplier),
        riskProfile,
        autoTp: autoTp ? Number(autoTp) : undefined,
        enableNotifications: notifications?.enabled,
        userPhoneNumber: notifications?.phoneNumber,
        autoCashout: autoCashout,
        activePositions: user.activePositions || [],
        stats: user.stats,
        // PASS ENV VARS
        zeroDevRpc: ENV.zeroDevRpc,
        zeroDevPaymasterRpc: ENV.zeroDevPaymasterRpc,
        // PASS CREDENTIALS
        l2ApiCredentials: l2Creds,
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

        res.json({ 
            isRunning: engine ? engine.isRunning : (user?.isBotRunning || false),
            logs: formattedLogs,
            history: historyUI,
            stats: user?.stats || null,
            config: user?.activeBotConfig || null
        });
    } catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});

// 8. Registry Routes
app.get('/api/registry', async (req, res) => {
    try {
        const list = await Registry.find().sort({ isSystem: -1, winRate: -1 }).lean();
        res.json(list);
    } catch (e) { res.status(500).json({error: 'DB Error'}); }
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

app.post('/api/bridge/record', async (req, res) => {
    const { userId, transaction } = req.body;
    if (!userId || !transaction) { res.status(400).json({ error: 'Missing Data' }); return; }
    const normId = userId.toLowerCase();
    
    try {
        await BridgeTransaction.findOneAndUpdate(
            { userId: normId, bridgeId: transaction.id },
            { userId: normId, bridgeId: transaction.id, ...transaction },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});

// 10. Direct Deposit Record
app.post('/api/deposit/record', async (req, res) => {
    const { userId, amount, txHash } = req.body;
    if (!userId || !amount || !txHash) { res.status(400).json({ error: 'Missing Data' }); return; }
    
    try {
        await DepositLog.create({
            userId: userId.toLowerCase(),
            amount: Number(amount),
            txHash
        });
        res.json({ success: true });
    } catch (e) {
        res.json({ success: true, exists: true });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
});

// --- SYSTEM RESTORE ---
async function restoreBots() {
    console.log("🔄 Restoring Active Bots from Database...");
    try {
        const activeUsers = await User.find({ isBotRunning: true, activeBotConfig: { $exists: true } });
        console.log(`Found ${activeUsers.length} bots to restore.`);

        for (const user of activeUsers) {
            if (user.activeBotConfig && user.proxyWallet) {
                 const lastTrade = await Trade.findOne({ userId: user.address }).sort({ timestamp: -1 });
                 const lastTime = lastTrade ? Math.floor(lastTrade.timestamp.getTime() / 1000) + 1 : Math.floor(Date.now() / 1000) - 3600;

                 // Restore credentials specifically
                 const l2Creds = user.proxyWallet.l2ApiCredentials;

                 const config: BotConfig = {
                     ...user.activeBotConfig,
                     walletConfig: user.proxyWallet,
                     stats: user.stats,
                     activePositions: user.activePositions,
                     startCursor: lastTime,
                     l2ApiCredentials: l2Creds, // Pass restored creds
                     zeroDevRpc: ENV.zeroDevRpc,
                     zeroDevPaymasterRpc: ENV.zeroDevPaymasterRpc
                 };
                 
                 try {
                    await startUserBot(user.address, config);
                    console.log(`✅ Restored Bot: ${user.address} (Has L2 Creds: ${!!l2Creds})`);
                 } catch (err: any) {
                    console.error(`Bot Start Error: ${err.message}`);
                 }
            }
        }
    } catch (e) {
        console.error("Restore failed:", e);
    }
}

// ... [Connect DB and Listen] ...
connectDB(ENV.mongoUri).then(async () => {
    // await seedOfficialWallets(); // Optional
    registryAnalytics.updateAllRegistryStats(); 
    
    // Explicitly bind to 0.0.0.0 to fix Fly.io listener issue
    app.listen(Number(PORT), '0.0.0.0', () => {
        console.log(`🌍 Bet Mirror Cloud Server running on port ${PORT}`);
        restoreBots();
    });
});
