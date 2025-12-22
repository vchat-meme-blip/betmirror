
export type CopyInputs = {
  yourUsdBalance: number;
  traderUsdBalance: number;
  traderTradeUsd: number;
  multiplier: number; // e.g., 1.0, 2.0
  currentPrice: number; // The price of the outcome (0.01 - 0.99)
  maxTradeAmount?: number; // User defined safety cap (e.g. $100)
  minOrderSize?: number; // Market's minimum share requirement (default 5)
};

export type SizingResult = {
  targetUsdSize: number; // final USD size to place
  targetShares: number; // Pre-calculated share count
  ratio: number; // your balance vs trader after trade
  reason?: string; // Metadata about why this size was chosen
};

export function computeProportionalSizing(input: CopyInputs): SizingResult {
  const { 
    yourUsdBalance, 
    traderUsdBalance, 
    traderTradeUsd, 
    multiplier, 
    currentPrice, 
    maxTradeAmount,
    minOrderSize = 5 
  } = input;
  
  // 0. Safety: Valid Price
  const price = Math.max(0.01, Math.min(0.99, currentPrice));

  // 1. Calculate raw ratio
  const denom = Math.max(1, traderUsdBalance + Math.max(0, traderTradeUsd));
  const ratio = Math.max(0, yourUsdBalance / denom);
  
  // 2. Calculate raw target size based on proportion
  const base = Math.max(0, traderTradeUsd * ratio);
  let targetUsdSize = Math.max(0, base * Math.max(0, multiplier));
  let reason = "proportional";

  // 3. THE "SMART MATCH" LOGIC
  
  // Minimum USD needed for this order (Exchange floor is $1.00)
  const MIN_VALUE_USDC = 1.00;
  
  if (targetUsdSize < MIN_VALUE_USDC) {
      if (yourUsdBalance >= MIN_VALUE_USDC) {
          // Instead of just setting size to 1.00, we calculate shares required to cross 1.00
          const sharesNeeded = Math.ceil(MIN_VALUE_USDC / price);
          targetUsdSize = sharesNeeded * price;
          reason = "floor_boost_min_value";
      } else {
          return { 
            targetUsdSize: 0, 
            targetShares: 0, 
            ratio, 
            reason: "insufficient_for_min_value" 
          };
      }
  }

  // B. The Safety Ceiling (Max Cap)
  if (maxTradeAmount && targetUsdSize > maxTradeAmount) {
      targetUsdSize = maxTradeAmount;
      reason = "capped_at_max";
  }

  // C. The Wallet Cap
  if (targetUsdSize > yourUsdBalance) {
      targetUsdSize = yourUsdBalance;
      reason = "capped_at_balance";
  }

  // 4. Calculate shares - use CEIL if we are near the floor
  let targetShares = Math.floor(targetUsdSize / price);
  if (targetShares * price < MIN_VALUE_USDC) {
      targetShares = Math.ceil(MIN_VALUE_USDC / price);
      targetUsdSize = targetShares * price;
  }
  
  // 5. Final validation: If we still can't get minimum shares, reject
  if (targetShares < minOrderSize) {
      const boostShares = minOrderSize;
      const boostUsd = boostShares * price;
      if (boostUsd <= yourUsdBalance && (!maxTradeAmount || boostUsd <= maxTradeAmount)) {
          targetShares = boostShares;
          targetUsdSize = boostUsd;
          reason = "boosted_for_min_shares";
      } else {
          return { 
            targetUsdSize: 0, 
            targetShares: 0, 
            ratio, 
            reason: "cannot_meet_min_shares" 
          };
      }
  }

  return { 
    targetUsdSize: Math.round(targetUsdSize * 100) / 100, 
    targetShares,
    ratio, 
    reason 
  };
}
