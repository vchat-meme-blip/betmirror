
# 🏛️ Scalable Trading Architecture Plan

**Objective:** Upgrade the Bet Mirror backend to support multiple prediction markets (Polymarket, Kalshi, PredictBase) while maintaining robust authentication.

## 1. The Core Problem (RESOLVED)
The previous architecture used simple EOAs which required users to manage GAS (MATIC) and limited our ability to perform advanced operations.
*   **Resolution:** We have implemented a **Gnosis Safe + Relayer Model**.
*   **Mechanism:** We use the `Signer` (EOA) to sign standard messages/orders, while using the `Safe Address` as the "Funder". The Polymarket Relayer handles gas abstraction.

## 2. Performance Upgrades (COMPLETED)

To handle high-frequency signals and ensure 24/7 reliability, we have applied the following optimizations:

### A. Memory Leak Prevention (`TradeMonitor`)
*   **Problem:** Storing every processed transaction hash in a `Set` indefinitely causes OOM crashes after weeks of runtime.
*   **Fix:** Implemented an **LRU (Least Recently Used)** pruning strategy using a `Map<Hash, Timestamp>`. Hashes older than the aggregation window (5 mins) are automatically removed.

### B. Latency Reduction (`TradeExecutor`)
*   **Problem:** Fetching a whale's portfolio balance takes 300ms-800ms via HTTP. Doing this *before* every trade slows down execution.
*   **Fix:** Implemented **WhaleBalanceCache**. We cache balance data for 5 minutes. Subsequent signals from the same whale execute instantly without waiting for the Data API.

### C. RPC Rate Limit Protection (`FundManager`)
*   **Problem:** Checking the blockchain balance every few seconds burns through RPC credits and can trigger IP bans.
*   **Fix:** Implemented **Throttling**. The Auto-Cashout logic now only runs once per hour (or upon specific trigger events), reducing RPC load by 99%.

## 3. The Solution: Exchange Adapter Pattern

We have abstracted the specific logic of each exchange into **Adapters**. The `BotEngine` does not care *how* a trade is executed, only that it *is* executed.

### A. The Interface (`IExchangeAdapter`)

Every market integration implements this contract:

```typescript
export interface IExchangeAdapter {
    readonly exchangeName: string;
    
    // Lifecycle
    initialize(): Promise<void>;
    
    // Auth & Setup
    validatePermissions(): Promise<boolean>;
    authenticate(): Promise<void>;
    
    // Market Data
    fetchBalance(address: string): Promise<number>;
    getMarketPrice(marketId: string, tokenId: string): Promise<number>;
    
    // Execution
    createOrder(params: OrderParams): Promise<string>; // Returns Order ID / Tx Hash
    cancelOrder(orderId: string): Promise<boolean>;
    
    // Order Management
    cashout(amount: number, destination: string): Promise<string>;
}
```

### B. Polymarket Implementation (`PolymarketAdapter`)

This adapter encapsulates the Gnosis Safe logic.

*   **Signer:** Uses `ethers.Wallet` (EOA) initialized with the **Encrypted Private Key**.
*   **Funder:** Uses the **Gnosis Safe Address** as the `funderAddress` in the CLOB Client.
*   **Auth:** Performs the `createOrDeriveApiKey` handshake using `SignatureType.POLY_GNOSIS_SAFE`.
*   **Gas:** Uses `SafeManagerService` to route withdrawals via the Relayer.

### C. Future Scaling (Kalshi Example)

When we add Kalshi, we simply create `KalshiAdapter`:

*   **Signer:** Uses `KALSHI_API_KEY` and `KALSHI_API_SECRET`.
*   **Funder:** N/A (Custodial/KYC account).
*   **Auth:** Direct HTTP Basic Auth or Bearer Token.
