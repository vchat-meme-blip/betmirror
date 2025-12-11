import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService } from '../services/fund-manager.service.js';
import { BotLog } from '../database/index.js';
import { PolymarketAdapter } from '../adapters/polymarket/polymarket.adapter.js';
// Define the correct USDC.e address on Polygon
const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
export class BotEngine {
    constructor(config, registryService, callbacks) {
        this.config = config;
        this.registryService = registryService;
        this.callbacks = callbacks;
        this.isRunning = false;
        this.activePositions = [];
        this.stats = {
            totalPnl: 0, totalVolume: 0, totalFeesPaid: 0, winRate: 0, tradesCount: 0, allowanceApproved: false
        };
        if (config.activePositions)
            this.activePositions = config.activePositions;
        if (config.stats)
            this.stats = config.stats;
    }
    async addLog(type, message) {
        try {
            await BotLog.create({ userId: this.config.userId, type, message, timestamp: new Date() });
        }
        catch (e) {
            console.error("Log failed", e);
        }
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        try {
            await this.addLog('info', '🚀 Starting Engine...');
            const engineLogger = {
                info: (m) => { console.log(m); this.addLog('info', m); },
                warn: (m) => { console.warn(m); this.addLog('warn', m); },
                error: (m, e) => { console.error(m, e); this.addLog('error', m); },
                debug: () => { },
                success: (m) => { console.log(`✅ ${m}`); this.addLog('success', m); }
            };
            this.exchange = new PolymarketAdapter({
                rpcUrl: this.config.rpcUrl,
                walletConfig: this.config.walletConfig,
                userId: this.config.userId,
                l2ApiCredentials: this.config.l2ApiCredentials,
                builderApiKey: this.config.builderApiKey,
                builderApiSecret: this.config.builderApiSecret,
                builderApiPassphrase: this.config.builderApiPassphrase,
                mongoEncryptionKey: this.config.mongoEncryptionKey
            }, engineLogger);
            await this.exchange.initialize();
            // --- STEP 2: CHECK FUNDING (Non-Blocking) ---
            const isFunded = await this.checkFunding();
            if (!isFunded) {
                await this.addLog('warn', '💰 Account Empty (Checking USDC.e). Engine standby. Waiting for deposit...');
                this.startFundWatcher();
                return;
            }
            await this.proceedWithPostFundingSetup(engineLogger);
        }
        catch (e) {
            console.error(e);
            await this.addLog('error', `Startup Failed: ${e.message}`);
            this.isRunning = false;
        }
    }
    async checkFunding() {
        try {
            if (!this.exchange)
                return false;
            const funderAddr = this.exchange.getFunderAddress();
            if (!funderAddr)
                return false;
            const balance = await this.exchange.fetchBalance(funderAddr);
            console.log(`💰 Funding Check for ${funderAddr}: ${balance}`);
            return balance >= 0.1;
        }
        catch (e) {
            console.error(e);
            return false;
        }
    }
    startFundWatcher() {
        if (this.fundWatcher)
            clearInterval(this.fundWatcher);
        this.fundWatcher = setInterval(async () => {
            if (!this.isRunning) {
                clearInterval(this.fundWatcher);
                return;
            }
            const funded = await this.checkFunding();
            if (funded) {
                clearInterval(this.fundWatcher);
                this.fundWatcher = undefined;
                await this.addLog('success', '💰 Funds detected. Resuming startup...');
                const engineLogger = {
                    info: (m) => { console.log(m); this.addLog('info', m); },
                    warn: (m) => { console.warn(m); this.addLog('warn', m); },
                    error: (m, e) => { console.error(m, e); this.addLog('error', m); },
                    debug: () => { },
                    success: (m) => { console.log(`✅ ${m}`); this.addLog('success', m); }
                };
                await this.proceedWithPostFundingSetup(engineLogger);
            }
        }, 30000);
    }
    async proceedWithPostFundingSetup(logger) {
        try {
            if (!this.exchange)
                return;
            // 1. Ensure Deployed
            await this.exchange.validatePermissions();
            // 2. Authenticate (Handshake) & APPROVE ALLOWANCE
            await this.exchange.authenticate();
            // 3. Start Services
            this.startServices(logger);
        }
        catch (e) {
            console.error(e);
            await this.addLog('error', `Setup Failed: ${e.message}`);
            this.isRunning = false;
        }
    }
    async startServices(logger) {
        if (!this.exchange)
            return;
        const runtimeEnv = {
            tradeMultiplier: this.config.multiplier,
            usdcContractAddress: USDC_BRIDGED_POLYGON,
            adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET,
            enableNotifications: this.config.enableNotifications,
            userPhoneNumber: this.config.userPhoneNumber,
            twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
            twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
            twilioFromNumber: process.env.TWILIO_FROM_NUMBER
        };
        // EXECUTOR - Uses Adapter
        const funder = this.exchange.getFunderAddress();
        if (!funder) {
            throw new Error("Adapter initialization incomplete. Missing funder address.");
        }
        this.executor = new TradeExecutorService({
            adapter: this.exchange,
            proxyWallet: funder,
            env: runtimeEnv,
            logger: logger
        });
        this.stats.allowanceApproved = true;
        // FUND MANAGER - Uses Adapter
        const fundManager = new FundManagerService(this.exchange, funder, {
            enabled: this.config.autoCashout?.enabled || false,
            maxRetentionAmount: this.config.autoCashout?.maxAmount,
            destinationAddress: this.config.autoCashout?.destinationAddress,
        }, logger, new NotificationService(runtimeEnv, logger));
        try {
            const cashout = await fundManager.checkAndSweepProfits();
            if (cashout && this.callbacks?.onCashout)
                await this.callbacks.onCashout(cashout);
        }
        catch (e) { }
        // MONITOR - Uses Adapter
        this.monitor = new TradeMonitorService({
            adapter: this.exchange,
            env: { ...runtimeEnv, fetchIntervalSeconds: 2, aggregationWindowSeconds: 300 },
            logger: logger,
            userAddresses: this.config.userAddresses,
            onDetectedTrade: async (signal) => {
                if (!this.isRunning)
                    return;
                // --- NEW: SELL VALIDATION CHECK ---
                if (signal.side === 'SELL') {
                    // Check if we actually hold this position before trying to sell it
                    // Matches on TokenID (most accurate) or MarketID + Outcome
                    const hasPosition = this.activePositions.some(p => p.tokenId === signal.tokenId);
                    if (!hasPosition) {
                        // Silent info log to avoid spamming the user with errors
                        await this.addLog('info', `⏭️ Skipping SELL signal (No active position for ${signal.outcome} in ${signal.marketId.slice(0, 6)}...)`);
                        return;
                    }
                }
                const geminiKey = this.config.geminiApiKey || process.env.GEMINI_API_KEY;
                let shouldTrade = true;
                let reason = "AI Disabled";
                let score = 0;
                if (geminiKey) {
                    await this.addLog('info', `[SIGNAL] ${signal.side} ${signal.outcome} @ ${signal.price}`);
                    const analysis = await aiAgent.analyzeTrade(`Market: ${signal.marketId}`, signal.side, signal.outcome, signal.sizeUsd, signal.price, this.config.riskProfile, geminiKey);
                    shouldTrade = analysis.shouldCopy;
                    reason = analysis.reasoning;
                    score = analysis.riskScore;
                }
                if (shouldTrade && this.executor) {
                    await this.addLog('info', `⚡ Executing ${signal.side}...`);
                    const orderResult = await this.executor.copyTrade(signal);
                    if (typeof orderResult === 'number' && orderResult > 0) {
                        await this.addLog('success', `✅ Executed ${signal.marketId.slice(0, 6)}...`);
                        this.updateStats(signal, orderResult, reason, score);
                    }
                    else if (typeof orderResult === 'string' && orderResult !== "failed" && orderResult !== "skipped_small_size" && orderResult !== "skipped_dust" && orderResult !== "insufficient_funds") {
                        await this.addLog('success', `✅ Trade Filled (Order ID: ${orderResult})`);
                        this.updateStats(signal, signal.sizeUsd, reason, score);
                    }
                    else if (orderResult === "failed") {
                        await this.addLog('error', `❌ Trade Failed on Exchange`);
                    }
                }
            }
        });
        await this.monitor.start(this.config.startCursor);
        this.watchdogTimer = setInterval(() => this.checkAutoTp(), 10000);
        await this.addLog('success', '🟢 Engine Online. Watching markets...');
    }
    async updateStats(signal, size, reason, score) {
        if (signal.side === 'BUY') {
            this.activePositions.push({
                marketId: signal.marketId,
                tokenId: signal.tokenId,
                outcome: signal.outcome,
                entryPrice: signal.price,
                sizeUsd: size,
                timestamp: Date.now()
            });
        }
        // If SELL, we should remove or reduce the position?
        // Simple logic for now: If we sold, try to find and remove the matching position to keep state clean
        if (signal.side === 'SELL') {
            this.activePositions = this.activePositions.filter(p => p.tokenId !== signal.tokenId);
            if (this.callbacks?.onPositionsUpdate)
                await this.callbacks.onPositionsUpdate(this.activePositions);
        }
        else {
            // Only update DB on BUY (Add)
            if (this.callbacks?.onPositionsUpdate)
                await this.callbacks.onPositionsUpdate(this.activePositions);
        }
        this.stats.tradesCount = (this.stats.tradesCount || 0) + 1;
        this.stats.totalVolume = (this.stats.totalVolume || 0) + size;
        if (this.callbacks?.onTradeComplete) {
            await this.callbacks.onTradeComplete({
                id: Math.random().toString(36),
                timestamp: new Date().toISOString(),
                marketId: signal.marketId,
                outcome: signal.outcome,
                side: signal.side,
                size: signal.sizeUsd,
                executedSize: size,
                price: signal.price,
                status: 'CLOSED',
                aiReasoning: reason,
                riskScore: score
            });
        }
        if (this.callbacks?.onStatsUpdate)
            await this.callbacks.onStatsUpdate(this.stats);
    }
    async checkAutoTp() {
        if (!this.config.autoTp || !this.executor || !this.exchange || this.activePositions.length === 0)
            return;
        const positionsToCheck = [...this.activePositions];
        for (const pos of positionsToCheck) {
            try {
                const currentPrice = await this.exchange.getMarketPrice(pos.marketId, pos.tokenId);
                if (currentPrice > 0) {
                    const orderBook = await this.exchange.getOrderBook(pos.tokenId);
                    if (orderBook.bids && orderBook.bids.length > 0) {
                        const bestBid = orderBook.bids[0].price;
                        const gainPercent = ((bestBid - pos.entryPrice) / pos.entryPrice) * 100;
                        if (gainPercent >= this.config.autoTp) {
                            await this.addLog('success', `🎯 Auto TP Hit! ${pos.outcome} is up +${gainPercent.toFixed(1)}%`);
                            const success = await this.executor.executeManualExit(pos, bestBid);
                            if (success) {
                                this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                                if (this.callbacks?.onPositionsUpdate)
                                    await this.callbacks.onPositionsUpdate(this.activePositions);
                                const realPnl = pos.sizeUsd * (gainPercent / 100);
                                this.stats.totalPnl = (this.stats.totalPnl || 0) + realPnl;
                                if (this.callbacks?.onStatsUpdate)
                                    await this.callbacks.onStatsUpdate(this.stats);
                            }
                        }
                    }
                }
            }
            catch (e) {
                // Ignore
            }
        }
    }
    stop() {
        this.isRunning = false;
        if (this.monitor)
            this.monitor.stop();
        if (this.fundWatcher)
            clearInterval(this.fundWatcher);
        if (this.watchdogTimer)
            clearInterval(this.watchdogTimer);
        this.addLog('info', '🔴 Engine Stopped.');
    }
}
