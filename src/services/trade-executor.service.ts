
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

export interface ExecutionResult {
    status: 'FILLED' | 'FAILED' | 'SKIPPED';
    txHash?: string;
    executedAmount: number;
    reason?: string;
}

export class TradeExecutorService {
  private readonly deps: TradeExecutorDeps;
  
  private balanceCache: Map<string, { value: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 Minutes Cache for Whales
  
  // NEW: Local deduction tracker to prevent race conditions
  private pendingSpend = 0;
  private lastBalanceFetch = 0;

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

  async copyTrade(signal: TradeSignal): Promise<ExecutionResult> {
    const { logger, env, adapter, proxyWallet } = this.deps;
    
    // Default Failure Result
    const failResult = (reason: string): ExecutionResult => ({
        status: 'SKIPPED',
        executedAmount: 0,
        reason
    });

    try {
      // 1. Get User Balance (Real-time + Local Adjustment)
      // Only fetch from chain every 10 seconds to save RPC, otherwise rely on local decrement
      let chainBalance = 0;
      if (Date.now() - this.lastBalanceFetch > 10000) {
          chainBalance = await adapter.fetchBalance(proxyWallet);
          this.lastBalanceFetch = Date.now();
          this.pendingSpend = 0; // Reset pending on fresh chain sync
      } else {
          // If we haven't synced recently, assume chain balance is same as last known
           chainBalance = await adapter.fetchBalance(proxyWallet); 
      }

      const effectiveBalance = Math.max(0, chainBalance - this.pendingSpend);
      
      // 2. Get Whale Balance
      const traderBalance = await this.getTraderBalance(signal.trader);

      // 3. Compute Size
      const sizing = computeProportionalSizing({
        yourUsdBalance: effectiveBalance,
        traderUsdBalance: traderBalance,
        traderTradeUsd: signal.sizeUsd,
        multiplier: env.tradeMultiplier,
        currentPrice: signal.price,
        maxTradeAmount: env.maxTradeAmount
      });

      const profileUrl = `https://polymarket.com/profile/${signal.trader}`;
      logger.info(`[Sizing] Whale: $${traderBalance.toFixed(0)} | Signal: $${signal.sizeUsd.toFixed(0)} | You: $${effectiveBalance.toFixed(2)} | Target: $${sizing.targetUsdSize.toFixed(2)} (${sizing.reason})`);
      logger.info(`🔗 Trader: ${profileUrl}`);

      if (sizing.targetUsdSize < 0.50) {
          // Polymarket minimum is technically low, but usually <$1 orders are unreliable.
          // We allow >$0.50 to handle small tests, but <$0.10 is dust.
          if (effectiveBalance < 0.50) return failResult("skipped_insufficient_balance");
          // If the calculated size is dust but we have funds, it means the whale bet was tiny relative to ratio.
          if (sizing.targetUsdSize < 0.10) return failResult("skipped_dust_size");
      }

      if (signal.side === 'BUY' && effectiveBalance < sizing.targetUsdSize) {
          logger.error(`Insufficient USDC. Need: $${sizing.targetUsdSize.toFixed(2)}, Have: $${effectiveBalance.toFixed(2)}`);
          return failResult("insufficient_funds");
      }

      // 4. Calculate Price Limit (SLIPPAGE PROTECTION)
      // We essentially want to limit how much WORSE we buy than the signal.
      let priceLimit = 0;
      const SLIPPAGE_PCT = 0.05; // 5% tolerance

      if (signal.side === 'BUY') {
          // Buying: Limit is Higher than signal
          priceLimit = signal.price * (1 + SLIPPAGE_PCT);
          // Hard Clamp: Never buy > 0.99
          if (priceLimit > 0.99) priceLimit = 0.99;
          // Floor Clamp: Never limit < 0.01 (or orders fail)
          if (priceLimit < 0.01) priceLimit = 0.01;
      } else {
          // Selling: Limit is Lower than signal (Not typically used for copy-buy, but for exit)
          priceLimit = signal.price * (1 - SLIPPAGE_PCT);
          if (priceLimit < 0.01) priceLimit = 0.01;
      }

      // Round to 2 decimals for cleaner logs/API, but ensure we don't round down to 0
      priceLimit = Math.floor(priceLimit * 100) / 100;
      if (priceLimit <= 0) priceLimit = 0.01;

      logger.info(`🛡️ Price Guard: Signal @ ${signal.price.toFixed(3)} -> Limit @ ${priceLimit.toFixed(2)}`);

      // 5. Execute via Adapter
      const orderIdOrHash = await adapter.createOrder({
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        outcome: signal.outcome,
        side: signal.side,
        sizeUsd: sizing.targetUsdSize,
        priceLimit: priceLimit
      });

      // 6. Check Result
      // The adapter returns a string. It might be "failed", "skipped...", or a TxHash/OrderID.
      
      // Known failure strings from adapter
      if (orderIdOrHash === "failed" || orderIdOrHash.includes("skipped") || orderIdOrHash.includes("insufficient")) {
          return {
              status: 'FAILED',
              executedAmount: 0,
              reason: orderIdOrHash
          };
      }

      // 7. Success - Update Pending Spend
      // We assume money is gone until next chain sync proves otherwise
      this.pendingSpend += sizing.targetUsdSize;
      
      return {
          status: 'FILLED',
          txHash: orderIdOrHash, // This is the Tx Hash or Order ID
          executedAmount: sizing.targetUsdSize,
          reason: 'executed'
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes('closed') || errorMessage.includes('resolved') || errorMessage.includes('No orderbook')) {
        logger.warn(`Skipping - Market closed/resolved.`);
        return failResult("market_closed");
      } else {
        logger.error(`Failed to copy trade: ${errorMessage}`, err as Error);
        return {
            status: 'FAILED',
            executedAmount: 0,
            reason: errorMessage
        };
      }
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
