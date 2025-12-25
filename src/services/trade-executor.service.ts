import type { RuntimeEnv } from '../config/env.js';
import type { Logger } from '../utils/logger.util.js';
import type { TradeSignal, ActivePosition } from '../domain/trade.types.js';
import { computeProportionalSizing } from '../config/copy-strategy.js';
import { httpGet } from '../utils/http.js';
import { IExchangeAdapter, LiquidityHealth } from '../adapters/interfaces.js';

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

export interface ExecutionResult {
    status: 'FILLED' | 'FAILED' | 'SKIPPED' | 'ILLIQUID';
    txHash?: string;
    executedAmount: number; // USD Value
    executedShares: number; // Share Count
    priceFilled: number;    
    reason?: string;
}

export class TradeExecutorService {
  private readonly deps: TradeExecutorDeps;
  
  private balanceCache: Map<string, { value: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; 
  
  private pendingSpend = 0;

  constructor(deps: TradeExecutorDeps) {
    this.deps = deps;
  }

  async executeManualExit(position: ActivePosition, currentPrice: number): Promise<boolean> {
      const { logger, adapter } = this.deps;
      let remainingShares = position.shares;
      
      try {
          logger.info(`📉 Executing Market Exit: Offloading ${remainingShares} shares of ${position.tokenId}...`);
          
          const result = await adapter.createOrder({
              marketId: position.marketId,
              tokenId: position.tokenId,
              outcome: position.outcome,
              side: 'SELL',
              sizeUsd: 0, 
              sizeShares: remainingShares,
              priceLimit: 0.001 
          });
          
          if (result.success) {
              const filled = result.sharesFilled || 0;
              const diff = position.shares - filled;
              
              if (diff > 0.01) {
                  logger.warn(`⚠️ Partial Fill: Only liquidated ${filled}/${position.shares} shares. ${diff.toFixed(2)} shares remain stuck due to book depth.`);
                  if (diff < 5) {
                      logger.error(`🚨 Residual Dust: Remaining ${diff.toFixed(2)} shares are below exchange minimum (5). These cannot be sold until you buy more.`);
                  }
              }
              
              logger.success(`Exit summary: Liquidated ${filled.toFixed(2)} shares @ avg best possible price.`);
              return true;
          } else {
              logger.error(`Exit attempt failed: ${result.error || "Unknown Error"}`);
              return false;
          }
          
      } catch (e: any) {
          logger.error(`Failed to execute manual exit: ${e.message}`, e as Error);
          return false;
      }
  }

  async copyTrade(signal: TradeSignal): Promise<ExecutionResult> {
    const { logger, env, adapter, proxyWallet } = this.deps;
    
    const failResult = (reason: string, status: 'SKIPPED' | 'FAILED' | 'ILLIQUID' = 'SKIPPED'): ExecutionResult => ({
        status,
        executedAmount: 0,
        executedShares: 0,
        priceFilled: 0,
        reason
    });

    try {
      // UPDATED LIQUIDITY GUARD:
      // Binary prediction markets use absolute spreads. 
      // This filter now correctly accepts 1-cent gaps even if the percentage is high.
      // PRE-FLIGHT LIQUIDITY GUARD
      if (this.deps.adapter.getLiquidityMetrics) {
          const metrics = await this.deps.adapter.getLiquidityMetrics(signal.tokenId, signal.side);
          const minRequired = (this.deps.env as any).minLiquidityFilter || 'LOW';
          
          const ranks: Record<string, number> = { 
              [LiquidityHealth.HIGH]: 3, 
              [LiquidityHealth.MEDIUM]: 2, 
              [LiquidityHealth.LOW]: 1, 
              [LiquidityHealth.CRITICAL]: 0 
          };
          
          if (ranks[metrics.health] < ranks[minRequired]) {
              // Log ABSOLUTE spread in cents, not percentage
              const msg = `[Liquidity Filter] Health: ${metrics.health} (Min: ${minRequired}) | Spread: ${(metrics.spread * 100).toFixed(1)}¢ | Depth: $${metrics.availableDepthUsd.toFixed(0)} -> SKIPPING`;
              logger.warn(msg);
              return failResult("insufficient_liquidity", "ILLIQUID");
          }
          
          // Log successful pass for transparency
          logger.info(`[Liquidity OK] Health: ${metrics.health} | Spread: ${(metrics.spread * 100).toFixed(1)}¢ | Depth: $${metrics.availableDepthUsd.toFixed(0)}`);
      }

      let usableBalanceForTrade = 0;

      if (signal.side === 'BUY') {
          const chainBalance = await adapter.fetchBalance(proxyWallet);
          usableBalanceForTrade = Math.max(0, chainBalance - this.pendingSpend);
      } else {
          const positions = await adapter.getPositions(proxyWallet);
          const myPosition = positions.find(p => p.tokenId === signal.tokenId);
          if (!myPosition || myPosition.balance <= 0) return failResult("no_position_to_sell");
          usableBalanceForTrade = myPosition.valueUsd;
      }

      const traderBalance = await this.getTraderBalance(signal.trader);

      let minOrderSize = 5; 
      try {
          const book = await adapter.getOrderBook(signal.tokenId);
          if (book.min_order_size) minOrderSize = Number(book.min_order_size);
      } catch (e) {}

      const sizing = computeProportionalSizing({
        yourUsdBalance: usableBalanceForTrade,
        traderUsdBalance: traderBalance,
        traderTradeUsd: signal.sizeUsd,
        multiplier: env.tradeMultiplier,
        currentPrice: signal.price,
        maxTradeAmount: env.maxTradeAmount,
        minOrderSize: minOrderSize 
      });

      if (sizing.targetUsdSize < 1.00 || sizing.targetShares < minOrderSize) {
          if (usableBalanceForTrade < 1.00) return failResult("skipped_insufficient_balance_min_1");
          return failResult(sizing.reason || "skipped_size_too_small");
      }

      let priceLimit: number | undefined = undefined;
      if (signal.side === 'BUY') {
          priceLimit = Math.min(0.99, signal.price * 1.05);
      } else {
          priceLimit = Math.max(0.001, signal.price * 0.90);
      }

      logger.info(`[Sizing] Whale: $${traderBalance.toFixed(0)} | Signal: $${signal.sizeUsd.toFixed(0)} (${signal.side}) | Target: $${sizing.targetUsdSize.toFixed(2)} (${sizing.targetShares} shares)`);

      const result = await adapter.createOrder({
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        outcome: signal.outcome,
        side: signal.side,
        sizeUsd: sizing.targetUsdSize,
        priceLimit: priceLimit
      });

      if (!result.success) {
          return {
              status: 'FAILED',
              executedAmount: 0,
              executedShares: 0,
              priceFilled: 0,
              reason: result.error || 'Unknown error'
          };
      }

      if (signal.side === 'BUY') this.pendingSpend += sizing.targetUsdSize;
      
      return {
          status: 'FILLED',
          txHash: result.orderId || result.txHash,
          executedAmount: result.sharesFilled * result.priceFilled,
          executedShares: result.sharesFilled,
          priceFilled: result.priceFilled,
          reason: 'executed'
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to copy trade: ${errorMessage}`, err as Error);
      return {
            status: 'FAILED',
            executedAmount: 0,
            executedShares: 0,
            priceFilled: 0,
            reason: errorMessage
      };
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
      return 10000; 
    }
  }
}
