
import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService, ExecutionResult } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService } from '../services/fund-manager.service.js';
import { PortfolioService } from '../services/portfolio.service.js';
import { TradeHistoryEntry, ActivePosition, TradeSignal } from '../domain/trade.types.js';
import { CashoutRecord, FeeDistributionEvent, IRegistryService } from '../domain/alpha.types.js';
import { UserStats } from '../domain/user.types.js';
import { TradingWalletConfig, L2ApiCredentials } from '../domain/wallet.types.js'; 
import { BotLog, User, Trade } from '../database/index.js';
import { PolymarketAdapter } from '../adapters/polymarket/polymarket.adapter.js';
import { Logger } from '../utils/logger.util.js';
import { FeeDistributorService } from '../services/fee-distributor.service.js';
import { EvmWalletService } from '../services/evm-wallet.service.js';
import { TOKENS } from '../config/env.js';
import { registryAnalytics } from '../services/registry-analytics.service.js';
import { MarketMakingScanner, MarketOpportunity } from '../services/arbitrage-scanner.js';
import { ArbitrageOpportunity } from '../adapters/interfaces.js';
import crypto from 'crypto';

export interface BotConfig {
    userId: string;
    walletConfig?: TradingWalletConfig;
    userAddresses: string[];
    rpcUrl: string;
    geminiApiKey?: string;
    riskProfile: 'conservative' | 'balanced' | 'degen';
    multiplier: number;
    minLiquidityFilter?: 'HIGH' | 'MEDIUM' | 'LOW'; 
    autoTp?: number;
    enableNotifications: boolean;
    userPhoneNumber?: string;
    autoCashout?: { enabled: boolean; maxAmount: number; destinationAddress: string; };
    enableAutoCashout?: boolean; // Legacy compat
    maxRetentionAmount?: number; // Legacy compat
    coldWalletAddress?: string; // Legacy compat
    enableAutoArb?: boolean;
    activePositions?: ActivePosition[];
    stats?: UserStats;
    l2ApiCredentials?: L2ApiCredentials;
    startCursor?: number;
    builderApiKey?: string;
    builderApiSecret?: string;
    builderApiPassphrase?: string;
    mongoEncryptionKey: string;
    maxTradeAmount?: number;
}

export interface BotCallbacks {
    onCashout?: (record: CashoutRecord) => Promise<void>;
    onFeePaid?: (record: FeeDistributionEvent) => Promise<void>;
    onTradeComplete?: (trade: TradeHistoryEntry) => Promise<void>;
    onStatsUpdate?: (stats: UserStats) => Promise<void>;
    onPositionsUpdate?: (positions: ActivePosition[]) => Promise<void>;
    onArbUpdate?: (opportunities: ArbitrageOpportunity[]) => Promise<void>;
}

export class BotEngine {
    public isRunning = false;
    private monitor?: TradeMonitorService;
    private executor?: TradeExecutorService;
    private arbScanner?: MarketMakingScanner;
    private exchange?: PolymarketAdapter;
    private portfolioService?: PortfolioService;
    private runtimeEnv: any;
    
    private fundWatcher?: NodeJS.Timeout;
    private activePositions: ActivePosition[] = [];
    private stats: UserStats = {
        totalPnl: 0, 
        totalVolume: 0, 
        totalFeesPaid: 0, 
        winRate: 0, 
        tradesCount: 0, 
        winCount: 0, 
        lossCount: 0, 
        allowanceApproved: false,
        portfolioValue: 0,
        cashBalance: 0
    };

    private lastPositionSync = 0;
    private readonly POSITION_SYNC_INTERVAL = 30000;

    constructor(
        private config: BotConfig,
        private registryService: IRegistryService,
        private callbacks?: BotCallbacks
    ) {
        if (config.activePositions) this.activePositions = config.activePositions;
        if (config.stats) this.stats = config.stats;
    }

    public getAdapter(): PolymarketAdapter | undefined {
        return this.exchange;
    }

    private async addLog(type: 'info' | 'warn' | 'error' | 'success', message: string) {
        try {
            await BotLog.create({ userId: this.config.userId, type, message, timestamp: new Date() } as any);
        } catch (e) { console.error("Log failed", e); }
    }

    public updateConfig(newConfig: Partial<BotConfig>) {
        if (newConfig.userAddresses && this.monitor) {
            this.monitor.updateTargets(newConfig.userAddresses);
            this.config.userAddresses = newConfig.userAddresses;
        }

        if (newConfig.multiplier !== undefined) {
            this.config.multiplier = newConfig.multiplier;
            if (this.runtimeEnv) this.runtimeEnv.tradeMultiplier = newConfig.multiplier;
        }

        if (newConfig.maxTradeAmount !== undefined) {
            this.config.maxTradeAmount = newConfig.maxTradeAmount;
            if (this.runtimeEnv) this.runtimeEnv.maxTradeAmount = newConfig.maxTradeAmount;
        }

        if (newConfig.minLiquidityFilter !== undefined) {
            this.config.minLiquidityFilter = newConfig.minLiquidityFilter;
            if (this.runtimeEnv) this.runtimeEnv.minLiquidityFilter = newConfig.minLiquidityFilter;
        }

        if (newConfig.geminiApiKey !== undefined) {
            this.config.geminiApiKey = newConfig.geminiApiKey;
        }

        if (newConfig.riskProfile !== undefined) this.config.riskProfile = newConfig.riskProfile;
        if (newConfig.autoTp !== undefined) this.config.autoTp = newConfig.autoTp;
        
        if (newConfig.autoCashout) {
            this.config.autoCashout = newConfig.autoCashout;
        }
        if (newConfig.enableAutoArb !== undefined) {
            this.config.enableAutoArb = newConfig.enableAutoArb;
        } 
    }

    private async updateMarketState(position: ActivePosition): Promise<void> {
        if (!this.exchange) return;
        
        try {
            const client = (this.exchange as any).getRawClient?.();
            if (client) {
                const market = await client.getMarket(position.marketId);
                
                if (market) {
                    position.marketClosed = market.closed || false;
                    position.marketActive = market.active || false;
                    position.marketAcceptingOrders = market.accepting_orders || false;
                    position.marketArchived = market.archived || false;
                    
                    if (market.closed) {
                        position.marketState = 'CLOSED';
                    } else if (market.archived) {
                        position.marketState = 'ARCHIVED';
                    } else if (!market.active || !market.accepting_orders) {
                        position.marketState = 'RESOLVED'; 
                    } else {
                        position.marketState = 'ACTIVE';
                    }
                } else {
                    position.marketState = 'RESOLVED';
                    position.marketClosed = true;
                    position.marketActive = false;
                    position.marketAcceptingOrders = false;
                }
            }
        } catch (e: any) {
            if (String(e).includes("404") || String(e).includes("Not Found")) {
                position.marketState = 'RESOLVED';
                position.marketClosed = true;
                position.marketActive = false;
                position.marketAcceptingOrders = false;
            } else {
                this.addLog('warn', `Failed to check market state for ${position.marketId}: ${e.message}`);
            }
        }
    }

    public async syncPositions(forceChainSync = false): Promise<void> {
        if (!this.exchange) return;
        
        const now = Date.now();
        if (!forceChainSync && (now - this.lastPositionSync < this.POSITION_SYNC_INTERVAL)) {
            return;
        }
        
        if (forceChainSync || (now - this.lastPositionSync >= this.POSITION_SYNC_INTERVAL)) {
            this.lastPositionSync = now;
        }

        try {
            if (forceChainSync) {
                const address = this.exchange.getFunderAddress();
                if(address) {
                    const chainPositions = await this.exchange.getPositions(address);
                    const enrichedPositions: ActivePosition[] = [];

                    for (const p of chainPositions) {
                        const marketSlug = p.marketSlug || "";
                        const eventSlug = p.eventSlug || "";
                        const question = p.question || p.marketId;
                        const image = p.image || "";

                        const realId = p.clobOrderId || p.marketId;

                        const shouldUpdate = marketSlug || eventSlug;
                        if (shouldUpdate) {
                            const updateData: any = {};
                            if (marketSlug) updateData.marketSlug = marketSlug;
                            if (eventSlug) updateData.eventSlug = eventSlug;
                            
                            await Trade.updateMany(
                                { userId: this.config.userId, marketId: p.marketId },
                                { $set: updateData }
                            );
                        }

                        enrichedPositions.push({
                            tradeId: realId, 
                            clobOrderId: realId,
                            marketId: p.marketId,
                            conditionId: p.conditionId, 
                            tokenId: p.tokenId,
                            outcome: (p.outcome || 'YES').toUpperCase() as 'YES' | 'NO',
                            entryPrice: p.entryPrice || 0.5,
                            shares: p.balance || 0,
                            sizeUsd: p.valueUsd,
                            investedValue: p.investedValue,
                            timestamp: Date.now(),
                            currentPrice: p.currentPrice,
                            unrealizedPnL: p.unrealizedPnL,
                            unrealizedPnLPercent: p.unrealizedPnLPercent,
                            question: question,
                            image: image,
                            marketSlug: marketSlug,
                            eventSlug: eventSlug,
                            marketState: 'ACTIVE',
                            marketAcceptingOrders: true,
                            marketActive: true,
                            marketClosed: false,
                            marketArchived: false
                        });
                        
                        await this.updateMarketState(enrichedPositions[enrichedPositions.length - 1]);
                    }

                    this.activePositions = enrichedPositions;
                }
            } else {
                for (const pos of this.activePositions) {
                    try {
                        const currentPrice = await this.exchange?.getMarketPrice(pos.marketId, pos.tokenId, 'SELL');
                        if (currentPrice && !isNaN(currentPrice) && currentPrice > 0) {
                            pos.currentPrice = currentPrice;
                            const currentValue = pos.shares * currentPrice;
                            const investedValue = pos.shares * pos.entryPrice;
                            pos.investedValue = investedValue;
                            pos.unrealizedPnL = currentValue - investedValue;
                            pos.unrealizedPnLPercent = investedValue > 0 ? (pos.unrealizedPnL / investedValue) * 100 : 0;
                        }
                    } catch (e) {}
                }
            }
            
            if (this.callbacks?.onPositionsUpdate) {
                await this.callbacks.onPositionsUpdate(this.activePositions);
            }
            
            await this.syncStats();

        } catch (e: any) {
            this.addLog('warn', `Sync Positions Failed: ${e.message}`);
        }
    }
    
    public async syncStats(): Promise<void> {
        if (!this.exchange) return;
        try {
            const address = this.exchange.getFunderAddress();
            if(!address) return;
            
            const cashBalance = await this.exchange.fetchBalance(address);
            
            let positionValue = 0;
            this.activePositions.forEach(p => {
                if (p.shares && p.currentPrice && !isNaN(p.shares * p.currentPrice)) {
                    positionValue += (p.shares * p.currentPrice);
                }
            });

            this.stats.portfolioValue = cashBalance + positionValue;
            this.stats.cashBalance = cashBalance;
            
            if (this.callbacks?.onStatsUpdate) {
                await this.callbacks.onStatsUpdate(this.stats);
            }
        } catch(e) {
            console.error("Sync Stats Error", e);
        }
    }

    public async emergencySell(tradeIdOrMarketId: string, outcome?: string): Promise<string> {
        if (!this.executor) throw new Error("Executor not initialized.");
        
        let positionIndex = this.activePositions.findIndex(p => p.tradeId === tradeIdOrMarketId);
        if (positionIndex === -1 && outcome) {
             positionIndex = this.activePositions.findIndex(p => p.marketId === tradeIdOrMarketId && p.outcome === outcome);
        }

        if (positionIndex === -1) throw new Error("Position not found in active database.");

        const position = this.activePositions[positionIndex];
        this.addLog('warn', `Executing Market Exit: Offloading ${position.shares} shares of ${position.outcome} (${position.question || position.marketId})...`);

        try {
            let currentPrice = 0.5;
            try {
               currentPrice = await this.exchange?.getMarketPrice(position.marketId, position.tokenId, 'SELL') || 0.5;
            } catch(e) {}

            const success = await this.executor.executeManualExit(position, currentPrice);
            
            if (success) {
                const exitValue = position.shares * currentPrice;
                const costBasis = position.shares * position.entryPrice;
                const realizedPnl = exitValue - costBasis;

                if (this.callbacks?.onTradeComplete) {
                    await this.callbacks.onTradeComplete({
                        id: crypto.randomUUID(),
                        timestamp: new Date().toISOString(),
                        marketId: position.marketId,
                        outcome: position.outcome,
                        side: 'SELL',
                        size: costBasis, 
                        executedSize: exitValue, 
                        price: currentPrice,
                        pnl: realizedPnl,
                        status: 'CLOSED',
                        aiReasoning: 'Manual Exit',
                        riskScore: 0,
                        clobOrderId: position.clobOrderId,
                        marketSlug: position.marketSlug,
                        eventSlug: position.eventSlug
                    });
                }

                if (position.tradeId && !position.tradeId.startsWith('imported')) {
                    await Trade.findByIdAndUpdate(position.tradeId, {
                        status: 'CLOSED',
                        pnl: realizedPnl
                    });
                }

                this.activePositions.splice(positionIndex, 1);
                if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);
                
                this.addLog('success', `Exit summary: Liquidated ${position.shares.toFixed(2)} shares @ $${currentPrice.toFixed(3)}. Realized PnL: $${realizedPnl.toFixed(2)}`);
                
                setTimeout(() => this.syncStats(), 2000);
                
                return "sold";
            } else {
                throw new Error("Execution failed at adapter level");
            }
        } catch (e: any) {
            this.addLog('error', `Manual Exit Failed: ${e.message}`);
            throw e;
        }
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            await this.addLog('info', 'Starting Engine...');

            const engineLogger: Logger = {
                info: (m: string) => { console.log(m); this.addLog('info', m); },
                warn: (m: string) => { console.warn(m); this.addLog('warn', m); },
                error: (m: string, e?: any) => { console.error(m, e); this.addLog('error', m); },
                debug: () => {},
                success: (m: string) => { console.log(`${m}`); this.addLog('success', m); }
            };

            this.exchange = new PolymarketAdapter({
                rpcUrl: this.config.rpcUrl,
                walletConfig: this.config.walletConfig!,
                userId: this.config.userId,
                l2ApiCredentials: this.config.l2ApiCredentials,
                builderApiKey: this.config.builderApiKey,
                builderApiSecret: this.config.builderApiSecret,
                builderApiPassphrase: this.config.builderApiPassphrase,
                mongoEncryptionKey: this.config.mongoEncryptionKey
            }, engineLogger);

            await this.exchange.initialize();

            // Initialize the real-time arbitrage scanner instance (Actually Market Making)
            this.arbScanner = new MarketMakingScanner(this.exchange, engineLogger);
            
            // --- MARKET MAKING EVENT WIREUP ---

            // 1. Kill Switch: Stop trading if flash move detected
            this.arbScanner.on('killSwitch', async ({ reason }) => {
                await this.addLog('error', `🚨 EMERGENCY STOP: ${reason}`);
                if (this.executor) {
                    const adapter = this.executor.getAdapter();
                    await adapter?.cancelAllOrders();
                }
                this.stop(); // Stop the bot loop
            });

            // 2. Auto Merge: If we have equal YES and NO, free up USDCe
            this.arbScanner.on('mergeOpportunity', async ({ conditionId, amount }) => {
                await this.addLog('info', `📦 Auto-Merging ${amount} pairs for ${conditionId}`);
                try {
                    const adapter = this.executor?.getAdapter();
                    if (adapter) {
                        const tx = await adapter.mergePositions(conditionId, amount);
                        await this.addLog('success', `✅ Inventory Merged: ${tx}`);
                    } else {
                        throw new Error('Adapter not available');
                    }
                } catch (e: any) {
                    await this.addLog('warn', `Merge failed: ${e.message}`);
                }
            });

            // 3. Instant Redemption
            this.arbScanner.on('marketResolved', async ({ conditionId, question }) => {
                await this.addLog('info', `🏁 Market Resolved: ${question}`);
                // Force a position sync to find winning shares
                await this.syncPositions(true);
                const winner = this.activePositions.find(p => p.conditionId === conditionId);
                if (winner) {
                    await this.addLog('info', `🏆 Winning shares detected. Redeeming...`);
                    await this.exchange?.redeemPosition(conditionId, winner.tokenId);
                }
            });

            // 4. Standard Quote Signal
            this.arbScanner.on('opportunity', async (opp: MarketOpportunity) => {
                if (this.callbacks?.onArbUpdate) {
                    const arbOpps = this.arbScanner!.getOpportunities().map(o => ({
                        ...o,
                        marketId: o.conditionId,
                        roi: o.spreadPct,
                        combinedCost: 1 - o.spread,
                        capacityUsd: o.liquidity || 0
                    } as ArbitrageOpportunity));
                    await this.callbacks.onArbUpdate(arbOpps);
                }
                if (this.config.enableAutoArb) {
                    await this.executeMarketMaking(opp);
                }
            });

            // 5. Re-quote on price movement
            this.arbScanner.on('tickSizeChange', async (data) => {
                const opps = this.arbScanner?.getOpportunities();
                const target = opps?.find(o => o.tokenId === data.tokenId);
                if (target && this.config.enableAutoArb) {
                    await this.executeMarketMaking(target);
                }
            });

            const isFunded = await this.checkFunding();
            if (!isFunded) {
                await this.addLog('warn', 'Safe Empty. Engine standby. Waiting for deposit (Min 1.00)...');
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

    public stop() {
        this.isRunning = false;
        this.arbScanner?.stop();
        if (this.monitor) this.monitor.stop();
        if (this.portfolioService) this.portfolioService.stopSnapshotService();
        if (this.fundWatcher) {
            clearInterval(this.fundWatcher);
            this.fundWatcher = undefined;
        }
        this.addLog('warn', 'Engine Stopped.').catch(console.error);
    }

    /**
     * Executes the new Market Making logic when an opportunity is detected.
     */
    private async executeMarketMaking(opp: MarketOpportunity) {
        if (!this.executor || !this.exchange) return;
        
        const result = await this.executor.executeMarketMakingQuotes(opp);
        
        if (result.status === 'POSTED' || result.status === 'PARTIAL') {
            await this.addLog('success', `⚡ MM QUOTE: ${opp.question.slice(0,30)}... | Bid: ${result.bidPrice}¢ | Ask: ${result.askPrice}¢`);
            await this.syncPositions(true);
        }
    }

    /**
     * Direct dispatch for manual Market Making via UI button.
     * Robustly searches opportunities and forces GTC maker lane.
     */
    public async dispatchManualMM(marketId: string): Promise<boolean> {
        if (!this.executor) return false;
        
        const opps = this.arbScanner?.getOpportunities() || [];
        // Support searching by both conditionId and tokenId for UI resilience
        let target = opps.find(o => o.conditionId === marketId || o.tokenId === marketId);
        
        if (!target) {
            this.addLog('info', `🔍 Fetching direct data for MM Strategy: ${marketId}`);
            try {
                // If not in scanner, try to find in current tracking
                const tracked = this.arbScanner?.getTrackedMarket(marketId);
                if (tracked) {
                    // Create synthetic opportunity for immediate execution
                    target = {
                        marketId: tracked.conditionId,
                        conditionId: tracked.conditionId,
                        tokenId: tracked.tokenId,
                        question: tracked.question,
                        image: tracked.image,
                        bestBid: tracked.bestBid,
                        bestAsk: tracked.bestAsk,
                        spread: tracked.spread,
                        spreadPct: (tracked.spread / (tracked.bestBid + 0.005)) * 100,
                        spreadCents: tracked.spread * 100,
                        midpoint: (tracked.bestBid + tracked.bestAsk) / 2,
                        volume: tracked.volume,
                        liquidity: tracked.liquidity,
                        isNew: tracked.isNew,
                        timestamp: Date.now(),
                        roi: 1.0,
                        combinedCost: 1.0,
                        capacityUsd: tracked.liquidity,
                        status: tracked.status,
                        acceptingOrders: tracked.acceptingOrders
                    };
                }
            } catch (e) {}
        }

        if (target) {
            this.addLog('info', `🚀 FORCING MAKER PATH (GTC): ${target.question.slice(0, 30)}...`);
            await this.executeMarketMaking(target);
            return true;
        } else {
            this.addLog('warn', `❌ Market Maker Strategy rejected: Market ${marketId} not currently tradeable as maker.`);
            return false;
        }
    }

    private async checkFunding(): Promise<boolean> {
        try {
            if(!this.exchange) return false;
            const funderAddr = this.exchange.getFunderAddress();
            if (!funderAddr) return false;
            const balanceUSDC = await this.exchange.fetchBalance(funderAddr);
            if (this.activePositions.length > 0) return true;
            return balanceUSDC >= 1.0; 
        } catch (e) { return false; }
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
                await this.addLog('success', 'Funds detected. Initializing...');
                const engineLogger: Logger = {
                    info: (m: string) => { console.log(m); this.addLog('info', m); },
                    warn: (m: string) => { console.warn(m); this.addLog('warn', m); },
                    error: (m: string, e?: any) => { console.error(m, e); this.addLog('error', m); },
                    debug: () => {},
                    success: (m: string) => { console.log(`✅ ${m}`); this.addLog('success', m); }
                };
                await this.proceedWithPostFundingSetup(engineLogger);
            }
        }, 15000) as unknown as NodeJS.Timeout; 
    }

    private async proceedWithPostFundingSetup(engineLogger: Logger) {
        try {
            if(!this.exchange) return;
            await this.exchange.authenticate();
            
            this.portfolioService = new PortfolioService(engineLogger);
            this.portfolioService.startSnapshotService(
                this.config.userId,
                async () => {
                    const totalValue = this.stats.portfolioValue || 0;
                    const cashBalance = this.stats.cashBalance || 0;
                    return {
                        totalValue,
                        cashBalance,
                        positions: this.activePositions,
                        totalPnL: this.stats.totalPnl || 0
                    };
                }
            );
            
            await this.startServices(engineLogger);

            if (this.arbScanner) {
                await this.arbScanner.start();
            }

            await this.syncPositions(true); 
            await this.syncStats();
        } catch (e: any) {
            console.error(e);
            await this.addLog('error', `Setup Failed: ${e.message}`);
            this.isRunning = false; 
        }
    }

    private async startServices(logger: Logger) {
        if(!this.exchange) return;

        this.runtimeEnv = {
            tradeMultiplier: this.config.multiplier,
            maxTradeAmount: this.config.maxTradeAmount || 100, 
            minLiquidityFilter: this.config.minLiquidityFilter || 'LOW', 
            usdcContractAddress: TOKENS.USDC_BRIDGED,
            adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET,
            enableNotifications: this.config.enableNotifications,
            userPhoneNumber: this.config.userPhoneNumber,
            twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
            twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
            twilioFromNumber: process.env.TWILIO_FROM_NUMBER
        };
        
        const funder = this.exchange.getFunderAddress();
        if (!funder) throw new Error("Missing funder address.");

        this.executor = new TradeExecutorService({
            adapter: this.exchange,
            proxyWallet: funder,
            env: this.runtimeEnv, 
            logger: logger
        });

        this.stats.allowanceApproved = true; 

        const fundManager = new FundManagerService(
            this.exchange,
            funder,
            {
                enabled: this.config.autoCashout?.enabled || false,
                maxRetentionAmount: this.config.autoCashout?.maxAmount,
                destinationAddress: this.config.autoCashout?.destinationAddress,
            },
            logger,
            new NotificationService(this.runtimeEnv, logger)
        );

        let feeDistributor: FeeDistributorService | undefined;
        try {
             const walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
             if (this.config.walletConfig?.encryptedPrivateKey) {
                 const wallet = await walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
                 feeDistributor = new FeeDistributorService(wallet, this.runtimeEnv, logger, this.registryService);
             }
        } catch(e) { logger.warn("Fee Distributor init failed"); }

        const notifier = new NotificationService(this.runtimeEnv, logger);

        this.monitor = new TradeMonitorService({
            adapter: this.exchange,
            env: this.runtimeEnv,
            logger: logger,
            userAddresses: this.config.userAddresses,
            onDetectedTrade: async (signal: TradeSignal) => {
                if (!this.isRunning) return;

                // --- MM EXCLUSION ZONE ---
                const isManagedByMM = this.arbScanner?.getOpportunities().some(o => o.tokenId === signal.tokenId);
                if (isManagedByMM && this.config.enableAutoArb) {
                    this.addLog('info', `🛡️ Signal Skipped: Market ${signal.marketId.slice(0,8)} is managed by MM Strategy.`);
                    return;
                }

                if (signal.side === 'SELL') {
                    const hasPosition = this.activePositions.some(p => 
                        p.marketId === signal.marketId && p.outcome === signal.outcome
                    );
                    if (!hasPosition) return; 
                }

                const aiResult = await aiAgent.analyzeTrade(
                    signal.marketId, 
                    signal.side,
                    signal.outcome,
                    signal.sizeUsd,
                    signal.price,
                    this.config.riskProfile
                );

                if (!aiResult.shouldCopy) {
                    await this.addLog('info', `AI Skipped: ${aiResult.reasoning} (Score: ${aiResult.riskScore})`);
                    if (this.callbacks?.onTradeComplete) {
                        await this.callbacks.onTradeComplete({
                            id: crypto.randomUUID(),
                            timestamp: new Date().toISOString(),
                            marketId: signal.marketId,
                            outcome: signal.outcome,
                            side: signal.side,
                            size: signal.sizeUsd,
                            executedSize: 0,
                            price: signal.price,
                            status: 'SKIPPED',
                            aiReasoning: aiResult.reasoning,
                            riskScore: aiResult.riskScore
                        });
                    }
                    return;
                }

                await this.addLog('info', `AI Approved: ${aiResult.reasoning}. Executing...`);

                if (this.executor) {
                    const result: ExecutionResult = await this.executor.copyTrade(signal);
                    
                    if (result.status === 'FILLED') {
                        await this.addLog('success', `Trade Executed! Size: $${result.executedAmount.toFixed(2)}`);
                        
                        if (signal.side === 'BUY') {
                            const tradeId = crypto.randomUUID();
                            const marketData = await this.exchange?.getRawClient()?.getMarket(signal.marketId);
                            
                            let marketSlug = "";
                            let question = "Syncing...";
                            let image = "";
                            
                            if (marketData) {
                                marketSlug = marketData.market_slug || "";
                                question = marketData.question || question;
                                image = marketData.image || image;
                            }
                            
                            let eventSlug = "";
                            try {
                                const gammaUrl = `https://gamma-api.polymarket.com/markets?condition_id=${signal.marketId}`;
                                const controller = new AbortController();
                                const timeoutId = setTimeout(() => controller.abort(), 5000);
                                
                                const gammaResponse = await fetch(gammaUrl, { 
                                    signal: controller.signal,
                                    headers: { 'Accept': 'application/json' }
                                });
                                clearTimeout(timeoutId);
                                
                                if (gammaResponse.ok) {
                                    const gammaData = await gammaResponse.json();
                                    if (gammaData && gammaData.length > 0 && gammaData[0].events && gammaData[0].events.length > 0) {
                                        eventSlug = gammaData[0].events[0]?.slug || "";
                                    }
                                }
                            } catch (gammaError) {}

                            const newTrade: TradeHistoryEntry = {
                                id: tradeId,
                                timestamp: new Date().toISOString(),
                                marketId: signal.marketId,
                                outcome: signal.outcome,
                                side: 'BUY',
                                size: signal.sizeUsd,
                                executedSize: result.executedAmount,
                                price: result.priceFilled || signal.price,
                                pnl: 0,
                                status: 'OPEN',
                                txHash: result.txHash,
                                clobOrderId: result.txHash, 
                                assetId: signal.tokenId,
                                aiReasoning: aiResult.reasoning,
                                riskScore: aiResult.riskScore,
                                marketSlug: marketSlug,
                                eventSlug: eventSlug
                            };

                            if (this.callbacks?.onTradeComplete) await this.callbacks.onTradeComplete(newTrade);

                            this.activePositions.push({
                                tradeId: tradeId, 
                                clobOrderId: result.txHash,
                                marketId: signal.marketId,
                                conditionId: signal.marketId, 
                                tokenId: signal.tokenId,
                                outcome: signal.outcome,
                                entryPrice: result.priceFilled || signal.price,
                                shares: result.executedShares, 
                                sizeUsd: result.executedAmount,
                                investedValue: result.executedAmount,
                                timestamp: Date.now(),
                                currentPrice: result.priceFilled || signal.price,
                                question: question,
                                image: image,
                                marketSlug: marketSlug,
                                eventSlug: eventSlug,
                                marketState: 'ACTIVE',
                                marketAcceptingOrders: true,
                                marketActive: true,
                                marketClosed: false,
                                marketArchived: false
                            });
                        } else if (signal.side === 'SELL') {
                            const idx = this.activePositions.findIndex(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                            if (idx !== -1) {
                                const closingPos = this.activePositions[idx];
                                const exitValue = result.executedAmount;
                                const realizedPnl = exitValue - (closingPos.shares * closingPos.entryPrice);

                                await Trade.findByIdAndUpdate(closingPos.tradeId, { status: 'CLOSED', pnl: realizedPnl });
                                
                                if (this.callbacks?.onTradeComplete) {
                                    await this.callbacks.onTradeComplete({
                                        id: crypto.randomUUID(),
                                        timestamp: new Date().toISOString(),
                                        marketId: closingPos.marketId,
                                        outcome: closingPos.outcome,
                                        side: 'SELL',
                                        size: closingPos.shares * closingPos.entryPrice,
                                        executedSize: exitValue,
                                        price: result.priceFilled || signal.price,
                                        pnl: realizedPnl,
                                        status: 'CLOSED',
                                        aiReasoning: aiResult.reasoning,
                                        riskScore: aiResult.riskScore,
                                        clobOrderId: closingPos.clobOrderId,
                                        marketSlug: closingPos.marketSlug,
                                        eventSlug: closingPos.eventSlug
                                    });
                                }

                                this.activePositions.splice(idx, 1);
                            }
                        }

                        if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);
                        await notifier.sendTradeAlert(signal);
                        setTimeout(() => this.syncStats(), 2000);
                    } else {
                        await this.addLog('warn', `Execution Failed: ${result.reason || result.status}`);
                    }
                }
            }
        });

        await this.monitor.start(this.config.startCursor || Math.floor(Date.now() / 1000));
        await this.addLog('success', `Engine Active. Monitoring ${this.config.userAddresses.length} targets.`);
    }

    public getActivePositions(): ActivePosition[] {
        return this.activePositions;
    }

    public getArbOpportunities(): ArbitrageOpportunity[] { 
        return this.arbScanner?.getOpportunities() || []; 
    }

    public getCallbacks(): BotCallbacks | undefined {
        return this.callbacks;
    }

    /**
     * Manually add a market to MM scanner by condition ID
     */
    public async addMarketToMM(conditionId: string): Promise<boolean> {
        if (!this.arbScanner) {
            this.addLog('warn', 'MM Scanner not initialized');
            return false;
        }
        return this.arbScanner.addMarketByConditionId(conditionId);
    }

    /**
     * Manually add a market to MM scanner by slug
     */
    public async addMarketBySlug(slug: string): Promise<boolean> {
        if (!this.arbScanner) {
            this.addLog('warn', 'MM Scanner not initialized');
            return false;
        }
        return this.arbScanner.addMarketBySlug(slug);
    }

    /**
     * Bookmark a market for priority tracking
     */
    public bookmarkMarket(conditionId: string): void {
        this.arbScanner?.bookmarkMarket(conditionId);
    }

    /**
     * Remove bookmark a market
     */
    public unbookmarkMarket(conditionId: string): void {
        this.arbScanner?.unbookmarkMarket(conditionId);
    }

    /**
     * Get bookmarked opportunities
     */
    public getBookmarkedOpportunities(): ArbitrageOpportunity[] {
        return this.arbScanner?.getBookmarkedOpportunities() || [];
    }

    /**
     * Get opportunities by category
     */
    public getOpportunitiesByCategory(category: string): ArbitrageOpportunity[] {
        return this.arbScanner?.getOpportunities()
            .filter(o => o.category === category) || [];
    }
}
