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
  proxyWallet: string; // Funder address (Safe)
};

interface Position {
  conditionId: string;
  initialValue: number;
  currentValue: number;
}

export interface ExecutionResult {
    status: 'FILLED' | 'FAILED' | 'SKIPPED';
    txHash?: string;
    executedAmount: number; // USD Value
    executedShares: number; // Share Count
    reason?: string;
    priceFilled: number;
}

export class TradeExecutorService {
  private readonly deps: TradeExecutorDeps;
  
  private balanceCache: Map<string, { value: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 Minutes Cache for Whales
  
  // deduction tracker to prevent race conditions during high-frequency signals
  private pendingSpend = 0;
  private lastBalanceFetch = 0;

  constructor(deps: TradeExecutorDeps) {
    this.deps = deps;
  }

  /**
   * Manually exits a position. 
   * Uses Side-Aware pricing to check for Dust ($1.00 limit) before execution.
   */
  async executeManualExit(position: ActivePosition, currentPrice: number): Promise<boolean> {
      const { logger, adapter } = this.deps;
      try {
          // 1. Fetch REAL execution price (Best Bid) - Side-Aware Call
          const executionPrice = await adapter.getMarketPrice(position.marketId, position.tokenId, 'SELL');
          const finalPrice = executionPrice || currentPrice;
          const realExitValue = position.shares * finalPrice;

          logger.info(`📉 Manual Exit Request: ${position.shares} shares @ ~$${finalPrice.toFixed(3)}`);

          // 2. Pre-flight Dust Check (Prevents loops of failed orders)
          if (realExitValue < 1.0) {
              logger.error(`❌ Manual Exit Blocked: Position value ($${realExitValue.toFixed(2)}) is below the $1.00 CLOB minimum.`);
              return false;
          }

          // 3. Execute share-based sell to ensure 100% closure
          const result = await adapter.createOrder({
              marketId: position.marketId,
              tokenId: position.tokenId,
              outcome: position.outcome,
              side: 'SELL',
              sizeUsd: 0, 
              sizeShares: position.shares, 
              priceLimit: undefined 
          });
          
          return result.success;
      } catch (e) {
          logger.error(`Failed to execute manual exit`, e as Error);
          return false;
      }
  }

  /**
   * Copies a trade signal using proportional risk management.
   */
  async copyTrade(signal: TradeSignal): Promise<ExecutionResult> {
    const { logger, env, adapter, proxyWallet } = this.deps;
    
    const failResult = (reason: string): ExecutionResult => ({
        status: 'SKIPPED',
        executedAmount: 0,
        executedShares: 0,
        priceFilled: 0,
        reason
    });

    try {
      let usableBalanceForTrade = 0;

      // 1. Determine Source Capital (Cash vs Position)
      if (signal.side === 'BUY') {
          let chainBalance = 0;
          if (Date.now() - this.lastBalanceFetch > 10000) {
              chainBalance = await adapter.fetchBalance(proxyWallet);
              this.lastBalanceFetch = Date.now();
              this.pendingSpend = 0; 
          } else {
              chainBalance = await adapter.fetchBalance(proxyWallet); 
          }
          usableBalanceForTrade = Math.max(0, chainBalance - this.pendingSpend);
      } else {
          // SELL side logic
          const positions = await adapter.getPositions(proxyWallet);
          const myPosition = positions.find(p => p.tokenId === signal.tokenId);
          
          if (!myPosition || myPosition.balance <= 0) {
               return failResult("no_position_to_sell");
          }
          usableBalanceForTrade = myPosition.valueUsd;
      }

      // 2. Get Whale Balance
      const traderBalance = await this.getTraderBalance(signal.trader);

      // 3. Fetch ACTUAL execution price (Ask for Buy, Bid for Sell)
      const executionPrice = await adapter.getMarketPrice(signal.marketId, signal.tokenId, signal.side);
      const currentPrice = executionPrice || signal.price;

      // 4. Compute Size with Smart Boost and Share Minimums
      const sizing = computeProportionalSizing({
        yourUsdBalance: usableBalanceForTrade,
        traderUsdBalance: traderBalance,
        traderTradeUsd: signal.sizeUsd,
        multiplier: env.tradeMultiplier,
        currentPrice: currentPrice, 
        maxTradeAmount: env.maxTradeAmount
      });

      if (sizing.targetUsdSize < 1.00) {
          return failResult(sizing.reason || "skipped_size_too_small");
      }

      // 5. Calculate Price Limit (SLIPPAGE PROTECTION)
      let priceLimit = 0;
      const SLIPPAGE_PCT = 0.05; 

      if (signal.side === 'BUY') {
          priceLimit = currentPrice * (1 + SLIPPAGE_PCT);
          if (priceLimit > 0.99) priceLimit = 0.99;
      } else {
          priceLimit = currentPrice * (1 - SLIPPAGE_PCT);
          if (priceLimit < 0.01) priceLimit = 0.01;
      }

      // Tick alignment
      priceLimit = Math.floor(priceLimit * 100) / 100;
      if (priceLimit <= 0) priceLimit = 0.01;

      logger.info(`🛡️ Price Guard: Execution Side @ ${currentPrice.toFixed(3)} -> Limit @ ${priceLimit.toFixed(2)}`);

      // 6. Execute via Adapter
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
              reason: result.error || 'adapter_rejection'
          };
      }

      if (signal.side === 'BUY') {
         this.pendingSpend += sizing.targetUsdSize;
      }
      
      return {
          status: 'FILLED',
          txHash: result.txHash || result.orderId,
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