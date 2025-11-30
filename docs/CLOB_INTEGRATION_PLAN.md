# 🧠 Polymarket CLOB & Builder Architecture Analysis

## 1. Architecture Comparison: Us vs. Them

We currently use **ZeroDev (Kernel v3.1)**. Polymarket uses **Gnosis Safe**. Both are "Smart Accounts" (ERC-4337 compliant), but they serve different optimization goals.

| Feature | Polymarket Native (Relayer) | Bet Mirror Pro (ZeroDev) | Verdict |
| :--- | :--- | :--- | :--- |
| **Smart Contract** | Gnosis Safe Proxy | Kernel v3.1 (ZeroDev) | **Aligned.** Kernel is highly optimized for high-frequency UserOps, making it better for a trading bot than a standard Safe. |
| **Gas Handling** | Polymarket Relayer | ZeroDev Paymaster | **Aligned.** Both achieve "Gasless" USDC trading. We use ZeroDev's paymaster infrastructure which is more flexible for custom session keys. |
| **Signing** | EOA Signatures | Session Key Signatures | **Advantage: Us.** Polymarket's default flow requires the user to sign often. Our Session Key approach allows 24/7 server-side execution without user intervention. |
| **Order Matching** | Central Limit Order Book | Central Limit Order Book | **Identical.** We both post to the same CLOB. |

## 2. The "Builder" Opportunity

Polymarket has a **Builder Program** that allows front-ends (like Bet Mirror) to earn rewards and attribution.

**Current State:**
- We connect to `https://clob.polymarket.com`.
- We sign orders using the `ClobClient`.

**Missing Piece (The Upgrade):**
- We are not yet sending **Attribution Headers**.
- To be a "Official Builder," we need to wrap our `ClobClient` with the `@polymarket/builder-signing-sdk`.

## 3. Implementation Strategy (Future Roadmap)

To fully align with the "World Class" standard described in their docs, we should update our `infrastructure/clob-client.factory.ts` to include Builder Attribution.

**The Workflow:**
1.  **Register:** We (PolyCafe) register as a Builder with Polymarket to get an API Key.
2.  **Remote Signing:** We configure our Bot Server to act as the "Signing Server" described in their docs.
3.  **Header Injection:** Every trade executed by a user's bot gets stamped with `POLY_BUILDER_API_KEY`.
4.  **Result:** We appear on the Polymarket Leaderboard, and we potentially get grants/rebates which we can pass back to users or use to fund the Paymaster.

## 4. Immediate Action: User Education
We need to explain to users that **we are a direct interface to the CLOB**. We are not a "Derivative" layer. When they trade on Bet Mirror, they are providing liquidity directly to the main Polymarket ecosystem.
