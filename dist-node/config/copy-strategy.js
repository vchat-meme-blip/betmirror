export function computeProportionalSizing(input) {
    const { yourUsdBalance, yourShareBalance, traderUsdBalance, traderTradeUsd, multiplier, currentPrice, maxTradeAmount, minOrderSize = 5, side } = input;
    const price = Math.max(0.01, Math.min(0.99, currentPrice));
    const MIN_VALUE_USDC = 1.00;
    // 1. Calculate raw ratio and target
    const denom = Math.max(1, traderUsdBalance + (side === 'BUY' ? Math.max(0, traderTradeUsd) : 0));
    const ratio = Math.max(0, yourUsdBalance / denom);
    const base = Math.max(0, traderTradeUsd * ratio);
    let targetUsdSize = Math.max(0, base * Math.max(0, multiplier));
    let reason = "proportional";
    // 2. Handle BUY Logic
    if (side === 'BUY') {
        if (targetUsdSize < MIN_VALUE_USDC) {
            const sharesNeeded = Math.ceil(MIN_VALUE_USDC / price);
            targetUsdSize = sharesNeeded * price;
            reason = "floor_boost_min_value";
        }
        if (maxTradeAmount && targetUsdSize > maxTradeAmount) {
            targetUsdSize = maxTradeAmount;
            reason = "capped_at_max";
        }
        if (targetUsdSize > yourUsdBalance) {
            targetUsdSize = yourUsdBalance;
            reason = "capped_at_balance";
        }
        let targetShares = Math.floor(targetUsdSize / price);
        if (targetShares < minOrderSize) {
            targetShares = minOrderSize;
            targetUsdSize = targetShares * price;
            reason = "boosted_for_min_shares";
        }
        return { targetUsdSize, targetShares, ratio, reason };
    }
    // 3. Handle SELL Logic (Dust Prevention)
    if (side === 'SELL') {
        let targetShares = Math.floor(targetUsdSize / price);
        // If we have less than the minimum shares in total, we are in a 'Dust Trap'
        if (yourShareBalance < minOrderSize) {
            return {
                targetUsdSize: 0,
                targetShares: 0,
                ratio,
                reason: `dust_trap_detected: held_${yourShareBalance.toFixed(2)}_below_min_${minOrderSize}`
            };
        }
        // If the proportional sell is too small, but we have enough to sell the minimum
        if (targetShares < minOrderSize) {
            targetShares = minOrderSize;
            reason = "sell_boost_to_min_shares";
        }
        // CRITICAL: If this sell would leave us with 'dust' ( < 5 shares), just sell everything
        const remaining = yourShareBalance - targetShares;
        if (remaining > 0 && remaining < minOrderSize) {
            targetShares = yourShareBalance;
            reason = "full_liquidation_to_prevent_dust";
        }
        // Ensure we don't try to sell more than we have
        targetShares = Math.min(targetShares, yourShareBalance);
        targetUsdSize = targetShares * price;
        return {
            targetUsdSize: Math.round(targetUsdSize * 100) / 100,
            targetShares: Math.floor(targetShares),
            ratio,
            reason
        };
    }
    return { targetUsdSize: 0, targetShares: 0, ratio: 0, reason: "invalid_side" };
}
