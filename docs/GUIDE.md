
# 📘 Bet Mirror Pro | User & Technical Guide

Welcome to the institutional-grade prediction market terminal. This guide covers everything from your first deposit to the technical architecture powering the bot.

---

## 🚀 Getting Started: What Next?

Now that you have connected your wallet and initialized your **Trading Wallet**, here is your roadmap to profit.

### 1. Fund Your Bot
Your Trading Wallet (Gnosis Safe) lives on the **Polygon** network. You primarily need **USDC.e** to trade.
*   **Option A (Direct):** If you already have funds on Polygon, send them to the **Smart Bot** address shown in the Dashboard (top left card).
*   **Option B (Bridge):** Go to the **Bridge** tab. Select your source chain (Base, Solana, Ethereum, Arbitrum) and transfer funds. Our Li.Fi integration handles the swapping and bridging automatically.
*   **Gas:** Bet Mirror uses the **Polymarket Relayer** to pay for gas fees on your behalf. You do **NOT** need to hold POL (Matic) to trade, though having a small amount for emergency manual withdrawals is optional.

### 2. Select Traders (Marketplace)
Go to the **Marketplace** tab.
*   Browse the **Alpha Registry** to find "Whales" or high-win-rate traders.
*   Click **COPY** on a trader to add them to your target list.
*   *Tip: Look for the "OFFICIAL" badge for system-verified wallets.*

### 3. Configure Strategy (Vault)
Go to the **Vault** tab to fine-tune your risk.
*   **Multiplier:** Want to bet bigger than the whale? Set `1.5x` or `2.0x`.
*   **Risk Profile:**
    *   **Conservative:** AI blocks trades on volatile markets.
    *   **Degen:** AI allows almost everything.
*   **Auto-Cashout:** Set a threshold (e.g., $1000). Profits above this are automatically swept back to your main cold wallet.

### 4. Start the Engine
Click the **START ENGINE** button in the header.
*   The bot will spin up on our cloud server.
*   You can now close your browser. The bot runs 24/7.
*   Monitor your **Dashboard** for live logs and PnL updates.

---

## 🧠 Technical Deep Dive: Polymarket CLOB

Bet Mirror is not a derivative platform. We interact directly with the **Polymarket Central Limit Order Book (CLOB)** via their Relayer architecture.

### How it works
1.  **Signal Detection:** We monitor the `Activity` endpoints of target wallets in real-time.
2.  **Order Construction:** When a target buys `YES` on "Bitcoin > 100k", your bot constructs an identical order.
3.  **Attribution:** We inject specific **Builder Headers** (`POLY_BUILDER_API_KEY`) into the API request. This identifies your trade as coming from "Bet Mirror" infrastructure, allowing us to participate in the **Polymarket Builder Program**.
4.  **Execution:** The order is cryptographically signed by your dedicated **EOA Signer** and submitted to the **Polymarket Relayer**.
5.  **Settlement:** The trade is executed by your **Gnosis Safe** proxy on the CTF Exchange contract on Polygon.

### Architecture Comparison

We utilize a Hybrid Safe Model to ensure 100% compatibility with Polymarket's high-frequency trading requirements while maintaining security.

| Feature | Standard EOA Bot | Bet Mirror Pro (Safe) | Why we chose this |
| :--- | :--- | :--- | :--- |
| **Wallet Type** | Standard EOA | **Gnosis Safe Proxy** | Safes are the industry standard for smart accounts. They hold the funds. |
| **Signing** | Direct Key Sign | **EOA Owner Sign** | We generate an encrypted EOA that *owns* the Safe. This EOA signs instructions, but funds sit in the Safe. |
| **Gas** | User Pays (POL) | **Relayer (Gasless)** | We use the Polymarket Relayer to submit transactions. This creates a gasless experience for the user. |
| **Liquidity** | CLOB | **CLOB** | We access the exact same liquidity depth as the main site. No side pools. |

---

## 🛡️ Security & Recovery

### Dedicated Wallet Model
*   **Isolation:** We create a specific wallet configuration just for your bot. This limits risk. Even if the bot key were compromised, your Main Wallet (MetaMask) remains safe.
*   **Encryption:** Your bot's private key (Signer) is encrypted in our database using **AES-256**. It is only decrypted in server memory for the split-second required to sign an order.

### Emergency Recovery
To withdraw funds:
1.  Use the **Withdraw** button on the Dashboard.
2.  This triggers the server to instruct the Relayer to move funds from your Safe back to your Main Wallet.
3.  **Manual Recovery:** Since this is a standard Gnosis Safe, you can always recover funds by interacting with the Safe contracts directly if the platform goes offline, provided you have the Signer key (exportable via admin request).

---

## 💎 The Alpha Registry Economy

*   **List:** Anyone can list a wallet in the Marketplace.
*   **Earn:** If users copy a wallet you listed, **1% of their net profit** is sent to *your* wallet automatically.
*   **Finder's Fee:** You don't have to be the trader. You just need to be the one who found them.
