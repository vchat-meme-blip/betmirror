# Bet Mirror | Production Guide

## 🎭 Choose Your Role

### 🅰️ Role A: The Admin (Platform Host)
**Goal:** Host the "Alpha Marketplace" and collect 1% fees from all profitable trades executed by users.
**Requirement:** No Private Keys. Just a Public Address to receive money.

1.  **Configure Environment:**
    Set `ADMIN_REVENUE_WALLET=0xYourColdStorageAddress` in `.env`.
    *This is where fees will be sent.*

2.  **Run the Registry Server:**
    ```bash
    npm run start:server
    ```
    *The Global Registry is now online at `http://localhost:3000`. Users can connect their bots to this URL.*

---

### 🅱️ Role B: The Trader (User)
**Goal:** Run the bot to copy trades and make profit.
**Requirement:** A Proxy Wallet (Private Key) to execute trades on Polymerket.

1.  **Generate a Proxy Wallet:**
    Don't use your main wallet. Create a dedicated "Hot Wallet" for the bot.
    ```bash
    npm run generate:wallet
    ```
    *Save the Private Key and Address.*

2.  **Configure Environment:**
    Add the generated keys to your `.env` (or via the Web UI Vault).
    ```env
    PUBLIC_KEY=0xGeneratedProxyAddress
    PRIVATE_KEY=GeneratedPrivateKey
    ```

3.  **Run the Bot:**
    *   **Option 1 (Web UI):** `npm run dev` -> Go to `http://localhost:5173`.
    *   **Option 2 (Headless):** `npm start`.

---

## 💎 How the Fee System Works

1.  **Lister:** User A adds `0xWhale...` to the Registry.
2.  **Copier:** User B's bot sees `0xWhale...` and copies a trade.
3.  **Profit:** User B's bot makes $100 profit on that trade.
4.  **Payout (Automatic):**
    *   User B's bot queries the Registry: "Who listed 0xWhale?" -> Returns "User A".
    *   User B's bot sends **$1.00 USDC** to User A.
    *   User B's bot sends **$1.00 USDC** to the **Admin Revenue Wallet**.
    *   User B keeps **$98.00 USDC**.

*Note: All transfers are executed on the Polygon blockchain.*
