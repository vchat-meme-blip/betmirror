import type { ClobClient } from '@polymarket/clob-client';
import type { RuntimeEnv } from '../config/env';
import type { Logger } from '../utils/logger.util';
import type { TradeSignal } from '../domain/trade.types';
import { httpGet } from '../utils/fetch-data.util';
import axios from 'axios';

export type TradeMonitorDeps = {
  client: ClobClient;
  env: RuntimeEnv;
  logger: Logger;
  userAddresses: string[];
  onDetectedTrade: (signal: TradeSignal) => Promise<void>;
};

interface ActivityResponse {
  type: string;
  timestamp: number;
  conditionId: string;
  asset: string;
  size: number;
  usdcSize: number;
  price: number;
  side: string;
  outcomeIndex: number;
  transactionHash: string;
}

export class TradeMonitorService {
  private readonly deps: TradeMonitorDeps;
  private timer: any;
  private readonly processedHashes: Set<string> = new Set();
  private readonly lastFetchTime: Map<string, number> = new Map();
  private isPolling = false;

  constructor(deps: TradeMonitorDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    const { logger, env } = this.deps;
    logger.info(
      `Initializing Monitor for ${this.deps.userAddresses.length} target wallets...`,
    );
    
    // Initial sync
    await this.tick();
    
    // Setup robust polling
    this.timer = setInterval(async () => {
        if (this.isPolling) return; // Prevent overlap
        this.isPolling = true;
        try {
            await this.tick();
        } catch (e) {
            console.error(e);
        } finally {
            this.isPolling = false;
        }
    }, env.fetchIntervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.isPolling = false;
  }

  private async tick(): Promise<void> {
    const { logger, env } = this.deps;
    
    // Process wallets in parallel chunks to avoid blocking
    const chunkSize = 3;
    for (let i = 0; i < this.deps.userAddresses.length; i += chunkSize) {
        const chunk = this.deps.userAddresses.slice(i, i + chunkSize);
        await Promise.all(chunk.map(trader => {
            if (!trader || trader.length < 10) return Promise.resolve();
            return this.fetchTraderActivities(trader, env);
        }));
    }
  }

  private async fetchTraderActivities(trader: string, env: RuntimeEnv): Promise<void> {
    try {
      // In production, we would use a dedicated indexer or WebSocket subscription
      const url = `https://data-api.polymarket.com/activity?user=${trader}&limit=20`;
      const activities: ActivityResponse[] = await httpGet<ActivityResponse[]>(url);

      if (!activities || !Array.isArray(activities)) return;

      const now = Math.floor(Date.now() / 1000);
      // Increased lookback window for reliability
      const cutoffTime = now - Math.max(env.aggregationWindowSeconds, 600); 

      for (const activity of activities) {
        if (activity.type !== 'TRADE' && activity.type !== 'ORDER_FILLED') continue;

        const activityTime = typeof activity.timestamp === 'number' ? activity.timestamp : Math.floor(new Date(activity.timestamp).getTime() / 1000);
        
        // Skip old trades
        if (activityTime < cutoffTime) continue;
        
        // Dedup logic
        if (this.processedHashes.has(activity.transactionHash)) continue;

        // Skip trades we've already seen based on time cursor
        const lastTime = this.lastFetchTime.get(trader) || 0;
        if (activityTime <= lastTime) continue;

        const signal: TradeSignal = {
          trader,
          marketId: activity.conditionId,
          tokenId: activity.asset,
          outcome: activity.outcomeIndex === 0 ? 'YES' : 'NO',
          side: activity.side.toUpperCase() as 'BUY' | 'SELL',
          sizeUsd: activity.usdcSize || (activity.size * activity.price),
          price: activity.price,
          timestamp: activityTime * 1000,
        };

        this.deps.logger.info(`[SIGNAL] ${signal.side} ${signal.outcome} @ ${signal.price} ($${signal.sizeUsd.toFixed(0)}) from ${trader.slice(0,6)}`);

        this.processedHashes.add(activity.transactionHash);
        this.lastFetchTime.set(trader, Math.max(this.lastFetchTime.get(trader) || 0, activityTime));

        await this.deps.onDetectedTrade(signal);
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return; 
      }
      // Suppress minor network errors
      if (err instanceof Error && !err.message.includes('Network Error')) {
          this.deps.logger.warn(`Fetch error for ${trader.slice(0,6)}: ${err.message}`);
      }
    }
  }
}