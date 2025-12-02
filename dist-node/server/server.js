import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';
import { BotEngine } from './bot-engine.js';
import { connectDB, User, Registry, Trade, Feedback, BridgeTransaction, BotLog, DepositLog } from '../database/index.js';
import { loadEnv } from '../config/env.js';
import { DbRegistryService } from '../services/db-registry.service.js';
import { registryAnalytics } from '../services/registry-analytics.service.js';
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
const ACTIVE_BOTS = new Map();
app.use(cors());
// INCREASED LIMIT: Session keys are large strings
app.use(express.json({ limit: '10mb' }));
// --- STATIC FILES (For Production) ---
// This allows the Node server to serve the React app
const distPath = path.join(__dirname, '../../dist');
app.use(express.static(distPath));
// --- HELPER: Start Bot Instance ---
async function startUserBot(userId, config) {
    // Ensure lowercase ID
    const normId = userId.toLowerCase();
    if (ACTIVE_BOTS.has(normId)) {
        ACTIVE_BOTS.get(normId)?.stop();
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
            // Save Trade to separate collection
            await Trade.create({
                userId: normId,
                marketId: trade.marketId,
                outcome: trade.outcome,
                side: trade.side,
                size: trade.size,
                executedSize: trade.executedSize || 0, // Save actual size
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
            // Find the lister and increment their stats
            const lister = await Registry.findOne({ address: { $regex: new RegExp(`^${event.listerAddress}$`, "i") } });
            if (lister) {
                lister.copyCount = (lister.copyCount || 0) + 1;
                lister.copyProfitGenerated = (lister.copyProfitGenerated || 0) + event.profitAmount;
                await lister.save();
            }
        }
    });
    ACTIVE_BOTS.set(normId, engine);
    await engine.start();
}
// --- SYSTEM: Registry Seeder ---
// Ensures wallets in .env are listed as "Official" in the Marketplace
async function seedOfficialWallets() {
    console.log('🌱 Seeding Official Wallets from Env...');
    const officials = ENV.userAddresses; // From .env
    for (const address of officials) {
        if (!address || address.length < 10)
            continue;
        try {
            // Upsert (Insert or Update)
            await Registry.findOneAndUpdate({ address: { $regex: new RegExp(`^${address}$`, "i") } }, {
                address: address,
                isVerified: true,
                isSystem: true,
                listedBy: 'SYSTEM',
                tags: ['OFFICIAL', 'WHALE'],
                $setOnInsert: {
                    listedAt: new Date().toISOString(),
                    winRate: 0,
                    totalPnl: 0
                }
            }, { upsert: true });
        }
        catch (e) {
            console.error(`Failed to seed ${address}`, e);
        }
    }
    console.log(`✅ Seeded ${officials.length} official wallets.`);
    // Trigger initial analytics run
    registryAnalytics.updateAllRegistryStats();
}
// --- API ROUTES ---
// 0. Health Check (For Sliplane/AWS/Docker)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        activeBots: ACTIVE_BOTS.size,
        timestamp: new Date().toISOString()
    });
});
// 1. Check Status / Init
app.post('/api/wallet/status', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        res.status(400).json({ error: 'User Address required' });
        return;
    }
    const normId = userId.toLowerCase();
    try {
        const user = await User.findOne({ address: normId });
        if (!user || !user.proxyWallet) {
            res.json({ status: 'NEEDS_ACTIVATION' });
        }
        else {
            res.json({
                status: 'ACTIVE',
                address: user.proxyWallet.address,
                type: 'SMART_ACCOUNT'
            });
        }
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'DB Error' });
    }
});
// 2. Activate Smart Account
app.post('/api/wallet/activate', async (req, res) => {
    console.log(`[ACTIVATION REQUEST] Received payload for user: ${req.body?.userId}`);
    const { userId, serializedSessionKey, smartAccountAddress } = req.body;
    if (!userId || !serializedSessionKey || !smartAccountAddress) {
        console.error('[ACTIVATION ERROR] Missing fields:', { userId, hasKey: !!serializedSessionKey, hasAddress: !!smartAccountAddress });
        res.status(400).json({ error: 'Missing activation parameters' });
        return;
    }
    const normId = userId.toLowerCase();
    const walletConfig = {
        type: 'SMART_ACCOUNT',
        address: smartAccountAddress,
        serializedSessionKey: serializedSessionKey,
        ownerAddress: normId,
        createdAt: new Date().toISOString()
    };
    try {
        await User.findOneAndUpdate({ address: normId }, { proxyWallet: walletConfig }, { upsert: true, new: true });
        console.log(`[ACTIVATION SUCCESS] Smart Account Activated: ${smartAccountAddress} (Owner: ${normId})`);
        res.json({ success: true, address: smartAccountAddress });
    }
    catch (e) {
        console.error("[ACTIVATION DB ERROR]", e);
        res.status(500).json({ error: e.message || 'Failed to activate' });
    }
});
// 3. Global Stats & Builder Data
app.get('/api/stats/global', async (req, res) => {
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
        let builderStats = null;
        let leaderboard = [];
        let ecosystemVolume = 0;
        const myBuilderId = ENV.builderId || 'BetMirror';
        try {
            // Fetch Global Leaderboard (Top 50)
            // Reduced limit to 50 for cleaner chart
            const lbUrl = `https://data-api.polymarket.com/v1/builders/leaderboard?timePeriod=ALL&limit=50`;
            const lbResponse = await axios.get(lbUrl, { timeout: 4000 });
            if (Array.isArray(lbResponse.data)) {
                leaderboard = lbResponse.data;
                // 1. Calculate Total Ecosystem Volume from top 50
                ecosystemVolume = leaderboard.reduce((acc, curr) => acc + (curr.volume || 0), 0);
                // 2. Find OUR Builder Profile in the haystack
                const myEntry = leaderboard.find(b => b.builder.toLowerCase() === myBuilderId.toLowerCase());
                if (myEntry) {
                    builderStats = myEntry;
                }
                else {
                    // Not ranked yet. Return empty shell so frontend knows we checked.
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
        }
        catch (e) {
            console.warn("Failed to fetch external builder stats:", e instanceof Error ? e.message : 'Unknown');
            // Fallback if API fails
            builderStats = { builder: myBuilderId, rank: 'Error', volume: 0, activeUsers: 0, verified: false };
        }
        res.json({
            internal: {
                totalUsers: userCount,
                signalVolume: signalVolume, // Whale Volume
                executedVolume: executedVolume, // Bot Volume
                totalTrades: internalTrades,
                totalRevenue,
                totalLiquidity,
                activeBots: ACTIVE_BOTS.size
            },
            builder: {
                current: builderStats,
                history: leaderboard, // Return whatever we got (max 50)
                builderId: myBuilderId,
                ecosystemVolume
            }
        });
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Stats Error' });
    }
});
// 4. Feedback
app.post('/api/feedback', async (req, res) => {
    const { userId, rating, comment } = req.body;
    try {
        await Feedback.create({ userId: userId.toLowerCase(), rating, comment });
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: 'Failed' });
    }
});
// 5. Start Bot
app.post('/api/bot/start', async (req, res) => {
    const { userId, userAddresses, rpcUrl, geminiApiKey, multiplier, riskProfile, autoTp, notifications, autoCashout } = req.body;
    if (!userId) {
        res.status(400).json({ error: 'Missing userId' });
        return;
    }
    const normId = userId.toLowerCase();
    try {
        const user = await User.findOne({ address: normId });
        if (!user || !user.proxyWallet) {
            res.status(400).json({ error: 'Bot Wallet not activated.' });
            return;
        }
        // Inject saved L2 credentials if they exist
        // This allows session continuity without re-generating keys on every start
        const l2Creds = user.proxyWallet.l2ApiCredentials;
        const config = {
            userId: normId,
            walletConfig: user.proxyWallet,
            userAddresses: Array.isArray(userAddresses) ? userAddresses : userAddresses.split(',').map((s) => s.trim()),
            rpcUrl,
            geminiApiKey, // Explicit user-provided key
            multiplier: Number(multiplier),
            riskProfile,
            autoTp: autoTp ? Number(autoTp) : undefined,
            enableNotifications: notifications?.enabled,
            userPhoneNumber: notifications?.phoneNumber,
            autoCashout: autoCashout,
            activePositions: user.activePositions || [],
            stats: user.stats,
            zeroDevRpc: process.env.ZERODEV_RPC,
            l2ApiCredentials: l2Creds, // Pass Credentials to Engine
            startCursor: Math.floor(Date.now() / 1000)
        };
        await startUserBot(normId, config);
        user.activeBotConfig = config;
        user.isBotRunning = true;
        await user.save();
        res.json({ success: true, status: 'RUNNING' });
    }
    catch (e) {
        console.error("Failed to start bot:", e);
        res.status(500).json({ error: e.message });
    }
});
// 6. Stop Bot
app.post('/api/bot/stop', async (req, res) => {
    const { userId } = req.body;
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    if (engine)
        engine.stop();
    await User.updateOne({ address: normId }, { isBotRunning: false });
    res.json({ success: true, status: 'STOPPED' });
});
// 7. Bot Status & Logs
app.get('/api/bot/status/:userId', async (req, res) => {
    const { userId } = req.params;
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    try {
        const tradeHistory = await Trade.find({ userId: normId }).sort({ timestamp: -1 }).limit(50).lean();
        const user = await User.findOne({ address: normId }).lean();
        // Fetch Logs from DB instead of memory to ensure persistence across restarts
        const dbLogs = await BotLog.find({ userId: normId }).sort({ timestamp: -1 }).limit(100).lean();
        const formattedLogs = dbLogs.map(l => ({
            id: l._id.toString(),
            time: l.timestamp.toLocaleTimeString(),
            type: l.type,
            message: l.message
        }));
        const historyUI = tradeHistory.map((t) => ({
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
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
// 8. Registry Routes
app.get('/api/registry', async (req, res) => {
    try {
        // Sort System wallets first, then high winrate
        const list = await Registry.find().sort({ isSystem: -1, winRate: -1 }).lean();
        res.json(list);
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
app.get('/api/registry/:address', async (req, res) => {
    const { address } = req.params;
    try {
        const profile = await Registry.findOne({ address: { $regex: new RegExp(`^${address}$`, "i") } }).lean();
        if (!profile)
            return res.status(404).json({ error: 'Not found' });
        res.json(profile);
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
app.post('/api/registry', async (req, res) => {
    const { address, listedBy } = req.body;
    if (!address || !address.startsWith('0x')) {
        res.status(400).json({ error: 'Invalid address' });
        return;
    }
    try {
        const existing = await Registry.findOne({ address: { $regex: new RegExp(`^${address}$`, "i") } });
        if (existing) {
            res.status(409).json({ error: 'Already listed', profile: existing });
            return;
        }
        const profile = await Registry.create({
            address,
            listedBy: listedBy.toLowerCase(),
            listedAt: new Date().toISOString(),
            winRate: 0, totalPnl: 0, tradesLast30d: 0, followers: 0, copyCount: 0, copyProfitGenerated: 0
        });
        // Trigger background update for new listing
        registryAnalytics.analyzeWallet(address);
        res.json({ success: true, profile });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// PROXY: Get raw trades for modal (frontend calls this)
app.get('/api/proxy/trades/:address', async (req, res) => {
    const { address } = req.params;
    try {
        const url = `https://data-api.polymarket.com/trades?user=${address}&limit=50`;
        const response = await axios.get(url);
        res.json(response.data);
    }
    catch (e) {
        res.status(500).json({ error: "Failed to fetch trades from Polymarket" });
    }
});
// 9. Bridge Routes
app.get('/api/bridge/history/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const history = await BridgeTransaction.find({ userId: userId.toLowerCase() }).sort({ timestamp: -1 }).lean();
        res.json(history.map((h) => ({ ...h, id: h.bridgeId })));
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
app.post('/api/bridge/record', async (req, res) => {
    const { userId, transaction } = req.body;
    if (!userId || !transaction) {
        res.status(400).json({ error: 'Missing Data' });
        return;
    }
    const normId = userId.toLowerCase();
    try {
        await BridgeTransaction.findOneAndUpdate({ userId: normId, bridgeId: transaction.id }, {
            userId: normId,
            bridgeId: transaction.id,
            ...transaction
        }, { upsert: true });
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
// 10. Direct Deposit Record (for stats)
app.post('/api/deposit/record', async (req, res) => {
    const { userId, amount, txHash } = req.body;
    if (!userId || !amount || !txHash) {
        res.status(400).json({ error: 'Missing Data' });
        return;
    }
    try {
        await DepositLog.create({
            userId: userId.toLowerCase(),
            amount: Number(amount),
            txHash
        });
        res.json({ success: true });
    }
    catch (e) {
        // Duplicate key error means already recorded
        res.json({ success: true, exists: true });
    }
});
// --- SPA Fallback ---
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
                // Pass stored L2 creds to engine during restore
                const l2Creds = user.proxyWallet.l2ApiCredentials;
                const config = {
                    ...user.activeBotConfig,
                    walletConfig: user.proxyWallet,
                    stats: user.stats,
                    activePositions: user.activePositions,
                    startCursor: lastTime,
                    l2ApiCredentials: l2Creds
                };
                await startUserBot(user.address, config);
                console.log(`✅ Restored Bot: ${user.address}`);
            }
        }
    }
    catch (e) {
        console.error("Restore failed:", e);
    }
}
connectDB(ENV.mongoUri).then(async () => {
    // Seed system wallets first
    await seedOfficialWallets();
    // Start Registry Analytics Loop (Every 15 mins)
    setInterval(() => registryAnalytics.updateAllRegistryStats(), 15 * 60 * 1000);
    app.listen(PORT, () => {
        console.log(`🌍 Bet Mirror Cloud Server running on port ${PORT}`);
        restoreBots();
    });
});
