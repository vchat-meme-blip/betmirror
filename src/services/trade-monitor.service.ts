import { RuntimeEnv } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';
import { TradeSignal } from '../domain/trade.types.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';
import axios from 'axios';

export type TradeMonitorDeps = {
  adapter: IExchangeAdapter;
  env: RuntimeEnv;
  logger: Logger;
  userAddresses: string[];
  onDetectedTrade: (signal: TradeSignal) => Promise<void>;
};

interface PolyActivity {
    id: string;
    type: string; // "TRADE" | "ORDER_FILLED"
    timestamp: number;
    conditionId: string;
    asset: string;
    side: string;
    size: number;
    price: number;
    usdcSize: number;
    outcomeIndex: number;
    transactionHash: string;
}

export class TradeMonitorService {
  private readonly deps: TradeMonitorDeps;
  private isPolling = false;
  private pollInterval?: NodeJS.Timeout;
  
  // Set needed for fast lookups in the hot path
  private targetWallets: Set<string> = new Set();
  
  // Deduplication cache (Hash -> Timestamp)
  private processedHashes: Map<string, number> = new Map();

  constructor(deps: TradeMonitorDeps) {
    this.deps = deps;
    this.updateTargets(deps.userAddresses);
  }

  updateTargets(newTargets: string[]) {
      this.deps.userAddresses = newTargets;
      this.targetWallets = new Set(newTargets.map(t => t.toLowerCase()));
      this.deps.logger.info(`🎯 Monitor target list updated to ${this.targetWallets.size} wallets.`);
  }

  async start(startCursor?: number): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    
    this.deps.logger.info(`🔌 Starting High-Frequency Polling (Data API)...`);
    
    // Initial fetch to mark baseline
    await this.poll();

    // Start Loop
    this.pollInterval = setInterval(() => this.poll(), 2000) as unknown as NodeJS.Timeout; // Check every 2s
  }

  stop(): void {
    this.isPolling = false;
    if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = undefined;
    }
    this.deps.logger.info('Cb Monitor Stopped.');
  }

  private async poll() {
      if (this.targetWallets.size === 0) return;

      // We poll sequentially or in parallel batches to respect rate limits
      // Polymarket Data API is robust, but let's be polite.
      const targets = Array.from(this.targetWallets);
      
      for (const user of targets) {
          await this.checkUserActivity(user);
          // Small delay between users to spread load if many targets
          if (targets.length > 5) await new Promise(r => setTimeout(r, 100)); 
      }
      
      this.pruneCache();
  }

  private async checkUserActivity(user: string) {
      try {
          // Fetch last 5 activities to catch recent trades
          const url = `https://data-api.polymarket.com/activity?user=${user}&limit=5`;
          const res = await axios.get<PolyActivity[]>(url, { timeout: 3000 });
          
          if (!res.data || !Array.isArray(res.data)) return;

          // Filter for Trades only
          const trades = res.data.filter(a => a.type === 'TRADE' || a.type === 'ORDER_FILLED');

          // Sort by time ascending to process in order
          trades.sort((a, b) => a.timestamp - b.timestamp);

          for (const trade of trades) {
              await this.processTrade(user, trade);
          }
      } catch (e) {
          // Silent fail on network error, will retry next tick
      }
  }

  private async processTrade(user: string, activity: PolyActivity) {
      const txHash = activity.transactionHash;
      
      // 1. Deduplication
      if (this.processedHashes.has(txHash)) return;
      
      // 2. Age Check (Ignore trades older than 5 mins to prevent processing old history on restart)
      const now = Date.now();
      // Activity timestamp is in ms usually, but sometimes seconds. API is inconsistent.
      // Usually Data API returns ms.
      const tradeTime = activity.timestamp > 10000000000 ? activity.timestamp : activity.timestamp * 1000;
      
      if (now - tradeTime > 5 * 60 * 1000) {
          // Mark as processed so we don't check age again
          this.processedHashes.set(txHash, now);
          return;
      }

      // 3. Mark Processed
      this.processedHashes.set(txHash, now);

      // 4. Normalize Signal
      const outcomeLabel = activity.outcomeIndex === 0 ? "YES" : "NO";
      
      // Data API "side" is from the taker's perspective.
      // If type is "TRADE", it usually means they took liquidity.
      const side = activity.side.toUpperCase() as 'BUY' | 'SELL';
      
      const sizeUsd = activity.usdcSize || (activity.size * activity.price);
      
      this.deps.logger.info(`🚨 [SIGNAL] ${user.slice(0,6)}... ${side} ${outcomeLabel} @ ${activity.price} ($${sizeUsd.toFixed(2)})`);

      const signal: TradeSignal = {
          trader: user,
          marketId: activity.conditionId,
          tokenId: activity.asset,
          outcome: outcomeLabel as 'YES' | 'NO',
          side: side,
          sizeUsd: sizeUsd,
          price: activity.price,
          timestamp: tradeTime
      };

      // 5. Trigger Execution
      this.deps.onDetectedTrade(signal).catch(err => {
          this.deps.logger.error(`Execution Trigger Failed`, err);
      });
  }

  private pruneCache() {
      const now = Date.now();
      const TTL = 10 * 60 * 1000; // 10 mins
      
      if (this.processedHashes.size > 2000) {
          for (const [key, ts] of this.processedHashes.entries()) {
              if (now - ts > TTL) {
                  this.processedHashes.delete(key);
              }
          }
      }
  }
}
