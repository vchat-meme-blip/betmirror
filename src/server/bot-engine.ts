
import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService } from '../services/fund-manager.service.js';
import { TradeHistoryEntry, ActivePosition } from '../domain/trade.types.js';
import { CashoutRecord, FeeDistributionEvent, IRegistryService } from '../domain/alpha.types.js';
import { UserStats } from '../domain/user.types.js';
import { ProxyWalletConfig, L2ApiCredentials } from '../domain/wallet.types.js'; 
import { BotLog, User } from '../database/index.js';
import { getMarket } from '../utils/fetch-data.util.js';
import { PolymarketAdapter } from '../adapters/polymarket/polymarket.adapter.js';
import { Logger } from '../utils/logger.util.js';

// Define the correct USDC.e address on Polygon
const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

export interface BotConfig {
    userId: string;
    privateKey?: string;
    walletConfig?: ProxyWalletConfig;
    userAddresses: string[];
    rpcUrl: string;
    geminiApiKey?: string;
    riskProfile: 'conservative' | 'balanced' | 'degen';
    multiplier: number;
    autoTp?: number;
    enableNotifications: boolean;
    userPhoneNumber?: string;
    autoCashout?: { enabled: boolean; maxAmount: number; destinationAddress: string; };
    activePositions?: ActivePosition[];
    stats?: UserStats;
    zeroDevRpc?: string;
    zeroDevPaymasterRpc?: string;
    l2ApiCredentials?: L2ApiCredentials;
    startCursor?: number;
    builderApiKey?: string;
    builderApiSecret?: string;
    builderApiPassphrase?: string;
}

export interface BotCallbacks {
    onCashout?: (record: CashoutRecord) => Promise<void>;
    onFeePaid?: (record: FeeDistributionEvent) => Promise<void>;
    onTradeComplete?: (trade: TradeHistoryEntry) => Promise<void>;
    onStatsUpdate?: (stats: UserStats) => Promise<void>;
    onPositionsUpdate?: (positions: ActivePosition[]) => Promise<void>;
}

export class BotEngine {
    public isRunning = false;
    private monitor?: TradeMonitorService;
    private executor?: TradeExecutorService;
    private exchange?: PolymarketAdapter;
    
    private fundWatcher?: NodeJS.Timeout;
    private watchdogTimer?: NodeJS.Timeout;
    private activePositions: ActivePosition[] = [];
    private stats: UserStats = {
        totalPnl: 0, totalVolume: 0, totalFeesPaid: 0, winRate: 0, tradesCount: 0, allowanceApproved: false
    };

    constructor(
        private config: BotConfig,
        private registryService: IRegistryService,
        private callbacks?: BotCallbacks
    ) {
        if (config.activePositions) this.activePositions = config.activePositions;
        if (config.stats) this.stats = config.stats;
    }

    private async addLog(type: 'info' | 'warn' | 'error' | 'success', message: string) {
        try {
            await BotLog.create({ userId: this.config.userId, type, message, timestamp: new Date() });
        } catch (e) { console.error("Log failed", e); }
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            await this.addLog('info', '🚀 Starting Engine...');

            const engineLogger: Logger = {
                info: (m: string) => { console.log(m); this.addLog('info', m); },
                warn: (m: string) => { console.warn(m); this.addLog('warn', m); },
                error: (m: string, e?: any) => { console.error(m, e); this.addLog('error', m); },
                debug: () => {},
                success: (m: string) => { console.log(`✅ ${m}`); this.addLog('success', m); }
            };

            this.exchange = new PolymarketAdapter({
                rpcUrl: this.config.rpcUrl,
                walletConfig: this.config.walletConfig!,
                userId: this.config.userId,
                l2ApiCredentials: this.config.l2ApiCredentials,
                zeroDevRpc: this.config.zeroDevRpc,
                zeroDevPaymasterRpc: this.config.zeroDevPaymasterRpc,
                builderApiKey: this.config.builderApiKey,
                builderApiSecret: this.config.builderApiSecret,
                builderApiPassphrase: this.config.builderApiPassphrase
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

        } catch (e: any) {
            console.error(e);
            await this.addLog('error', `Startup Failed: ${e.message}`);
            this.isRunning = false;
        }
    }

    private async checkFunding(): Promise<boolean> {
        try {
            if(!this.exchange) return false;
            const funderAddr = this.exchange.getFunderAddress();
            if (!funderAddr) return false;
            const balance = await this.exchange.fetchBalance(funderAddr);
            console.log(`💰 Funding Check for ${funderAddr}: ${balance}`);
            return balance >= 0.1; 
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    private startFundWatcher() {
        if (this.fundWatcher) clearInterval(this.fundWatcher);
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
                const engineLogger: Logger = {
                    info: (m: string) => { console.log(m); this.addLog('info', m); },
                    warn: (m: string) => { console.warn(m); this.addLog('warn', m); },
                    error: (m: string, e?: any) => { console.error(m, e); this.addLog('error', m); },
                    debug: () => {},
                    success: (m: string) => { console.log(`✅ ${m}`); this.addLog('success', m); }
                };
                await this.proceedWithPostFundingSetup(engineLogger);
            }
        }, 30000); 
    }

    private async proceedWithPostFundingSetup(logger: Logger) {
        try {
            if(!this.exchange) return;

            // 1. Ensure Deployed
            await this.exchange.validatePermissions();

            // 2. Authenticate (Handshake) & APPROVE ALLOWANCE
            // If allowance fails, this throws, stopping the bot.
            await this.exchange.authenticate();

            // 3. Start Services
            this.startServices(logger);

        } catch (e: any) {
            console.error(e);
            await this.addLog('error', `Setup Failed: ${e.message}`);
            this.isRunning = false; 
        }
    }

    private async startServices(logger: Logger) {
        if(!this.exchange) return;

        const runtimeEnv: any = {
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
        const fundManager = new FundManagerService(
            this.exchange,
            funder,
            {
                enabled: this.config.autoCashout?.enabled || false,
                maxRetentionAmount: this.config.autoCashout?.maxAmount,
                destinationAddress: this.config.autoCashout?.destinationAddress,
            },
            logger,
            new NotificationService(runtimeEnv, logger)
        );

        try {
            const cashout = await fundManager.checkAndSweepProfits();
            if (cashout && this.callbacks?.onCashout) await this.callbacks.onCashout(cashout);
        } catch(e) {}

        // MONITOR - Uses Adapter
        this.monitor = new TradeMonitorService({
            adapter: this.exchange,
            env: { ...runtimeEnv, fetchIntervalSeconds: 2, aggregationWindowSeconds: 300 },
            logger: logger,
            userAddresses: this.config.userAddresses,
            onDetectedTrade: async (signal) => {
                if (!this.isRunning) return;
                
                const geminiKey = this.config.geminiApiKey || process.env.GEMINI_API_KEY;
                let shouldTrade = true;
                let reason = "AI Disabled";
                let score = 0;

                if (geminiKey) {
                    await this.addLog('info', `[SIGNAL] ${signal.side} ${signal.outcome} @ ${signal.price}`);
                    const analysis = await aiAgent.analyzeTrade(
                        `Market: ${signal.marketId}`,
                        signal.side,
                        signal.outcome,
                        signal.sizeUsd,
                        signal.price,
                        this.config.riskProfile,
                        geminiKey
                    );
                    shouldTrade = analysis.shouldCopy;
                    reason = analysis.reasoning;
                    score = analysis.riskScore;
                }

                if (shouldTrade && this.executor) {
                    await this.addLog('info', `⚡ Executing ${signal.side}...`);
                    const orderResult = await this.executor.copyTrade(signal);
                    
                    // Check if order returned a valid ID (not 0/failed)
                    if (typeof orderResult === 'number' && orderResult > 0) {
                        // Legacy handling where executor returns size
                        await this.addLog('success', `✅ Executed ${signal.marketId.slice(0,6)}...`);
                        this.updateStats(signal, orderResult, reason, score);
                    } else if (typeof orderResult === 'string' && orderResult !== "failed" && orderResult !== "skipped_small_size") {
                        // New handling where executor returns Order ID
                        await this.addLog('success', `✅ Trade Filled (Order ID: ${orderResult})`);
                        // Assume signal size was filled for now in stats, ideally we'd fetch fill details
                        this.updateStats(signal, signal.sizeUsd, reason, score);
                    } else if (orderResult === "failed") {
                        await this.addLog('error', `❌ Trade Failed on Exchange`);
                    }
                }
            }
        });

        await this.monitor.start(this.config.startCursor);
        this.watchdogTimer = setInterval(() => this.checkAutoTp(), 10000) as unknown as NodeJS.Timeout;

        await this.addLog('success', '🟢 Engine Online. Watching markets...');
    }

    private async updateStats(signal: any, size: number, reason: string, score: number) {
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
        if(this.callbacks?.onStatsUpdate) await this.callbacks.onStatsUpdate(this.stats);
    }

    private async checkAutoTp() {
        if (!this.config.autoTp || !this.executor || !this.exchange || this.activePositions.length === 0) return;
        
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
                                if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);
                                
                                const realPnl = pos.sizeUsd * (gainPercent / 100);
                                this.stats.totalPnl = (this.stats.totalPnl || 0) + realPnl;
                                if(this.callbacks?.onStatsUpdate) await this.callbacks.onStatsUpdate(this.stats);
                            }
                        }
                    }
                }
            } catch (e: any) { 
                 // Ignore
            }
        }
    }

    public stop() {
        this.isRunning = false;
        if (this.monitor) this.monitor.stop();
        if (this.fundWatcher) clearInterval(this.fundWatcher);
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        this.addLog('info', '🔴 Engine Stopped.');
    }
}
