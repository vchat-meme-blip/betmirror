import { computeProportionalSizing } from '../config/copy-strategy.js';
import { httpGet } from '../utils/http.js';
import { TOKENS } from '../config/env.js';
import { LiquidityHealth } from '../adapters/interfaces.js';
import axios from 'axios';
export class TradeExecutorService {
    deps;
    balanceCache = new Map();
    CACHE_TTL = 5 * 60 * 1000;
    pendingSpend = 0;
    // Market Making state
    activeQuotes = new Map();
    inventory = new Map(); // tokenId -> share balance
    mmConfig = {
        quoteSize: 50, // $50 per side default
        spreadOffset: 0.01, // 1 cent from midpoint
        maxPositionUsd: 500, // Max $500 inventory per token
        maxOpenOrdersPerToken: 2, // 1 bid + 1 ask
        rebalanceThreshold: 0.3 // 30% skew triggers rebalance
    };
    constructor(deps, mmConfig) {
        this.deps = deps;
        if (mmConfig)
            this.mmConfig = { ...this.mmConfig, ...mmConfig };
    }
    /**
     * Get the exchange adapter instance
     */
    getAdapter() {
        return this.deps.adapter;
    }
    // ============================================================
    // MARKET MAKING METHODS (NEW)
    // ============================================================
    /**
     * Execute two-sided quotes for market making opportunities
     * Places GTC limit orders on both sides to capture spread
     * Per docs: GTC orders rest on book and earn liquidity rewards
     */
    async executeMarketMakingQuotes(opportunity) {
        const { logger, adapter, proxyWallet } = this.deps;
        const { tokenId, conditionId, midpoint, spread, question, rewardsMaxSpread, rewardsMinSize, skew = 0 } = opportunity;
        const failResult = (reason) => ({
            tokenId,
            status: 'FAILED',
            reason
        });
        try {
            // 1. Check if market is still active
            const market = await this.validateMarketForMM(conditionId);
            if (!market.valid) {
                return failResult(market.reason || 'market_invalid');
            }
            // 2. Cancel existing quotes for this token before placing new ones
            await this.cancelExistingQuotes(tokenId);
            // 3. Check inventory limits
            const currentInventory = await this.getTokenInventory(tokenId);
            const inventoryValueUsd = currentInventory * midpoint;
            if (inventoryValueUsd >= this.mmConfig.maxPositionUsd) {
                logger.warn(`[MM] Inventory limit reached for ${tokenId}: $${inventoryValueUsd.toFixed(2)}`);
                // Only post asks to reduce inventory
                return await this.postSingleSideQuote(opportunity, 'SELL', currentInventory);
            }
            // 4. Calculate quote prices with INVENTORY SKEW
            /**
             * SKEW LOGIC:
             * If skew > 0 (heavy YES), we lower BOTH prices.
             * Lower Bid = Harder to buy more YES.
             * Lower Ask = Easier to sell current YES shares (cheapest on book).
             */
            const skewAdjustment = skew * 0.02; // Max 2 cent aggressive lean
            let bidOffset = this.mmConfig.spreadOffset;
            let askOffset = this.mmConfig.spreadOffset;
            // If reward-eligible, ensure we're within max_spread
            if (rewardsMaxSpread && this.mmConfig.spreadOffset > rewardsMaxSpread / 2) {
                bidOffset = rewardsMaxSpread / 2 - 0.001;
                askOffset = rewardsMaxSpread / 2 - 0.001;
            }
            const bidPrice = Math.max(0.01, midpoint - bidOffset - skewAdjustment);
            const askPrice = Math.min(0.99, midpoint + askOffset - skewAdjustment);
            // 5. Determine quote sizes
            let bidSize = this.mmConfig.quoteSize / bidPrice;
            let askSize = Math.min(this.mmConfig.quoteSize / askPrice, currentInventory);
            // Check rewards min_size requirement
            const minSize = rewardsMinSize || market.minOrderSize || 5;
            if (bidSize < minSize)
                bidSize = minSize;
            if (askSize < minSize && currentInventory >= minSize)
                askSize = minSize;
            // 6. Check balance for bid
            const balance = await adapter.fetchBalance(proxyWallet);
            const availableForBid = Math.max(0, balance - this.pendingSpend);
            if (availableForBid < bidSize * bidPrice) {
                bidSize = availableForBid / bidPrice;
            }
            // 7. Place orders using GTC (required for rewards)
            const result = {
                tokenId,
                status: 'POSTED',
                bidPrice,
                askPrice
            };
            // Place BID (buy order)
            if (bidSize >= minSize) {
                const bidResult = await this.placeGTCOrder({
                    tokenId,
                    conditionId,
                    side: 'BUY',
                    price: bidPrice,
                    size: bidSize,
                    negRisk: market.negRisk,
                    tickSize: market.tickSize
                });
                if (bidResult.success) {
                    result.bidOrderId = bidResult.orderId;
                    this.pendingSpend += bidSize * bidPrice;
                }
                else {
                    result.status = 'PARTIAL';
                }
            }
            // Place ASK (sell order)
            if (askSize >= minSize && currentInventory >= minSize) {
                const askResult = await this.placeGTCOrder({
                    tokenId,
                    conditionId,
                    side: 'SELL',
                    price: askPrice,
                    size: askSize,
                    negRisk: market.negRisk,
                    tickSize: market.tickSize
                });
                if (askResult.success) {
                    result.askOrderId = askResult.orderId;
                }
                else {
                    if (!result.bidOrderId)
                        result.status = 'FAILED';
                    else
                        result.status = 'PARTIAL';
                }
            }
            // Track active quotes
            this.activeQuotes.set(tokenId, {
                bidOrderId: result.bidOrderId,
                askOrderId: result.askOrderId
            });
            return result;
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`[MM] Quote execution failed: ${err.message}`, err);
            return failResult(err.message);
        }
    }
    /**
     * Place a GTC limit order (required for liquidity rewards)
     * Refactored to use adapter.createOrder for Safe/Relayer/Attribution support
     */
    async placeGTCOrder(params) {
        const { adapter } = this.deps;
        try {
            const tickSize = parseFloat(params.tickSize) || 0.01;
            const roundedPrice = Math.round(params.price / tickSize) * tickSize;
            const response = await adapter.createOrder({
                marketId: params.conditionId,
                tokenId: params.tokenId,
                outcome: params.side === 'BUY' ? 'YES' : 'NO', // Outcome used for metadata
                side: params.side,
                sizeUsd: roundedPrice * params.size,
                sizeShares: params.size,
                priceLimit: roundedPrice,
                orderType: 'GTC' // CRITICAL: This flag forces the maker lane in adapter
            });
            if (response.success) {
                return { success: true, orderId: response.orderId };
            }
            else {
                return { success: false, error: response.error || 'Order rejected' };
            }
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            return { success: false, error: err.message };
        }
    }
    /**
     * Cancel existing quotes for a token before placing new ones
     * Per docs: cancelMarketOrders with asset_id
     */
    async cancelExistingQuotes(tokenId) {
        const { adapter, logger } = this.deps;
        const client = adapter.getRawClient?.();
        const existing = this.activeQuotes.get(tokenId);
        if (!existing)
            return;
        try {
            const orderIds = [existing.bidOrderId, existing.askOrderId].filter(Boolean);
            if (orderIds.length > 0 && client) {
                // Per docs: cancelOrders for multiple orders
                await client.cancelOrders(orderIds);
                logger.debug(`[MM] Cancelled ${orderIds.length} existing quotes for ${tokenId}`);
            }
            this.activeQuotes.delete(tokenId);
        }
        catch (error) {
            // Non-fatal - orders may have already been filled/cancelled
            logger.debug(`[MM] Cancel existing quotes warning: ${error}`);
        }
    }
    /**
     * Post single-side quote (for inventory management)
     */
    async postSingleSideQuote(opportunity, side, inventory) {
        const { logger } = this.deps;
        const { tokenId, conditionId, midpoint, rewardsMaxSpread, rewardsMinSize } = opportunity;
        const market = await this.validateMarketForMM(conditionId);
        if (!market.valid) {
            return { tokenId, status: 'FAILED', reason: market.reason };
        }
        const offset = rewardsMaxSpread ? Math.min(this.mmConfig.spreadOffset, rewardsMaxSpread / 2) : this.mmConfig.spreadOffset;
        const price = side === 'BUY'
            ? Math.max(0.01, midpoint - offset)
            : Math.min(0.99, midpoint + offset);
        const size = side === 'SELL'
            ? Math.min(this.mmConfig.quoteSize / price, inventory)
            : this.mmConfig.quoteSize / price;
        const minSize = rewardsMinSize || market.minOrderSize || 5;
        if (size < minSize) {
            return { tokenId, status: 'SKIPPED', reason: `size_below_minimum: ${size} < ${minSize}` };
        }
        const result = await this.placeGTCOrder({
            tokenId,
            conditionId,
            side,
            price,
            size,
            negRisk: market.negRisk,
            tickSize: market.tickSize
        });
        if (result.success) {
            logger.success(`[MM] ${side} posted: ${size.toFixed(2)} @ ${(price * 100).toFixed(1)}¢`);
            return {
                tokenId,
                status: 'POSTED',
                [side === 'BUY' ? 'bidOrderId' : 'askOrderId']: result.orderId,
                [side === 'BUY' ? 'bidPrice' : 'askPrice']: price
            };
        }
        return { tokenId, status: 'FAILED', reason: result.error };
    }
    /**
     * Validate market is suitable for market making
     */
    async validateMarketForMM(conditionId) {
        const { adapter } = this.deps;
        const client = adapter.getRawClient?.();
        try {
            const market = await client.getMarket(conditionId);
            if (!market)
                return { valid: false, reason: 'market_not_found', negRisk: false, tickSize: '0.01', minOrderSize: 5 };
            if (market.closed)
                return { valid: false, reason: 'market_closed', negRisk: false, tickSize: '0.01', minOrderSize: 5 };
            if (!market.active)
                return { valid: false, reason: 'market_inactive', negRisk: false, tickSize: '0.01', minOrderSize: 5 };
            if (!market.accepting_orders)
                return { valid: false, reason: 'not_accepting_orders', negRisk: false, tickSize: '0.01', minOrderSize: 5 };
            return {
                valid: true,
                negRisk: market.neg_risk || false,
                tickSize: market.minimum_tick_size?.toString() || '0.01',
                minOrderSize: market.minimum_order_size || 5
            };
        }
        catch (error) {
            return { valid: false, reason: 'validation_error', negRisk: false, tickSize: '0.01', minOrderSize: 5 };
        }
    }
    /**
     * Get current token inventory (share balance)
     */
    async getTokenInventory(tokenId) {
        const { adapter, proxyWallet } = this.deps;
        try {
            const positions = await adapter.getPositions(proxyWallet);
            const position = positions.find(p => p.tokenId === tokenId);
            return position?.balance || 0;
        }
        catch {
            return this.inventory.get(tokenId) || 0;
        }
    }
    /**
     * Cancel all market making quotes (kill switch)
     */
    async cancelAllMMQuotes() {
        const { adapter, logger } = this.deps;
        const client = adapter.getRawClient?.();
        if (!client)
            return;
        try {
            // Per docs: cancelAll() cancels all open orders
            await client.cancelAll();
            this.activeQuotes.clear();
            this.pendingSpend = 0;
            logger.warn('[MM] 🛑 All quotes cancelled');
        }
        catch (error) {
            logger.error(`[MM] Failed to cancel all quotes: ${error}`);
        }
    }
    // ============================================================
    // ORIGINAL COPY TRADING METHODS (PRESERVED)
    // ============================================================
    async checkMarketResolution(position) {
        const { logger, adapter } = this.deps;
        const conditionId = position.conditionId || position.marketId;
        try {
            let market = null;
            let source;
            const client = adapter.getRawClient?.();
            if (client) {
                try {
                    market = await client.getMarket(conditionId);
                    if (market)
                        source = 'CLOB';
                }
                catch (e) {
                    logger.debug(`CLOB 404 for ${conditionId}, checking Gamma fallback...`);
                }
            }
            if (!market) {
                try {
                    const gammaUrl = `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`;
                    const res = await axios.get(gammaUrl);
                    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
                        market = res.data[0];
                        source = 'GAMMA';
                    }
                }
                catch (e) {
                    logger.error(`Gamma fallback failed for ${conditionId}`);
                }
            }
            if (!market) {
                logger.warn(`❌ Market resolution check failed: ID ${conditionId} not found.`);
                return { resolved: false, conditionId };
            }
            logger.info(`📊 Resolution Metadata [${source}] for ${conditionId}: closed=${market.closed}, active=${market.active}, status=${market.status}`);
            const isResolved = market.closed === true || market.status === 'resolved' || market.archived === true;
            if (!isResolved) {
                logger.debug(`⏳ Market ${conditionId} is not resolved yet.`);
                return { resolved: false, market, conditionId, source };
            }
            let winningOutcome;
            let userWon = false;
            if (market.tokens && Array.isArray(market.tokens)) {
                const winningToken = market.tokens.find((t) => t.winner === true);
                if (winningToken)
                    winningOutcome = winningToken.outcome;
            }
            else if (market.winning_outcome) {
                winningOutcome = market.winning_outcome;
            }
            if (winningOutcome) {
                userWon = position.outcome.toUpperCase() === winningOutcome.toUpperCase();
                logger.info(`🏆 Resolution result: Winning=${winningOutcome}, Mine=${position.outcome}, Result=${userWon ? 'WON' : 'LOST'}`);
            }
            return {
                resolved: true,
                winningOutcome,
                userWon,
                market,
                conditionId,
                source
            };
        }
        catch (error) {
            logger.error(`❌ Error in resolution engine: ${error.message}`);
            return { resolved: false, conditionId };
        }
    }
    async executeManualExit(position, currentPrice) {
        const { logger, adapter } = this.deps;
        let remainingShares = position.shares;
        try {
            if (remainingShares < 5) {
                logger.error(`🚨 Cannot Exit: Your balance (${remainingShares.toFixed(2)}) is below the exchange minimum of 5 shares.`);
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
                    logger.warn(`⚠️ Partial Fill: Only liquidated ${filled}/${position.shares} shares.`);
                }
                logger.success(`Exit summary: Liquidated ${filled.toFixed(2)} shares @ avg best possible price.`);
                return true;
            }
            else {
                if (result.error?.includes("No orderbook") || result.error?.includes("404")) {
                    logger.info(`Market appears resolved. Checking resolution status...`);
                    const resolution = await this.checkMarketResolution(position);
                    if (resolution.resolved) {
                        if (resolution.userWon) {
                            logger.success(`Market resolved in your favor! Winning outcome: ${resolution.winningOutcome}`);
                            const redeemResult = await adapter.redeemPosition(position.marketId, position.tokenId);
                            if (redeemResult.success) {
                                logger.success(`Redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                                return true;
                            }
                            else {
                                logger.error(`Redemption failed: ${redeemResult.error}`);
                                return false;
                            }
                        }
                        else {
                            logger.warn(`Market resolved but you did not win. Winning outcome: ${resolution.winningOutcome || 'Unknown'}`);
                            return false;
                        }
                    }
                    else {
                        logger.warn(`Market status unclear. Attempting redemption as fallback...`);
                        const redeemResult = await adapter.redeemPosition(position.marketId, position.tokenId);
                        if (redeemResult.success) {
                            logger.success(`Redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                            return true;
                        }
                        else {
                            logger.error(`Redemption failed: ${redeemResult.error}`);
                            return false;
                        }
                    }
                }
                logger.error(`Exit attempt failed: ${result.error || "Unknown Error"}`);
                return false;
            }
        }
        catch (e) {
            logger.error(`Failed to execute manual exit: ${e.message}`, e);
            return false;
        }
    }
    async copyTrade(signal) {
        const { logger, env, adapter, proxyWallet } = this.deps;
        const failResult = (reason, status = 'SKIPPED') => ({
            status,
            executedAmount: 0,
            executedShares: 0,
            priceFilled: 0,
            reason
        });
        try {
            try {
                const market = await adapter.getRawClient().getMarket(signal.marketId);
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
            }
            catch (e) {
                if (e.message?.includes("404") || e.message?.includes("No orderbook") || String(e).includes("404")) {
                    logger.warn(`[Market Resolved] ${signal.marketId} - Attempting to redeem existing position`);
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
                            }
                            else {
                                logger.error(`[Auto-Redeem] Failed: ${redeemResult.error}`);
                                return failResult("redemption_failed", 'FAILED');
                            }
                        }
                        else {
                            logger.warn(`[Auto-Redeem] No existing position found for ${signal.marketId}`);
                            return failResult("orderbook_not_found");
                        }
                    }
                    catch (redeemError) {
                        logger.error(`[Auto-Redeem] Error during redemption: ${redeemError.message}`);
                        return failResult("redemption_error", 'FAILED');
                    }
                }
                throw e;
            }
            if (this.deps.adapter.getLiquidityMetrics) {
                try {
                    const metrics = await this.deps.adapter.getLiquidityMetrics(signal.tokenId, signal.side);
                    const minRequired = this.deps.env.minLiquidityFilter || 'LOW';
                    const ranks = {
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
                }
                catch (e) {
                    if (e.message?.includes("404") || e.message?.includes("No orderbook") || String(e).includes("404")) {
                        logger.warn(`[Market Resolved] ${signal.marketId} - Attempting to redeem existing position (liquidity check)`);
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
                                }
                                else {
                                    logger.error(`[Auto-Redeem] Failed: ${redeemResult.error}`);
                                    return failResult("redemption_failed", 'FAILED');
                                }
                            }
                            else {
                                logger.warn(`[Auto-Redeem] No existing position found for ${signal.marketId}`);
                                return failResult("orderbook_not_found");
                            }
                        }
                        catch (redeemError) {
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
            }
            else {
                if (!myPosition || myPosition.balance <= 0)
                    return failResult("no_position_to_sell");
                usableBalanceForTrade = myPosition.valueUsd;
            }
            const traderBalance = await this.getTraderBalance(signal.trader);
            let minOrderSize = 5;
            try {
                const book = await adapter.getOrderBook(signal.tokenId);
                if (book.min_order_size)
                    minOrderSize = Number(book.min_order_size);
            }
            catch (e) { }
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
            if (signal.side === 'BUY' && usableBalanceForTrade < sizing.targetUsdSize) {
                const chainBalance = await adapter.fetchBalance(proxyWallet);
                return failResult(`insufficient_funds (balance: $${chainBalance.toFixed(2)}, ` +
                    `pending: $${this.pendingSpend.toFixed(2)}, ` +
                    `available: $${usableBalanceForTrade.toFixed(2)}, ` +
                    `required: $${sizing.targetUsdSize.toFixed(2)})`, "FAILED");
            }
            let priceLimit = undefined;
            if (signal.side === 'BUY') {
                priceLimit = Math.min(0.99, signal.price * 1.05);
            }
            else {
                priceLimit = Math.max(0.001, signal.price * 0.90);
            }
            logger.info(`[Sizing] Whale: $${traderBalance.toFixed(0)} | Signal: $${signal.sizeUsd.toFixed(0)} (${signal.side}) | Target: $${sizing.targetUsdSize.toFixed(2)} (${sizing.targetShares} shares) | Reason: ${sizing.reason}`);
            // FIX: Access safeManager from adapter via any-casting to bypass IExchangeAdapter interface restrictions and access internal Safe implementation details
            const anyAdapter = adapter;
            if (signal.side === 'BUY' && anyAdapter.safeManager) {
                const safeManager = anyAdapter.safeManager;
                const requiredAmount = BigInt(Math.ceil(sizing.targetUsdSize * 1e6));
                const spender = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
                try {
                    this.deps.logger.info(`[Allowance] Checking USDC allowance for trade: $${sizing.targetUsdSize.toFixed(2)}`);
                    await safeManager.setDynamicAllowance(TOKENS.USDC_BRIDGED, spender, requiredAmount);
                }
                catch (e) {
                    const errorMsg = e instanceof Error ? e.message : String(e);
                    this.deps.logger.error(`[Allowance] Failed to set allowance: ${errorMsg}`);
                    return failResult(`allowance_error: ${errorMsg}`, 'FAILED');
                }
            }
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
            if (signal.side === 'BUY')
                this.pendingSpend += sizing.targetUsdSize;
            return {
                status: 'FILLED',
                txHash: result.orderId || result.txHash,
                executedAmount: result.sharesFilled * result.priceFilled,
                executedShares: result.sharesFilled,
                priceFilled: result.priceFilled,
                reason: sizing.reason
            };
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to copy trade: ${errorMessage}`, err);
            return {
                status: 'FAILED',
                executedAmount: 0,
                executedShares: 0,
                priceFilled: 0,
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
            return 10000;
        }
    }
}
