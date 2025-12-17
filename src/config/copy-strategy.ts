
export type CopyInputs = {
  yourUsdBalance: number;
  traderUsdBalance: number;
  traderTradeUsd: number;
  multiplier: number; // e.g., 1.0, 2.0
  currentPrice: number; // The price of the outcome (0.01 - 0.99)
  maxTradeAmount?: number; // User defined safety cap (e.g. $100)
};

export type SizingResult = {
  targetUsdSize: number; // final USD size to place
  ratio: number; // your balance vs trader after trade
  reason?: string; // Metadata about why this size was chosen
};

export function computeProportionalSizing(input: CopyInputs): SizingResult {
  const { yourUsdBalance, traderUsdBalance, traderTradeUsd, multiplier, currentPrice, maxTradeAmount } = input;
  
  // 0. Safety: Valid Price
  const price = Math.max(0.01, currentPrice); // Prevent div by zero

  // 1. Calculate raw ratio
  // We use a minimum denominator of 1 to avoid division by zero
  const denom = Math.max(1, traderUsdBalance + Math.max(0, traderTradeUsd));
  const ratio = Math.max(0, yourUsdBalance / denom);
  
  // 2. Calculate raw target size based on proportion
  const base = Math.max(0, traderTradeUsd * ratio);
  let targetUsdSize = Math.max(0, base * Math.max(0, multiplier));
  let reason = "proportional";

  // 3. THE "SMART MATCH" LOGIC
  
  // A. Polymarket Constraints (Hard Floor)
  // Constraint 1: Must be at least $1.00 USD
  const MIN_USD_VALUE = 1.00;
  // Constraint 2: Must be at least 5 Shares (Critical for prices > $0.20)
  const MIN_SHARES = 5;
  const costForMinShares = MIN_SHARES * price;

  // The actual hard floor is the greater of $1 or the cost of 5 shares at current price
  const effectiveMinUsd = Math.max(MIN_USD_VALUE, costForMinShares);
  
  if (targetUsdSize < effectiveMinUsd) {
      if (yourUsdBalance >= effectiveMinUsd) {
          // If user has enough funds to cover the minimum valid order, boost it.
          targetUsdSize = effectiveMinUsd;
          reason = `floor_boost_min_${effectiveMinUsd.toFixed(2)}`;
      } else {
          // User has less than the minimum required for this specific trade. 
          // They cannot trade on CLOB without error.
          targetUsdSize = 0; 
          reason = `insufficient_for_min_order_of_${effectiveMinUsd.toFixed(2)}`;
      }
  }

  // B. The Safety Ceiling (Max Cap)
  // If user has $1M and sets max trade to $500, we clamp.
  if (maxTradeAmount && targetUsdSize > maxTradeAmount) {
      targetUsdSize = maxTradeAmount;
      reason = "capped_at_max";
  }

  // C. The Wallet Cap
  if (targetUsdSize > yourUsdBalance) {
      targetUsdSize = yourUsdBalance;
      reason = "capped_at_balance";
  }

  // 4. Final Formatting
  // Polymarket requires strict 2-decimal precision for USD amounts (FOK orders).
  // We floor to avoid "Insufficient Balance" due to 0.00001 diffs.
  targetUsdSize = Math.floor(targetUsdSize * 100) / 100;
  
  // Double check post-floor: if it dropped below minimums but user has funds, bump it back up
  // or kill it if we can't afford it after rounding
  if (targetUsdSize < effectiveMinUsd && targetUsdSize > 0) {
       if (yourUsdBalance >= effectiveMinUsd) targetUsdSize = effectiveMinUsd;
       else targetUsdSize = 0;
  }

  return { targetUsdSize, ratio, reason };
}
