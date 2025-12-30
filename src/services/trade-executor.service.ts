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
  balance: string; // share balance
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

  // Check if market resolved and which outcome won
  private async checkMarketResolution(position: ActivePosition): Promise<{
    resolved: boolean;
    winningOutcome?: string;
    userWon?: boolean;
    market?: any;
    conditionId?: string;
}> {
    // Debug log to verify method is being called
    console.log('🔍 checkMarketResolution called with position:', {
      tradeId: position.tradeId,
      marketId: position.marketId,
      conditionId: position.conditionId,
      outcome: position.outcome
    });

    const { logger, adapter } = this.deps;
    const conditionId = position.conditionId; // Moved outside try block for catch block access
    
    try {
        const client = (adapter as any).getRawClient?.();
        if (!client) {
            logger.warn('❌ No CLOB client available for market resolution check');
            return { resolved: false, conditionId };
        }
        
        logger.info(`🔍 Fetching market with conditionId: ${conditionId}`);
        
        const market = await client.getMarket(conditionId);
        
        if (!market) {
            logger.warn(`❌ Market not found for conditionId: ${conditionId}`);
            return { resolved: false, conditionId };
        }

        // Log the ACTUAL Market interface fields from API
        logger.info(`📊 Market data received: ${JSON.stringify({
            condition_id: market.condition_id,
            closed: market.closed,
            active: market.active,
            accepting_orders: market.accepting_orders,
            archived: market.archived,
            question: market.question?.substring(0, 50),
            neg_risk: market.neg_risk
        }, null, 2)}`);

        // Log tokens array - this is where winner info lives
        if (market.tokens) {
            logger.info(`🎯 Token data: ${JSON.stringify(market.tokens.map((t: any) => ({
                outcome: t.outcome,
                winner: t.winner,
                token_id: t.token_id?.substring(0, 20) + '...',
                price: t.price
            })), null, 2)}`);
        }

        // KEY FIX: Use market.closed as primary resolution indicator
        // The Market interface shows: closed: boolean
        const isResolved = market.closed === true;
        
        logger.info(`📌 Resolution check: closed=${market.closed}, isResolved=${isResolved}`);

        if (!isResolved) {
            logger.debug(`⏳ Market ${conditionId} is not resolved yet`);
            return { resolved: false, market, conditionId };
        }

        // Find winning outcome from tokens[].winner (boolean field)
        let winningOutcome: string | undefined;
        let userWon = false;

        if (market.tokens && Array.isArray(market.tokens)) {
            const winningToken = market.tokens.find((t: any) => t.winner === true);
            
            logger.info(`🏆 Winning token search: ${JSON.stringify({
                foundWinner: !!winningToken,
                winningOutcome: winningToken?.outcome,
                userOutcome: position.outcome
            }, null, 2)}`);
            
            if (winningToken) {
                winningOutcome = winningToken.outcome;
                // Direct case-insensitive comparison
                userWon = position.outcome.toUpperCase() === winningOutcome?.toUpperCase();
                
                logger.info(`✅ Resolution result: winningOutcome=${winningOutcome}, userOutcome=${position.outcome}, userWon=${userWon}`);
            } else {
                logger.warn(`⚠️ Market closed but no winning token found - may still be settling`);
            }
        } else {
            logger.warn(`⚠️ No tokens array in market response`);
        }

        return { 
            resolved: true, 
            winningOutcome, 
            userWon, 
            market,
            conditionId
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Error checking market resolution: ${errorMessage}`);
        
        // 404 likely means market doesn't exist in CLOB anymore (resolved/archived)
        if (errorMessage.includes("404") || errorMessage.includes("Not Found")) {
            logger.info(`ℹ️ Market returned 404 - likely fully resolved and archived`);
            return { resolved: true, conditionId };
        }
        
        return { resolved: false };
    }
}

  async executeManualExit(position: ActivePosition, currentPrice: number): Promise<boolean> {
      console.log('🚀 executeManualExit called with:', {
        positionId: position.tradeId,
        marketId: position.marketId,
        shares: position.shares,
        currentPrice
      });
      
      const { logger, adapter } = this.deps;
      let remainingShares = position.shares;
      
      try {
          // Hard check for exchange minimums before even trying
          if (remainingShares < 5) {
              logger.error(`🚨 Cannot Exit: Your balance (${remainingShares.toFixed(2)}) is below the exchange minimum of 5 shares. You must buy more of this asset to liquidate it.`);
              return false;
          }

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
              }
              
              logger.success(`Exit summary: Liquidated ${filled.toFixed(2)} shares @ avg best possible price.`);
              return true;
          } else {
              // Check if this is a resolved market that needs proper redemption logic
              if (result.error?.includes("No orderbook") || result.error?.includes("404")) {
                  logger.info(`Market appears resolved. Checking resolution status...`);
                  
                  const resolution = await this.checkMarketResolution(position);
                  
                  if (resolution.resolved) {
                      if (resolution.userWon) {
                          logger.success(`Market resolved in your favor! Winning outcome: ${resolution.winningOutcome}`);
                          
                          // Use the conditionId from the market resolution if available, fall back to position.marketId
                          const conditionId = resolution.conditionId || position.marketId;
                          logger.info(`Redeeming position with conditionId: ${conditionId}`);
                          
                          const redeemResult = await adapter.redeemPosition(conditionId, position.tokenId);
                          if (redeemResult.success) {
                              logger.success(`Redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                              return true;
                          } else {
                              logger.error(`Redemption failed: ${redeemResult.error || 'Unknown error'}`);
                              
                              // Try with marketId as fallback if conditionId didn't work
                              if (conditionId !== position.marketId) {
                                  logger.warn(`Retrying redemption with marketId as conditionId...`);
                                  const fallbackResult = await adapter.redeemPosition(position.marketId, position.tokenId);
                                  if (fallbackResult.success) {
                                      logger.success(`Successfully redeemed with fallback method: $${fallbackResult.amountUsd?.toFixed(2)} USDC`);
                                      return true;
                                  }
                              }
                              
                              return false;
                          }
                      } else {
                          const message = `Market resolved but you did not win. Winning outcome: ${resolution.winningOutcome || 'Unknown'}, Your position: ${position.outcome}`;
                          logger.warn(message);
                          
                          // Even if user didn't win, try to redeem as some markets might have partial payouts
                          try {
                              const conditionId = resolution.conditionId || position.marketId;
                              logger.info(`Attempting to redeem losing position with conditionId: ${conditionId}`);
                              const redeemResult = await adapter.redeemPosition(conditionId, position.tokenId);
                              
                              if (redeemResult.success) {
                                  logger.success(`Redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC from losing position`);
                                  return true;
                              }
                          } catch (e: unknown) {
                              const errorMessage = e instanceof Error ? e.message : 'Unknown error';
                              logger.warn(`Could not redeem losing position: ${errorMessage}`);
                          }
                          
                          logger.warn(`No further redemption possible - this position has expired worthless.`);
                          return false;
                      }
                  } else {
                      logger.warn(`Market status unclear. Attempting redemption as fallback...`);
                      const redeemResult = await adapter.redeemPosition(position.marketId, position.tokenId);
                      if (redeemResult.success) {
                          logger.success(`Redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                          return true;
                      } else {
                          logger.error(`Redemption failed: ${redeemResult.error}`);
                          return false;
                      }
                  }
              }
              
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
      // MARKET VALIDATION - Check if market is still tradeable
      try {
        const market = await (adapter as any).getRawClient().getMarket(signal.marketId);
        
        if (!market) {
          logger.warn(`[Market Not Found] ${signal.marketId} - Skipping`);
          return failResult("market_not_found");
        }
        if (market.closed) {
          logger.warn(`[Market Closed] ${signal.marketId} - Skipping`);
          return failResult("market_closed");
        }
        if (!market.active || !market.accepting_orders) {
          logger.warn(`[Market Inactive] ${signal.marketId} - Skipping`);
          return failResult("market_not_accepting_orders");
        }
        if (market.archived) {
          logger.warn(`[Market Archived] ${signal.marketId} - Skipping`);
          return failResult("market_archived");
        }
      } catch (e: any) {
        if (e.message?.includes("404") || e.message?.includes("No orderbook") || String(e).includes("404")) {
          logger.warn(`[Market Resolved] ${signal.marketId} - Attempting to redeem existing position`);
          
          // Try to redeem existing position if market is resolved
          try {
            const positions = await adapter.getPositions(proxyWallet);
            const existingPosition = positions.find(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
            
            if (existingPosition) {
              logger.info(`[Auto-Redeem] Found position: ${existingPosition.balance} shares of ${signal.outcome}`);
              const redeemResult = await adapter.redeemPosition(signal.marketId, existingPosition.tokenId);
              
              if (redeemResult.success) {
                logger.success(`[Auto-Redeem] Successfully redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                return {
                  status: 'FILLED',
                  executedAmount: redeemResult.amountUsd || 0,
                  executedShares: existingPosition.balance,
                  priceFilled: 1.0,
                  reason: 'Auto-redeemed resolved market position'
                };
              } else {
                logger.error(`[Auto-Redeem] Failed: ${redeemResult.error}`);
                return failResult("redemption_failed", 'FAILED');
              }
            } else {
              logger.warn(`[Auto-Redeem] No existing position found for ${signal.marketId}`);
              return failResult("orderbook_not_found");
            }
          } catch (redeemError: any) {
            logger.error(`[Auto-Redeem] Error during redemption: ${redeemError.message}`);
            return failResult("redemption_error", 'FAILED');
          }
        }
        throw e;
      }
      if (this.deps.adapter.getLiquidityMetrics) {
          try {
              const metrics = await this.deps.adapter.getLiquidityMetrics(signal.tokenId, signal.side);
              const minRequired = (this.deps.env as any).minLiquidityFilter || 'LOW';
              
              const ranks: Record<string, number> = { 
                  [LiquidityHealth.HIGH]: 3, 
                  [LiquidityHealth.MEDIUM]: 2, 
                  [LiquidityHealth.LOW]: 1, 
                  [LiquidityHealth.CRITICAL]: 0 
              };
              
              if (ranks[metrics.health] < ranks[minRequired]) {
                  const msg = `[Liquidity Filter] Health: ${metrics.health} (Min: ${minRequired}) | Spread: ${(metrics.spread * 100).toFixed(1)}¢ | Depth: $${metrics.availableDepthUsd.toFixed(0)} -> SKIPPING`;
                  logger.warn(msg);
                  return failResult("insufficient_liquidity", "ILLIQUID");
              }
              logger.info(`[Liquidity OK] Health: ${metrics.health} | Spread: ${(metrics.spread * 100).toFixed(1)}¢ | Depth: $${metrics.availableDepthUsd.toFixed(0)}`);
          } catch (e: any) {
              // Check if this is a resolved market (404/No orderbook)
              if (e.message?.includes("404") || e.message?.includes("No orderbook") || String(e).includes("404")) {
                  logger.warn(`[Market Resolved] ${signal.marketId} - Attempting to redeem existing position (liquidity check)`);
                  
                  // Try to redeem existing position if market is resolved
                  try {
                      const positions = await adapter.getPositions(proxyWallet);
                      const existingPosition = positions.find(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                      
                      if (existingPosition) {
                          logger.info(`[Auto-Redeem] Found position: ${existingPosition.balance} shares of ${signal.outcome}`);
                          const redeemResult = await adapter.redeemPosition(signal.marketId, existingPosition.tokenId);
                          
                          if (redeemResult.success) {
                              logger.success(`[Auto-Redeem] Successfully redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                              return {
                                  status: 'FILLED',
                                  executedAmount: redeemResult.amountUsd || 0,
                                  executedShares: existingPosition.balance,
                                  priceFilled: 1.0,
                                  reason: 'Auto-redeemed resolved market position'
                              };
                          } else {
                              logger.error(`[Auto-Redeem] Failed: ${redeemResult.error}`);
                              return failResult("redemption_failed", 'FAILED');
                          }
                      } else {
                          logger.warn(`[Auto-Redeem] No existing position found for ${signal.marketId}`);
                          return failResult("orderbook_not_found");
                      }
                  } catch (redeemError: any) {
                      logger.error(`[Auto-Redeem] Error during redemption: ${redeemError.message}`);
                      return failResult("redemption_error", 'FAILED');
                  }
              }
              throw e;
          }
      }

      let usableBalanceForTrade = 0;
      let currentShareBalance = 0;

      const positions = await adapter.getPositions(proxyWallet);
      const myPosition = positions.find(p => p.tokenId === signal.tokenId);
      if (myPosition) {
          currentShareBalance = myPosition.balance;
      }

      if (signal.side === 'BUY') {
          const chainBalance = await adapter.fetchBalance(proxyWallet);
          usableBalanceForTrade = Math.max(0, chainBalance - this.pendingSpend);
      } else {
          if (!myPosition || myPosition.balance <= 0) return failResult("no_position_to_sell");
          usableBalanceForTrade = myPosition.valueUsd;
      }

      const traderBalance = await this.getTraderBalance(signal.trader);

      // Check for insufficient funds BEFORE sizing computation
      if (signal.side === 'BUY' && usableBalanceForTrade < 1) {
          const chainBalance = await adapter.fetchBalance(proxyWallet);
          return failResult(`insufficient_funds (balance: $${chainBalance.toFixed(2)}, pending: $${this.pendingSpend.toFixed(2)}, available: $${usableBalanceForTrade.toFixed(2)})`, "FAILED");
      }

      let minOrderSize = 5; 
      try {
          const book = await adapter.getOrderBook(signal.tokenId);
          if (book.min_order_size) minOrderSize = Number(book.min_order_size);
      } catch (e) {}

      const sizing = computeProportionalSizing({
        yourUsdBalance: usableBalanceForTrade,
        yourShareBalance: currentShareBalance,
        traderUsdBalance: traderBalance,
        traderTradeUsd: signal.sizeUsd,
        multiplier: env.tradeMultiplier,
        currentPrice: signal.price,
        maxTradeAmount: env.maxTradeAmount,
        minOrderSize: minOrderSize,
        side: signal.side
      });

      if (sizing.targetShares <= 0) {
          return failResult(sizing.reason || "skipped_by_sizing_engine");
      }

      let priceLimit: number | undefined = undefined;
      if (signal.side === 'BUY') {
          priceLimit = Math.min(0.99, signal.price * 1.05);
      } else {
          priceLimit = Math.max(0.001, signal.price * 0.90);
      }

      logger.info(`[Sizing] Whale: $${traderBalance.toFixed(0)} | Signal: $${signal.sizeUsd.toFixed(0)} (${signal.side}) | Target: $${sizing.targetUsdSize.toFixed(2)} (${sizing.targetShares} shares) | Reason: ${sizing.reason}`);

      const result = await adapter.createOrder({
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        outcome: signal.outcome,
        side: signal.side,
        sizeUsd: sizing.targetUsdSize,
        sizeShares: signal.side === 'SELL' ? sizing.targetShares : undefined,
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
          reason: sizing.reason
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