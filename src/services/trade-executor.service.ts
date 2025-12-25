
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
    executedAmount: number; // USD Value
    executedShares: number; // Share Count
    priceFilled: number;    // Fixed: Added property to match bot-engine usage
    reason?: string;
}

export class TradeExecutorService {
  private readonly deps: TradeExecutorDeps;
  
  private balanceCache: Map<string, { value: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 Minutes Cache for Whales
  
  // Local deduction tracker to prevent race conditions
  private pendingSpend = 0;
  private lastBalanceFetch = 0;

  constructor(deps: TradeExecutorDeps) {
    this.deps = deps;
  }

  /**
   * Execute Exit sells SHARES, not USD amount, ensuring 100% closure regardless of price
   */
  async executeManualExit(position: ActivePosition, currentPrice: number): Promise<boolean> {
      const { logger, adapter } = this.deps;
      let remainingShares = position.shares;
      let totalSold = 0;
      
      try {
          logger.info(`📉 Executing Manual Exit: Selling ${remainingShares} shares of ${position.tokenId} (Ref Price: ${currentPrice})`);
          
          // Try market sell first (priceLimit: 0)
          const result = await adapter.createOrder({
              marketId: position.marketId,
              tokenId: position.tokenId,
              outcome: position.outcome,
              side: 'SELL',
              sizeUsd: 0, 
              sizeShares: remainingShares,
              priceLimit: 0 // Market sell (hit the bid)
          });
          
          if (result.success && result.sharesFilled) {
              remainingShares -= result.sharesFilled;
              totalSold += result.sharesFilled;
              logger.info(`Sold ${result.sharesFilled} shares, ${remainingShares} remaining`);
          }
          
          // If we still have shares to sell, try progressively lower prices
          if (remainingShares > 0) {
              logger.warn(`${remainingShares} shares remaining, trying progressive price reduction...`);
              
              const priceLevels = [currentPrice * 0.5, currentPrice * 0.25, currentPrice * 0.1, 0.01];
              
              for (const price of priceLevels) {
                  if (price < 0.01 || remainingShares <= 0) continue;
                  
                  logger.info(`Trying to sell ${remainingShares} shares at ${price.toFixed(3)}...`);
                  const fallbackResult = await adapter.createOrder({
                      marketId: position.marketId,
                      tokenId: position.tokenId,
                      outcome: position.outcome,
                      side: 'SELL',
                      sizeUsd: 0,
                      sizeShares: remainingShares,
                      priceLimit: price
                  });
                  
                  if (fallbackResult.success && fallbackResult.sharesFilled) {
                      remainingShares -= fallbackResult.sharesFilled;
                      totalSold += fallbackResult.sharesFilled;
                      logger.success(`Sold ${fallbackResult.sharesFilled} shares at ${price.toFixed(3)}, ${remainingShares} remaining`);
                  }
              }
          }
          
          if (totalSold > 0) {
              logger.success(`Exit completed: Sold ${totalSold}/${position.shares} shares total`);
              return true;
          } else {
              logger.error(`All exit attempts failed for ${position.tokenId}`);
              return false;
          }
          
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
        executedShares: 0,
        priceFilled: 0,
        reason
    });

    try {
      let usableBalanceForTrade = 0;

      // 1. Determine Source Capital (Cash vs Position)
      if (signal.side === 'BUY') {
          // BUY: Use Wallet Cash
          let chainBalance = 0;
          chainBalance = await adapter.fetchBalance(proxyWallet);
          usableBalanceForTrade = Math.max(0, chainBalance - this.pendingSpend);
      } else {
          // SELL: Use Existing Position Value
          const positions = await adapter.getPositions(proxyWallet);
          const myPosition = positions.find(p => p.tokenId === signal.tokenId);
          
          if (!myPosition || myPosition.balance <= 0) {
               return failResult("no_position_to_sell");
          }
          usableBalanceForTrade = myPosition.valueUsd;
      }

      // 2. Get Whale Balance (Total Portfolio Value)
      const traderBalance = await this.getTraderBalance(signal.trader);

      // 3. Fetch market's minimum order size
      let minOrderSize = 5; // Default
      try {
          const book = await adapter.getOrderBook(signal.tokenId);
          if (book.min_order_size) {
              minOrderSize = Number(book.min_order_size);
          }
      } catch (e) {
          logger.debug(`Using default minOrderSize: ${minOrderSize}`);
      }

      // 4. Compute Size with minOrderSize and Directional intent
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

      // 5. Calculate Price Limit (SLIPPAGE PROTECTION)
      let priceLimit = 0;
      const SLIPPAGE_PCT = 0.05; 

      if (signal.side === 'BUY') {
          // BUY: Willing to pay slightly more
          priceLimit = signal.price * (1 + SLIPPAGE_PCT);
          if (priceLimit > 0.99) priceLimit = 0.99;
      } else {
          // SELL: Willing to accept slightly less
          priceLimit = signal.price * (1 - SLIPPAGE_PCT);
          if (priceLimit < 0.01) priceLimit = 0.01;
      }

      // 6. Log sizing info with new share-count transparency
      logger.info(`[Sizing] Whale: $${traderBalance.toFixed(0)} | Signal: $${signal.sizeUsd.toFixed(0)} (${signal.side}) | You: $${usableBalanceForTrade.toFixed(2)} | Target: $${sizing.targetUsdSize.toFixed(2)} (${sizing.targetShares} shares)`);

      // 7. Execute via Adapter
      const result = await adapter.createOrder({
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        outcome: signal.outcome,
        side: signal.side,
        sizeUsd: sizing.targetUsdSize,
        priceLimit: priceLimit
      });

      // 8. Check Result
      if (!result.success) {
          return {
              status: 'FAILED',
              executedAmount: 0,
              executedShares: 0,
              priceFilled: 0,
              reason: result.error || 'Unknown error'
          };
      }

      // 9. Success - Update Pending Spend (Only for Buys)
      if (signal.side === 'BUY') {
         this.pendingSpend += sizing.targetUsdSize;
      }
      
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