import { computeProportionalSizing } from '../config/copy-strategy.js';
import { httpGet } from '../utils/http.js';
export class TradeExecutorService {
    deps;
    balanceCache = new Map();
    CACHE_TTL = 5 * 60 * 1000; // 5 Minutes Cache for Whales
    // NEW: Local deduction tracker to prevent race conditions
    pendingSpend = 0;
    lastBalanceFetch = 0;
    constructor(deps) {
        this.deps = deps;
    }
    // Updated: Execute Exit now sells SHARES, not USD amount, ensuring 100% closure regardless of price
    async executeManualExit(position, currentPrice) {
        const { logger, adapter } = this.deps;
        try {
            logger.info(`📉 Executing Manual Exit: Selling ${position.shares} shares of ${position.tokenId}`);
            const result = await adapter.createOrder({
                marketId: position.marketId,
                tokenId: position.tokenId,
                outcome: position.outcome,
                side: 'SELL',
                sizeUsd: 0, // Ignored when sizeShares is present
                sizeShares: position.shares, // Sell exact number of shares held
                priceLimit: 0 // Market sell (hit the bid)
            });
            return result.success;
        }
        catch (e) {
            logger.error(`Failed to execute manual exit`, e);
            return false;
        }
    }
    async copyTrade(signal) {
        const { logger, env, adapter, proxyWallet } = this.deps;
        // Default Failure Result
        const failResult = (reason) => ({
            status: 'SKIPPED',
            executedAmount: 0,
            executedShares: 0,
            reason
        });
        try {
            let usableBalanceForTrade = 0;
            // 1. Determine Source Capital (Cash vs Position)
            if (signal.side === 'BUY') {
                // BUY: Use Wallet Cash
                let chainBalance = 0;
                // Cache chain balance for 10s to save RPC calls
                if (Date.now() - this.lastBalanceFetch > 10000) {
                    chainBalance = await adapter.fetchBalance(proxyWallet);
                    this.lastBalanceFetch = Date.now();
                    this.pendingSpend = 0; // Reset pending on fresh chain sync
                }
                else {
                    chainBalance = await adapter.fetchBalance(proxyWallet);
                }
                usableBalanceForTrade = Math.max(0, chainBalance - this.pendingSpend);
            }
            else {
                // SELL: Use Existing Position Value
                // We must fetch our current holdings to know how much we can sell
                // Note: This fetches all positions, optimized adapter should cache or allow filtered lookup
                const positions = await adapter.getPositions(proxyWallet);
                const myPosition = positions.find(p => p.tokenId === signal.tokenId);
                if (!myPosition || myPosition.balance <= 0) {
                    return failResult("no_position_to_sell");
                }
                // We use the USD value of our position as the 'balance' to proportion against
                usableBalanceForTrade = myPosition.valueUsd;
            }
            // 2. Get Whale Balance (Total Portfolio Value)
            // For proper ratio, we need their total equity, not just cash
            const traderBalance = await this.getTraderBalance(signal.trader);
            // 3. Compute Size
            const sizing = computeProportionalSizing({
                yourUsdBalance: usableBalanceForTrade,
                traderUsdBalance: traderBalance,
                traderTradeUsd: signal.sizeUsd,
                multiplier: env.tradeMultiplier,
                currentPrice: signal.price,
                maxTradeAmount: env.maxTradeAmount
            });
            const profileUrl = `https://polymarket.com/profile/${signal.trader}`;
            logger.info(`[Sizing] Whale: $${traderBalance.toFixed(0)} | Signal: $${signal.sizeUsd.toFixed(0)} (${signal.side}) | You: $${usableBalanceForTrade.toFixed(2)} | Target: $${sizing.targetUsdSize.toFixed(2)}`);
            logger.info(`🔗 Trader: ${profileUrl}`);
            if (sizing.targetUsdSize < 1.00) {
                if (usableBalanceForTrade < 1.00)
                    return failResult("skipped_insufficient_balance_min_1");
                return failResult("skipped_size_too_small");
            }
            // 4. Calculate Price Limit (SLIPPAGE PROTECTION)
            let priceLimit = 0;
            const SLIPPAGE_PCT = 0.05; // 5% tolerance
            if (signal.side === 'BUY') {
                // Buying: Limit is Higher than signal
                priceLimit = signal.price * (1 + SLIPPAGE_PCT);
                if (priceLimit > 0.99)
                    priceLimit = 0.99;
                if (priceLimit < 0.01)
                    priceLimit = 0.01;
            }
            else {
                // Selling: Limit is Lower than signal
                priceLimit = signal.price * (1 - SLIPPAGE_PCT);
                if (priceLimit < 0.01)
                    priceLimit = 0.01;
            }
            // Round to 2 decimals
            priceLimit = Math.floor(priceLimit * 100) / 100;
            if (priceLimit <= 0)
                priceLimit = 0.01;
            logger.info(`🛡️ Price Guard: Signal @ ${signal.price.toFixed(3)} -> Limit @ ${priceLimit.toFixed(2)}`);
            // 5. Execute via Adapter
            // Note: If selling, we pass sizeUsd. The adapter will calculate shares = sizeUsd / priceLimit (or market price)
            const result = await adapter.createOrder({
                marketId: signal.marketId,
                tokenId: signal.tokenId,
                outcome: signal.outcome,
                side: signal.side,
                sizeUsd: sizing.targetUsdSize,
                priceLimit: priceLimit
            });
            // 6. Check Result
            if (!result.success) {
                return {
                    status: 'FAILED',
                    executedAmount: 0,
                    executedShares: 0,
                    reason: result.error || 'Unknown error'
                };
            }
            // 7. Success - Update Pending Spend (Only for Buys)
            if (signal.side === 'BUY') {
                this.pendingSpend += sizing.targetUsdSize;
            }
            const shares = result.sharesFilled;
            const price = result.priceFilled;
            const actualUsd = shares * price;
            return {
                status: 'FILLED',
                txHash: result.orderId || result.txHash,
                executedAmount: actualUsd,
                executedShares: shares,
                reason: 'executed'
            };
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to copy trade: ${errorMessage}`, err);
            return {
                status: 'FAILED',
                executedAmount: 0,
                executedShares: 0,
                reason: errorMessage
            };
        }
    }
    async getTraderBalance(trader) {
        const cached = this.balanceCache.get(trader);
        if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
            return cached.value;
        }
        try {
            const positions = await httpGet(`https://data-api.polymarket.com/positions?user=${trader}`);
            const totalValue = positions.reduce((sum, pos) => sum + (pos.currentValue || pos.initialValue || 0), 0);
            const val = Math.max(1000, totalValue);
            this.balanceCache.set(trader, { value: val, timestamp: Date.now() });
            return val;
        }
        catch {
            return 10000; // Fallback whale size
        }
    }
}
