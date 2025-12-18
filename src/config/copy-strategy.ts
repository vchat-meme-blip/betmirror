
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
  
  // A. The Hard Floor ($1.00)
  // Polymarket APIs typically reject orders < $1 (Dust) for Market/FOK orders.
  // If the proportional math says "$0.05", we boost it to "$1.00" so the user actually participates.
  const SYSTEM_MIN_ORDER = 1.00;
  
  if (targetUsdSize < SYSTEM_MIN_ORDER) {
      if (yourUsdBalance >= SYSTEM_MIN_ORDER) {
          targetUsdSize = SYSTEM_MIN_ORDER;
          reason = "floor_boost_min_1";
      } else {
          // User has less than $1.00. 
          // They cannot trade on CLOB.
          targetUsdSize = 0; 
          reason = "insufficient_for_min_order";
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
  
  // Double check post-floor: if it dropped below $1 but user has funds, bump it back up
  if (targetUsdSize < SYSTEM_MIN_ORDER && targetUsdSize > 0) {
       if (yourUsdBalance >= SYSTEM_MIN_ORDER) targetUsdSize = SYSTEM_MIN_ORDER;
       else targetUsdSize = 0;
  }

  return { targetUsdSize, ratio, reason };
}