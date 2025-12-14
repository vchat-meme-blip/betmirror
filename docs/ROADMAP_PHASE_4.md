
# 🗺️ Phase 4 Roadmap: The Path to Trustless Automation

**Current Status:** Phase 3 (Gnosis Safe / Gasless Trading) is Live.
**Next Milestone:** Phase 4 (Decentralized Revenue & Real-Time Data).

---

## 1. On-Chain Fee Enforcement (Safe Modules)

### The Problem
Currently, the Bot Server (Signer EOA) holds full control permissions on the User's Safe. This is necessary to allow the server to execute the `USDC.transfer` function to pay the 1% fee to the Lister/Platform.
*   **Risk:** While the server code *claims* it won't drain funds, the *key permission* technically allows it. This relies on "Soft Trust".

### The Solution: Gnosis Safe Guards/Modules
We will deploy a custom **Zodiac Module** or **Safe Guard**.

**How it works:**
1.  **Hardcoded Rule:** The module logic is deployed on-chain (Polygon).
2.  **Rule:** "Allow `createOrder` (Trade) on Polymarket CTF Exchange."
3.  **Hook:** "On `OrderFilled` (Profit Realization), automatically divert 1% of output USDC to `ListerAddress` and `PlatformAddress`."
4.  **Result:** The Server Key can be downgraded to **Trade-Only** scope. It loses the ability to execute arbitrary transfers, making the system trustless. The fee happens automatically via smart contract logic.

---

## 2. WebSocket Integration (Real-Time Signals)

### The Problem
Currently, the `TradeMonitorService` polls the HTTP API every 2 seconds (`fetchIntervalSeconds`).
*   **Latency:** 2000ms delay means we might miss the exact entry price of a high-frequency whale.
*   **Rate Limits:** Polling thousands of wallets hits API limits.

### The Solution: CLOB WebSockets
We will migrate to the Polymarket CLOB WebSocket (`wss://ws-subscriptions-clob.polymarket.com`).

**Architecture Update:**
1.  **Subscription:** Server opens *one* socket connection.
2.  **Filter:** Subscribes to `trade` events for the watched wallet list.
3.  **Push:** When a whale trades, the event is pushed instantly (~50ms).
4.  **Reaction:** Bot triggers execution immediately.

**Benefit:** Front-running protection and exact price matching.

---

## 3. Automated Hedging (Cross-Chain)

**Concept:** "Trade Trump on Polymarket, Short Trump Coin on Solana."

1.  **Bridge-Aware:** Utilize the Li.Fi integration to detect cross-chain balances.
2.  **Atomic Hedge:** When placing a bet on Polygon, simultaneously trigger a perp swap on dYdX or Jupiter (Solana) to hedge exposure.

---

## 4. Decentralized Registry

**Goal:** Move the `Registry` database to a smart contract on Polygon.
*   Listers call `Registry.register(wallet)` on-chain.
*   Copiers read directly from the contract.
*   Fees are routed based on the on-chain record, removing the Node.js API dependency entirely.
