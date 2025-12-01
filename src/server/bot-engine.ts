
import { createPolymarketClient } from '../infrastructure/clob-client.factory.js';
import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService, FundManagerConfig } from '../services/fund-manager.service.js';
import { FeeDistributorService } from '../services/fee-distributor.service.js';
import { ZeroDevService } from '../services/zerodev.service.js';
import { TradeHistoryEntry, ActivePosition } from '../domain/trade.types.js';
import { CashoutRecord, FeeDistributionEvent, IRegistryService } from '../domain/alpha.types.js';
import { UserStats } from '../domain/user.types.js';
import { ProxyWalletConfig } from '../domain/wallet.types.js'; 
import { ClobClient, Chain, ApiKeyCreds } from '@polymarket/clob-client';
import { Wallet, AbstractSigner, Provider, JsonRpcProvider, TransactionRequest } from 'ethers';
import { BotLog } from '../database/index.js';
import { BuilderConfig, BuilderApiKeyCreds } from '@polymarket/builder-signing-sdk';
import { getMarket } from '../utils/fetch-data.util.js';

// --- ADAPTER: ZeroDev (Viem) -> Ethers.js Signer ---
class KernelEthersSigner extends AbstractSigner {
    private kernelClient: any;
    private address: string;
    
    constructor(kernelClient: any, address: string, provider: Provider) {
        super(provider);
        this.kernelClient = kernelClient;
        this.address = address;
    }

    async getAddress(): Promise<string> {
        return this.address;
    }

    async signMessage(message: string | Uint8Array): Promise<string> {
        const signature = await this.kernelClient.signMessage({ 
            message: typeof message === 'string' ? message : { raw: message } 
        });
        return signature;
    }

    async signTypedData(domain: any, types: any, value: any): Promise<string> {
        return await this.kernelClient.signTypedData({
            domain,
            types,
            primaryType: Object.keys(types)[0], 
            message: value
        });
    }

    async signTransaction(tx: TransactionRequest): Promise<string> {
        throw new Error("signTransaction is not supported for KernelEthersSigner. Use sendTransaction to dispatch UserOperations.");
    }

    async sendTransaction(tx: TransactionRequest): Promise<any> {
        const hash = await this.kernelClient.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value.toString()) : BigInt(0)
        });
        return {
            hash,
            wait: async () => this.provider?.getTransactionReceipt(hash)
        };
    }

    connect(provider: Provider | null): AbstractSigner {
        return new KernelEthersSigner(this.kernelClient, this.address, provider || this.provider!);
    }
}

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
  autoCashout?: {
    enabled: boolean;
    maxAmount: number;
    destinationAddress: string;
  };
  activePositions?: ActivePosition[];
  stats?: UserStats; // Inject existing stats from DB
  zeroDevRpc?: string;
  // Admin Credentials (Optional)
  polymarketApiKey?: string;
  polymarketApiSecret?: string;
  polymarketApiPassphrase?: string;
  // Restart Logic
  startCursor?: number; // Timestamp to resume from
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
  private client?: ClobClient & { wallet: any };
  private watchdogTimer?: NodeJS.Timeout;
  
  // Use in-memory logs as a buffer (optional backup)
  private activePositions: ActivePosition[] = [];
  
  private stats: UserStats = {
      totalPnl: 0,
      totalVolume: 0,
      totalFeesPaid: 0,
      winRate: 0,
      tradesCount: 0,
      allowanceApproved: false
  };
  
  constructor(
    private config: BotConfig,
    private registryService: IRegistryService,
    private callbacks?: BotCallbacks
  ) {
      if (config.activePositions) {
          this.activePositions = config.activePositions;
      }
      if (config.stats) {
          this.stats = config.stats;
      }
      // Log initial wakeup
      this.addLog('info', 'Bot Engine Initialized');
  }

  public getStats() { return this.stats; }

  // Async log writing to DB
  private async addLog(type: 'info' | 'warn' | 'error' | 'success', message: string) {
    try {
        await BotLog.create({
            userId: this.config.userId,
            type,
            message,
            timestamp: new Date()
        });
    } catch (e) {
        console.error("Failed to persist log to DB", e);
    }
  }

  async revokePermissions() {
      if (this.executor) {
          await this.executor.revokeAllowance();
          this.stats.allowanceApproved = false;
          this.addLog('warn', 'Permissions Revoked by User.');
      }
  }

  async start() {
    if (this.isRunning) return;
    
    try {
      this.isRunning = true;
      await this.addLog('info', 'Starting Server-Side Bot Engine...');

      const logger = {
        info: (msg: string) => { console.log(`[${this.config.userId}] ${msg}`); this.addLog('info', msg); },
        warn: (msg: string) => { console.warn(`[${this.config.userId}] ${msg}`); this.addLog('warn', msg); },
        error: (msg: string, err?: Error) => { console.error(`[${this.config.userId}] ${msg}`, err); this.addLog('error', `${msg} ${err?.message || ''}`); },
        debug: () => {}
      };

      const env: any = {
        rpcUrl: this.config.rpcUrl,
        tradeMultiplier: this.config.multiplier,
        fetchIntervalSeconds: 2,
        aggregationWindowSeconds: 300,
        enableNotifications: this.config.enableNotifications,
        adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET || '0x0000000000000000000000000000000000000000',
        usdcContractAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      };

      // --- ACCOUNT STRATEGY SELECTION ---
      let signerImpl: any;
      let walletAddress: string;
      let clobCreds: ApiKeyCreds | undefined = undefined;

      // 1. Smart Account Strategy
      if (this.config.walletConfig?.type === 'SMART_ACCOUNT' && this.config.walletConfig.serializedSessionKey) {
          await this.addLog('info', '🔐 Initializing ZeroDev Smart Account Session...');
          
          // Check if RPC is configured properly
          const rpcUrl = this.config.zeroDevRpc || process.env.ZERODEV_RPC;
          if (!rpcUrl || rpcUrl.includes('your-project-id') || rpcUrl.includes('DEFAULT')) {
               throw new Error("CRITICAL: ZERODEV_RPC is missing or invalid in .env. Please create a project at zerodev.app (Polygon) and add the Bundler URL.");
          }
          
          const aaService = new ZeroDevService(rpcUrl);
          const { address, client: kernelClient } = await aaService.createBotClient(this.config.walletConfig.serializedSessionKey);
          
          walletAddress = address;
          await this.addLog('success', `Smart Account Active: ${walletAddress.slice(0,6)}... (Session Key)`);
          
          const provider = new JsonRpcProvider(this.config.rpcUrl);
          signerImpl = new KernelEthersSigner(kernelClient, address, provider);
          clobCreds = undefined; 

      } else {
          // 2. Legacy EOA Strategy
          await this.addLog('info', 'Using Standard EOA Wallet');
          const activeKey = this.config.privateKey || this.config.walletConfig?.sessionPrivateKey;
          if (!activeKey) throw new Error("No valid signing key found for EOA.");
          
          const provider = new JsonRpcProvider(this.config.rpcUrl);
          signerImpl = new Wallet(activeKey, provider);
          walletAddress = signerImpl.address;

          if (this.config.polymarketApiKey && this.config.polymarketApiSecret && this.config.polymarketApiPassphrase) {
              await this.addLog('info', '⚡ API Keys Loaded (High Performance Mode)');
              clobCreds = {
                  key: this.config.polymarketApiKey,
                  secret: this.config.polymarketApiSecret,
                  passphrase: this.config.polymarketApiPassphrase
              };
          }
      }

      // --- BUILDER PROGRAM INTEGRATION ---
      let builderConfig: BuilderConfig | undefined;
      if (process.env.POLY_BUILDER_API_KEY && process.env.POLY_BUILDER_SECRET && process.env.POLY_BUILDER_PASSPHRASE) {
           const builderCreds: BuilderApiKeyCreds = {
              key: process.env.POLY_BUILDER_API_KEY,
              secret: process.env.POLY_BUILDER_SECRET,
              passphrase: process.env.POLY_BUILDER_PASSPHRASE
          };
          builderConfig = new BuilderConfig({ localBuilderCreds: builderCreds });
          await this.addLog('info', '👷 Builder Program Attribution Active (Stamping Trades)');
      }

      // Initialize Polymarket Client with Builder Attribution
      const clobClient = new ClobClient(
          'https://clob.polymarket.com',
          Chain.POLYGON,
          signerImpl, 
          clobCreds,
          undefined, // signatureType
          undefined, // funderAddress
          undefined, // ...
          undefined, // ...
          builderConfig   
      );

      this.client = Object.assign(clobClient, { wallet: signerImpl });

      await this.addLog('success', `Bot Online: ${walletAddress.slice(0,6)}...`);

      const notifier = new NotificationService(env, logger);
      
      const fundManagerConfig: FundManagerConfig = {
          enabled: this.config.autoCashout?.enabled || false,
          maxRetentionAmount: this.config.autoCashout?.maxAmount || 0,
          destinationAddress: this.config.autoCashout?.destinationAddress || '',
          usdcContractAddress: env.usdcContractAddress
      };

      const fundManager = new FundManagerService(this.client.wallet, fundManagerConfig, logger, notifier);
      const feeDistributor = new FeeDistributorService(this.client.wallet, env, logger, this.registryService);
      
      this.executor = new TradeExecutorService({
        client: this.client,
        proxyWallet: walletAddress,
        env,
        logger
      });

      await this.addLog('info', 'Checking Token Allowances...');
      const approved = await this.executor.ensureAllowance();
      this.stats.allowanceApproved = approved;

      try {
         const cashoutResult = await fundManager.checkAndSweepProfits();
         if (cashoutResult && this.callbacks?.onCashout) await this.callbacks.onCashout(cashoutResult);
      } catch (e) { /* ignore start up cashout error */ }

      // Start Trade Monitor
      this.monitor = new TradeMonitorService({
        client: this.client,
        logger,
        env,
        userAddresses: this.config.userAddresses,
        onDetectedTrade: async (signal) => {
          let shouldExecute = true;
          let aiReasoning = "Legacy Mode (No AI Key)";
          let riskScore = 5;

          if (this.config.geminiApiKey && this.config.geminiApiKey.length > 10) {
            await this.addLog('info', '🤖 AI Analyzing signal...');
            const analysis = await aiAgent.analyzeTrade(
              `Market: ${signal.marketId}`,
              signal.side,
              signal.outcome,
              signal.sizeUsd,
              signal.price,
              this.config.geminiApiKey,
              this.config.riskProfile
            );
            shouldExecute = analysis.shouldCopy;
            aiReasoning = analysis.reasoning;
            riskScore = analysis.riskScore;
          }

          if (shouldExecute) {
            await this.addLog('info', `Executing Copy: ${signal.side} ${signal.outcome}`);
            
            try {
                let executedSize = 0;
                if(this.executor) {
                    executedSize = await this.executor.copyTrade(signal);
                }
                
                // If size is 0, it means trade failed gracefully (e.g. insufficient balance or market closed)
                if (executedSize > 0) {
                    await this.addLog('success', `Trade Executed Successfully!`);
                    
                    let realPnl = 0;
                    
                    if (signal.side === 'BUY') {
                        const newPosition: ActivePosition = {
                            marketId: signal.marketId,
                            tokenId: signal.tokenId,
                            outcome: signal.outcome,
                            entryPrice: signal.price,
                            sizeUsd: executedSize, // Track executed size for PnL
                            timestamp: Date.now()
                        };
                        this.activePositions.push(newPosition);
                    } else if (signal.side === 'SELL') {
                        const posIndex = this.activePositions.findIndex(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                        if (posIndex !== -1) {
                            const entry = this.activePositions[posIndex];
                            const yieldPercent = (signal.price - entry.entryPrice) / entry.entryPrice;
                            realPnl = entry.sizeUsd * yieldPercent; // Calculate PnL on actual size
                            await this.addLog('info', `Realized PnL: $${realPnl.toFixed(2)} (${(yieldPercent*100).toFixed(1)}%)`);
                            this.activePositions.splice(posIndex, 1);
                        } else {
                            await this.addLog('warn', `Closing tracked position (Entry lost or manual). PnL set to 0.`);
                            realPnl = 0; 
                        }
                    }

                    if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);

                    // Log History (Database)
                    await this.recordTrade({
                        marketId: signal.marketId,
                        outcome: signal.outcome,
                        side: signal.side,
                        price: signal.price,
                        size: signal.sizeUsd, // Whale Size
                        executedSize: executedSize, // Bot Size
                        aiReasoning: aiReasoning,
                        riskScore: riskScore,
                        pnl: realPnl,
                        status: signal.side === 'SELL' ? 'CLOSED' : 'OPEN'
                    });

                    // Notify User
                    await notifier.sendTradeAlert(signal);

                    // Distribute Fees on PROFIT ONLY
                    if (signal.side === 'SELL' && realPnl > 0) {
                        const feeEvent = await feeDistributor.distributeFeesOnProfit(signal.marketId, realPnl, signal.trader);
                        if (feeEvent) {
                            this.stats.totalFeesPaid += (feeEvent.platformFee + feeEvent.listerFee);
                            if (this.callbacks?.onFeePaid) await this.callbacks.onFeePaid(feeEvent);
                        }
                    }
                    
                    if (this.callbacks?.onStatsUpdate) await this.callbacks.onStatsUpdate(this.stats);

                    // Check for cashout after a profitable trade
                    setTimeout(async () => {
                    const cashout = await fundManager.checkAndSweepProfits();
                    if (cashout && this.callbacks?.onCashout) await this.callbacks.onCashout(cashout);
                    }, 15000);
                }
            } catch (err: any) {
                await this.addLog('error', `Execution Failed: ${err.message}`);
            }
          } else {
             // Log Skipped Trade
             await this.recordTrade({
                marketId: signal.marketId,
                outcome: signal.outcome,
                side: signal.side,
                price: signal.price,
                size: signal.sizeUsd,
                executedSize: 0,
                aiReasoning: aiReasoning,
                riskScore: riskScore,
                status: 'SKIPPED'
             });
          }
        }
      });

      // Pass the startCursor to monitor to prevent replaying old trades
      await this.monitor.start(this.config.startCursor);
      
      // Watchdog for Auto-Take Profit
      this.watchdogTimer = setInterval(() => this.checkAutoTp(), 10000) as unknown as NodeJS.Timeout;
      
      await this.addLog('success', 'Bot Engine Active & Monitoring 24/7');

    } catch (e: any) {
      this.isRunning = false;
      await this.addLog('error', `Startup Failed: ${e.message}`);
    }
  }

  private async checkAutoTp() {
      if (!this.config.autoTp || !this.executor || !this.client || this.activePositions.length === 0) return;
      
      const positionsToCheck = [...this.activePositions];
      
      for (const pos of positionsToCheck) {
          try {
              // PRE-CHECK: Verify market is still active to avoid 404 Orderbook errors
              let isClosed = false;
              try {
                  const market = await getMarket(pos.marketId);
                  // Market can be closed OR resolved
                  if (market.closed || market.active === false || market.enable_order_book === false) {
                      isClosed = true;
                  }
              } catch (e) {
                   // API Error - fail safe skip
                   continue; 
              }

              if (isClosed) {
                  // Remove from tracking silently to stop errors
                  this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                  if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);
                  continue;
              }

              const orderBook = await this.client.getOrderBook(pos.tokenId);
              if (orderBook.bids && orderBook.bids.length > 0) {
                  const bestBid = parseFloat(orderBook.bids[0].price);
                  const gainPercent = ((bestBid - pos.entryPrice) / pos.entryPrice) * 100;
                  
                  if (gainPercent >= this.config.autoTp) {
                      await this.addLog('success', `🎯 Auto TP Hit! ${pos.outcome} is up +${gainPercent.toFixed(1)}%`);
                      
                      const success = await this.executor.executeManualExit(pos, bestBid);
                      
                      if (success) {
                          this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                          if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);
                          
                          const realPnl = pos.sizeUsd * (gainPercent / 100);
                          await this.recordTrade({
                              marketId: pos.marketId,
                              outcome: pos.outcome,
                              side: 'SELL',
                              price: bestBid,
                              size: pos.sizeUsd,
                              executedSize: pos.sizeUsd,
                              aiReasoning: 'Auto Take-Profit Trigger',
                              riskScore: 0,
                              pnl: realPnl,
                              status: 'CLOSED'
                          });
                      }
                  }
              }
          } catch (e: any) { 
               // If 404 leaks through, ensure we remove the bad position
               if (e.message?.includes('404') || e.response?.status === 404 || e.status === 404) {
                   this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                   if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);
               }
          }
      }
  }

  private async recordTrade(data: {
      marketId: string;
      outcome: string;
      side: 'BUY' | 'SELL';
      price: number;
      size: number;
      executedSize: number;
      aiReasoning?: string;
      riskScore?: number;
      pnl?: number;
      status: 'OPEN' | 'CLOSED' | 'SKIPPED';
      txHash?: string;
  }) {
      const entry: TradeHistoryEntry = {
          id: Math.random().toString(36).substring(7),
          timestamp: new Date().toISOString(),
          ...data
      };

      if (data.status !== 'SKIPPED') {
          this.stats.tradesCount = (this.stats.tradesCount || 0) + 1;
          this.stats.totalVolume = (this.stats.totalVolume || 0) + data.executedSize; // Update stats with REAL volume
          if (data.pnl) {
              this.stats.totalPnl = (this.stats.totalPnl || 0) + data.pnl;
          }
      }

      if (this.callbacks?.onTradeComplete) {
          await this.callbacks.onTradeComplete(entry);
      }

      if (data.status !== 'SKIPPED' && this.callbacks?.onStatsUpdate) {
          await this.callbacks.onStatsUpdate(this.stats);
      }
  }

  stop() {
    this.isRunning = false;
    if (this.monitor) this.monitor.stop();
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.addLog('warn', 'Bot Engine Stopped.');
  }
}
