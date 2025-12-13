import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService } from '../services/fund-manager.service.js';
import { TradeHistoryEntry, ActivePosition, TradeSignal } from '../domain/trade.types.js';
import { CashoutRecord, FeeDistributionEvent, IRegistryService } from '../domain/alpha.types.js';
import { UserStats } from '../domain/user.types.js';
import { TradingWalletConfig, L2ApiCredentials } from '../domain/wallet.types.js'; 
import { BotLog, User } from '../database/index.js';
import { PolymarketAdapter } from '../adapters/polymarket/polymarket.adapter.js';
import { Logger } from '../utils/logger.util.js';
import { FeeDistributorService } from '../services/fee-distributor.service.js';
import { EvmWalletService } from '../services/evm-wallet.service.js';
import crypto from 'crypto';

// Define the correct USDC.e address on Polygon
const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

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
    
    // Builder Attribution & Relayer Credentials
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

            // Initialize Exchange Adapter (Polymarket Gnosis Safe)
            this.exchange = new PolymarketAdapter({
                rpcUrl: this.config.rpcUrl,
                walletConfig: this.config.walletConfig!,
                userId: this.config.userId,
                l2ApiCredentials: this.config.l2ApiCredentials,
                // Pass Builder Credentials for Relayer & Attribution
                builderApiKey: this.config.builderApiKey,
                builderApiSecret: this.config.builderApiSecret,
                builderApiPassphrase: this.config.builderApiPassphrase,
                mongoEncryptionKey: this.config.mongoEncryptionKey
            }, engineLogger);

            await this.exchange.initialize();

            // Note: We authenticate AFTER checking funding to avoid unnecessary Relayer calls on empty wallets
            const isFunded = await this.checkFunding();
            
            if (!isFunded) {
                await this.addLog('warn', '💰 Safe Empty. Engine standby. Waiting for deposit to Safe...');
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
            // For Gnosis Safe, this checks the Safe address balance via Adapter
            const funderAddr = this.exchange.getFunderAddress();
            if (!funderAddr) return false;
            const balance = await this.exchange.fetchBalance(funderAddr);
            return balance >= 0.5; // Minimum $0.50 to start
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
                await this.addLog('success', '💰 Funds detected in Safe. Initializing trading...');
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

    private async proceedWithPostFundingSetup(logger: Logger) {
        try {
            if(!this.exchange) return;
            
            // This triggers Safe deployment and Proxy approvals via Relayer
            await this.exchange.authenticate();
            
            this.startServices(logger);
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
            usdcContractAddress: USDC_BRIDGED_POLYGON,
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

        // Fund Manager handles Auto-Cashout
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

        // Initial Cashout Check
        try {
            const cashout = await fundManager.checkAndSweepProfits();
            if (cashout && this.callbacks?.onCashout) await this.callbacks.onCashout(cashout);
        } catch(e) { console.error(e); }

        let feeDistributor: FeeDistributorService | undefined;
        try {
             // FeeDistributor uses the underlying EOA to pay fees/transfer if needed
             // For Safe, we might need to adjust this in Phase 3 to use Relayer transfers.
             // Currently, FeeDistributor uses EOA directly.
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

                // --- 1. POSITION CHECK (Prevent selling what we don't have) ---
                if (signal.side === 'SELL') {
                    // Check if we have an open position matching market+outcome
                    // We assume "tokenId" or "marketId + outcome" is sufficient.
                    const hasPosition = this.activePositions.some(p => 
                        p.marketId === signal.marketId && p.outcome === signal.outcome
                    );
                    
                    if (!hasPosition) {
                         // Skipping SELL signal for position we don't hold
                         return; 
                    }
                }

                // 2. AI Analysis
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
                    const result = await this.executor.copyTrade(signal);
                    
                    if (typeof result === 'string' && (result.includes('skipped') || result.includes('insufficient') || result === 'failed')) {
                        await this.addLog('warn', `Execution Skipped: ${result}`);
                        
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
                    } else {
                        await this.addLog('success', `✅ Trade Executed! Order: ${result}`);
                        
                        // --- UPDATE LOCAL STATE ---
                        if (signal.side === 'BUY') {
                            this.activePositions.push({
                                marketId: signal.marketId,
                                tokenId: signal.tokenId,
                                outcome: signal.outcome,
                                entryPrice: signal.price,
                                sizeUsd: signal.sizeUsd,
                                timestamp: Date.now()
                            });
                        } else if (signal.side === 'SELL') {
                            // FIFO removal of one matching position
                            const idx = this.activePositions.findIndex(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                            if (idx !== -1) {
                                this.activePositions.splice(idx, 1);
                            }
                        }

                        if (this.callbacks?.onPositionsUpdate) {
                            await this.callbacks.onPositionsUpdate(this.activePositions);
                        }

                        await notifier.sendTradeAlert(signal);
                        
                        if (this.callbacks?.onTradeComplete) {
                            await this.callbacks.onTradeComplete({
                                id: result.toString(), 
                                timestamp: new Date().toISOString(),
                                marketId: signal.marketId,
                                outcome: signal.outcome,
                                side: signal.side,
                                size: signal.sizeUsd,
                                executedSize: signal.sizeUsd, 
                                price: signal.price,
                                status: 'OPEN',
                                txHash: result.toString(),
                                aiReasoning: aiResult.reasoning,
                                riskScore: aiResult.riskScore
                            });
                        }

                        if (signal.side === 'SELL' && feeDistributor) {
                            const estimatedProfit = signal.sizeUsd * 0.1; 
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

                        setTimeout(async () => {
                            const cashout = await fundManager.checkAndSweepProfits();
                            if (cashout && this.callbacks?.onCashout) await this.callbacks.onCashout(cashout);
                        }, 15000);
                    }
                }
            }
        });

        const startTs = this.config.startCursor || Math.floor(Date.now() / 1000);
        await this.monitor.start(startTs);
        
        this.addLog('success', `Engine Active. Monitoring ${this.config.userAddresses.length} targets.`);
    }
}