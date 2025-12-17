import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService, ExecutionResult } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService } from '../services/fund-manager.service.js';
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
import crypto from 'crypto';

export interface BotConfig {
    userId: string;
    walletConfig?: TradingWalletConfig;
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
}

export class BotEngine {
    public isRunning = false;
    private monitor?: TradeMonitorService;
    private executor?: TradeExecutorService;
    private exchange?: PolymarketAdapter;
    private runtimeEnv: any;
    
    private fundWatcher?: NodeJS.Timeout;
    private activePositions: ActivePosition[] = [];
    private stats: UserStats = {
        totalPnl: 0, 
        totalVolume: 0, 
        totalFeesPaid: 0, 
        winRate: 0, 
        tradesCount: 0, 
        allowanceApproved: false, 
        portfolioValue: 0, 
        cashBalance: 0
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

        if (newConfig.riskProfile !== undefined) this.config.riskProfile = newConfig.riskProfile;
        if (newConfig.autoTp !== undefined) this.config.autoTp = newConfig.autoTp;
        
        if (newConfig.autoCashout) {
            this.config.autoCashout = newConfig.autoCashout;
        }
    }

    public async syncPositions(forceChainSync = false): Promise<void> {
        if (!this.exchange || !this.exchange.isReady()) return;
        
        try {
            if (forceChainSync) {
                this.addLog('warn', '⚠️ Forced Chain Sync requested. Updating positions from Chain/API...');
                const address = this.exchange.getFunderAddress();
                if(address) {
                    const chainPositions = await this.exchange.getPositions(address);
                    
                    this.activePositions = chainPositions.map(p => ({
                         tradeId: 'imported_' + Date.now() + Math.random().toString(36).substring(7),
                         marketId: p.marketId,
                         tokenId: p.tokenId,
                         outcome: p.outcome as 'YES' | 'NO',
                         entryPrice: p.entryPrice,
                         shares: p.balance,
                         sizeUsd: p.valueUsd,
                         timestamp: Date.now(),
                         currentPrice: p.currentPrice,
                         question: p.question,
                         image: p.image,
                         marketSlug: p.marketSlug
                    }));
                }
            } else {
                // STANDARD SYNC: Use strictly Side-Aware Pricing (SELL side for current liquidation value)
                for (const pos of this.activePositions) {
                    try {
                        const currentPrice = await this.exchange.getMarketPrice(pos.marketId, pos.tokenId, 'SELL');
                        if (currentPrice > 0) {
                            pos.currentPrice = currentPrice; 
                            pos.sizeUsd = pos.shares * currentPrice;
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
            this.activePositions.forEach(p => positionValue += p.sizeUsd);

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
        if (!this.exchange) throw new Error("Adapter not initialized.");
        
        let positionIndex = this.activePositions.findIndex(p => p.tradeId === tradeIdOrMarketId);
        
        if (positionIndex === -1 && outcome) {
             positionIndex = this.activePositions.findIndex(p => p.marketId === tradeIdOrMarketId && p.outcome === outcome);
        }

        if (positionIndex === -1) {
            throw new Error("Position not found in active database.");
        }

        const position = this.activePositions[positionIndex];
        
        // DUST PROTECTION: Always check the BID price (SELL side)
        const currentBestBid = await this.exchange.getMarketPrice(position.marketId, position.tokenId, 'SELL');
        const projectedExitValue = position.shares * currentBestBid;

        this.addLog('warn', `📉 Attempting Manual Exit: ${position.shares} shares @ ~$${currentBestBid}...`);

        if (projectedExitValue < 1.0) {
            const err = `✋ Dust Protection: Current exit value ($${projectedExitValue.toFixed(2)}) is below the $1.00 minimum. Sale blocked to avoid failure.`;
            this.addLog('error', err);
            throw new Error("dust_position_too_small");
        }

        try {
            const res = await this.exchange.createOrder({
                marketId: position.marketId, 
                tokenId: position.tokenId, 
                outcome: position.outcome,
                side: 'SELL', 
                sizeUsd: 0, 
                sizeShares: position.shares
            });
            
            if (res.success) {
                if (position.tradeId && !position.tradeId.startsWith('imported')) {
                    try {
                        const pnl = (res.priceFilled - position.entryPrice) * position.shares; 
                        
                        await Trade.findByIdAndUpdate(position.tradeId, {
                            status: 'CLOSED',
                            pnl: pnl
                        });
                    } catch(e) {
                        console.error("Failed to update trade record", e);
                    }
                }

                this.activePositions.splice(positionIndex, 1);
                
                if (this.callbacks?.onPositionsUpdate) {
                    await this.callbacks.onPositionsUpdate(this.activePositions);
                }

                if (this.callbacks?.onTradeComplete) {
                    await this.callbacks.onTradeComplete({
                        id: crypto.randomUUID(),
                        timestamp: new Date().toISOString(),
                        marketId: position.marketId,
                        outcome: position.outcome,
                        side: 'SELL',
                        size: position.sizeUsd, 
                        executedSize: res.sharesFilled * res.priceFilled, 
                        price: res.priceFilled,
                        status: 'FILLED',
                        aiReasoning: 'Manual Exit',
                        riskScore: 0,
                        clobOrderId: res.orderId
                    });
                }
                
                this.addLog('success', `✅ Position Closed.`);
                setTimeout(() => this.syncStats(), 2000);
                
                return "sold";
            } else {
                throw new Error(res.error || "Execution failed at adapter level");
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
                builderApiKey: this.config.builderApiKey,
                builderApiSecret: this.config.builderApiSecret,
                builderApiPassphrase: this.config.builderApiPassphrase,
                mongoEncryptionKey: this.config.mongoEncryptionKey
            }, engineLogger);

            await this.exchange.initialize();

            const isFunded = await this.checkFunding();
            
            if (!isFunded) {
                await this.addLog('warn', '💰 Safe Empty. Engine standby. Waiting for deposit to Safe (Min $1.00)...');
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
        if (this.monitor) {
            this.monitor.stop();
        }
        if (this.fundWatcher) {
            clearInterval(this.fundWatcher);
            this.fundWatcher = undefined;
        }
        this.addLog('warn', '🛑 Engine Stopped.').catch(console.error);
    }

    private async checkFunding(): Promise<boolean> {
        try {
            if(!this.exchange) return false;
            const funderAddr = this.exchange.getFunderAddress();
            if (!funderAddr) return false;
            
            const balanceUSDC = await this.exchange.fetchBalance(funderAddr);
            if (this.activePositions.length > 0) return true;
            return balanceUSDC >= 1.0; 
        } catch (e) {
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
                await this.addLog('success', '💰 Funds detected. Initializing...');
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
            this.startServices(engineLogger);
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
            usdcContractAddress: TOKENS.USDC_BRIDGED,
            adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET,
            enableNotifications: this.config.enableNotifications,
            userPhoneNumber: this.config.userPhoneNumber,
            twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
            twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
            twilioFromNumber: process.env.TWILIO_FROM_NUMBER
        };
        
        const funder = this.exchange.getFunderAddress();

        if (!funder) {
            throw new Error("Adapter initialization incomplete. Missing funder address.");
        }

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
        } catch(e) {
            logger.warn("Fee Distributor init failed, skipping: " + (e as Error).message);
        }

        const notifier = new NotificationService(this.runtimeEnv, logger);

        this.monitor = new TradeMonitorService({
            adapter: this.exchange,
            env: this.runtimeEnv,
            logger: logger,
            userAddresses: this.config.userAddresses,
            onDetectedTrade: async (signal: TradeSignal) => {
                if (!this.isRunning) return;

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
                    this.config.riskProfile,
                    this.config.geminiApiKey
                );

                if (!aiResult.shouldCopy) {
                    await this.addLog('info', `✋ AI Skipped: ${aiResult.reasoning} (Score: ${aiResult.riskScore})`);
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

                await this.addLog('info', `🤖 AI Approved: ${aiResult.reasoning} (Score: ${aiResult.riskScore}). Executing...`);

                if (this.executor) {
                    const result: ExecutionResult = await this.executor.copyTrade(signal);
                    
                    if (result.status === 'FILLED') {
                        await this.addLog('success', `✅ Trade Executed! Order: ${result.txHash || result.reason} ($${result.executedAmount.toFixed(2)})`);
                        
                        if (signal.side === 'BUY') {
                            const tradeRecord = await Trade.create({
                                _id: crypto.randomUUID(),
                                userId: this.config.userId,
                                marketId: signal.marketId,
                                outcome: signal.outcome,
                                side: 'BUY',
                                size: signal.sizeUsd,
                                executedSize: result.executedAmount,
                                price: result.priceFilled,
                                pnl: 0,
                                status: 'OPEN',
                                txHash: result.txHash,
                                clobOrderId: result.txHash, 
                                assetId: signal.tokenId,
                                aiReasoning: aiResult.reasoning,
                                riskScore: aiResult.riskScore,
                                timestamp: new Date()
                            });

                            this.activePositions.push({
                                tradeId: tradeRecord._id.toString(), 
                                clobOrderId: result.txHash,
                                marketId: signal.marketId,
                                tokenId: signal.tokenId,
                                outcome: signal.outcome,
                                entryPrice: result.priceFilled,
                                shares: result.executedShares, 
                                sizeUsd: result.executedAmount,
                                timestamp: Date.now(),
                                currentPrice: result.priceFilled,
                                question: "Loading Data...",
                                image: ""
                            });
                            
                            this.syncPositions(true);

                        } else if (signal.side === 'SELL') {
                            const idx = this.activePositions.findIndex(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                            if (idx !== -1) {
                                const closingPos = this.activePositions[idx];
                                if (closingPos.tradeId) {
                                    await Trade.findByIdAndUpdate(closingPos.tradeId, { 
                                        status: 'CLOSED',
                                        pnl: (result.priceFilled - closingPos.entryPrice) * closingPos.shares 
                                    });
                                }
                                this.activePositions.splice(idx, 1);
                            }
                        }

                        if (this.callbacks?.onPositionsUpdate) {
                            await this.callbacks.onPositionsUpdate(this.activePositions);
                        }

                        await notifier.sendTradeAlert(signal);
                        
                        if (signal.side === 'SELL' && feeDistributor) {
                            const estimatedProfit = result.executedAmount * 0.1; 
                            if (estimatedProfit > 0) {
                                const feeEvent = await feeDistributor.distributeFeesOnProfit(
                                    signal.marketId, 
                                    estimatedProfit, 
                                    signal.trader
                                );
                                if (feeEvent && this.callbacks?.onFeePaid) {
                                    await this.callbacks.onFeePaid(feeEvent);
                                }
                            }
                        }
                        
                        setTimeout(() => this.syncStats(), 2000);
                        setTimeout(async () => {
                            const cashout = await fundManager.checkAndSweepProfits();
                            if (cashout && this.callbacks?.onCashout) await this.callbacks.onCashout(cashout);
                        }, 15000);

                    } else {
                        await this.addLog('warn', `Execution Skipped/Failed: ${result.reason || result.status}`);
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
                                status: 'FAILED', 
                                aiReasoning: aiResult.reasoning,
                                riskScore: aiResult.riskScore
                            });
                        }
                    }
                }
            }
        });

        const startTs = this.config.startCursor || Math.floor(Date.now() / 1000);
        await this.monitor.start(startTs);
        
        this.addLog('success', `Engine Active. Monitoring ${this.config.userAddresses.length} targets.`);
    }
}