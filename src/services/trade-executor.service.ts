
import type { RuntimeEnv } from '../config/env.js';
import type { Logger } from '../utils/logger.util.js';
import type { TradeSignal, ActivePosition } from '../domain/trade.types.js';
import { computeProportionalSizing } from '../config/copy-strategy.js';
import { httpGet } from '../utils/http.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';

export type TradeExecutorDeps = {
  adapter: IExchangeAdapter;
  env: RuntimeEnv;
  logger: Logger;
  proxyWallet: string; // Funder address
};

interface Position {
  conditionId: string;
  initialValue: number;
  currentValue: number;
}

export class TradeExecutorService {
  private readonly deps: TradeExecutorDeps;
  
  private balanceCache: Map<string, { value: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 Minutes Cache

  constructor(deps: TradeExecutorDeps) {
    this.deps = deps;
  }

  async executeManualExit(position: ActivePosition, currentPrice: number): Promise<boolean> {
      const { logger, adapter } = this.deps;
      try {
          logger.info(`📉 Executing Manual Exit (Auto-TP) for ${position.tokenId} @ ${currentPrice}`);
          
          await adapter.createOrder({
              marketId: position.marketId,
              tokenId: position.tokenId,
              outcome: position.outcome,
              side: 'SELL',
              sizeUsd: position.sizeUsd,
              priceLimit: 0 // Market sell
          });
          
          return true;
      } catch (e) {
          logger.error(`Failed to execute manual exit`, e as Error);
          return false;
      }
  }

  async copyTrade(signal: TradeSignal): Promise<string | number> {
    const { logger, env, adapter, proxyWallet } = this.deps;
    try {
      // 1. Get User Balance via Adapter
      const yourUsdBalance = await adapter.fetchBalance(proxyWallet);
      
      // 2. Get Whale Balance (Cached)
      const traderBalance = await this.getTraderBalance(signal.trader);

      // 3. Compute Size using Strategy
      const sizing = computeProportionalSizing({
        yourUsdBalance,
        traderUsdBalance: traderBalance,
        traderTradeUsd: signal.sizeUsd,
        multiplier: env.tradeMultiplier,
      });

      logger.info(`[Sizing] Whale: $${traderBalance.toFixed(0)} | Signal: $${signal.sizeUsd.toFixed(0)} | You: $${yourUsdBalance.toFixed(2)} | Target: $${sizing.targetUsdSize.toFixed(2)}`);

      if (sizing.targetUsdSize === 0) {
          if (yourUsdBalance < 0.50) {
             logger.warn(`❌ Skipped: Insufficient balance ($${yourUsdBalance.toFixed(2)}) for min trade.`);
          } else {
             logger.warn(`❌ Skipped: Calculated size $0.00 (Ratio too small).`);
          }
          return "skipped_small_size";
      }

      if (signal.side === 'BUY' && yourUsdBalance < sizing.targetUsdSize) {
          logger.error(`Insufficient USDC. Need: $${sizing.targetUsdSize.toFixed(2)}, Have: $${yourUsdBalance.toFixed(2)}`);
          return "insufficient_funds";
      }

      // 4. Execute via Adapter
      // Returns Order ID (String) or "filled"
      const result = await adapter.createOrder({
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        outcome: signal.outcome,
        side: signal.side,
        sizeUsd: sizing.targetUsdSize
      });
      
      return result;

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes('closed') || errorMessage.includes('resolved') || errorMessage.includes('No orderbook')) {
        logger.warn(`Skipping - Market closed/resolved.`);
      } else {
        logger.error(`Failed to copy trade: ${errorMessage}`, err as Error);
      }
      return "failed";
    }
  }

  private async getTraderBalance(trader: string): Promise<number> {
    const cached = this.balanceCache.get(trader);
    if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
        return cached.value;
    }

    try {
      const positions: Position[] = await httpGet<Position[]>(
        `https://data-api.polymarket.com/positions?user=${trader}`,
      );
      const totalValue = positions.reduce((sum, pos) => sum + (pos.currentValue || pos.initialValue || 0), 0);
      const val = Math.max(1000, totalValue);
      
      this.balanceCache.set(trader, { value: val, timestamp: Date.now() });
      return val;
    } catch {
      return 10000; // Fallback whale size
    }
  }
}
