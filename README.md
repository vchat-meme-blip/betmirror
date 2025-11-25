
# Bet Mirror | Pro Cloud Terminal

![Bet Mirror Header](./docs/assets/header.png)

**The world's first AI-powered, 24/7 server-side copy trading platform for Polymarket.**

Developed by **PolyCafe**.

![License](https://img.shields.io/badge/license-Apache_2.0-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![React](https://img.shields.io/badge/React-18-blue)
![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-green)
![ZeroDev](https://img.shields.io/badge/ZeroDev-AA-purple)

**Bet Mirror Pro** is a sophisticated trading terminal that allows users to mirror high-performance Polymarket traders automatically. Unlike traditional bots that require your private keys, Bet Mirror Pro uses **Account Abstraction (ERC-4337)** to separate *Ownership* from *Trading Permissions*.

---

## 🚀 How It Works

Bet Mirror Pro transforms complex algorithmic trading into a simple 3-step process for the end user.

### 1. The Smart Onboarding
- **Connect:** User connects their standard EOA (Metamask, Phantom, Rabinbow).
- **Deploy:** The app automatically deploys a **ZeroDev Smart Account** (Kernel v3.1) owned by the user.
- **Session Keys:** The user signs a specific "Session Key" that grants the Bot Server permission to **Trade Only**. The server cannot withdraw funds.

### 2. The Cloud Engine (Server-Side)
- **Persistence:** Once the bot is started, it runs on our Node.js cloud cluster backed by **MongoDB**.
- **Offline Trading:** The user can close their browser or turn off their computer. The bot continues to monitor markets and execute trades 24/7.
- **AI Analysis:** Before every trade, the **Google Gemini 2.5** Agent analyzes the market question to ensure it aligns with the user's risk profile (Conservative, Balanced, or Degen).

### 3. The Marketplace & Profit
- **Copy Trading:** Users browse the **Alpha Registry** to find whales with high win rates.
- **Fee Sharing:** When a user profits from a copied trade, a **1% fee** is automatically sent to the original trader (The Lister) and **1%** to the Platform.
- **Trustless Withdraw:** Users can trigger a forced withdrawal from the dashboard at any time, bypassing the server entirely.

---

## 🖥️ Interface Preview

### 📊 The Dashboard
The command center. View your Real-Time PnL, Active Positions, and System Logs.
> *Displays wallet balances (Native & Smart Account), Live Trade Console, and Performance Metrics.*

### 🔒 The Vault
Security first. Configure your AI Risk settings and manage automation.
> *Manage API Keys, Risk Profiles (Conservative/Degen), Auto-Cashout thresholds, and SMS Notification settings.*

### 🌍 The Alpha Registry
A decentralized marketplace for trading signals.
> *A leaderboard of top Polymarket traders. Users can "One-Click Copy" any wallet listed here. Listers earn passive income from copiers.*

### 🌉 Cross-Chain Bridge
Fund your bot from anywhere.
> *Integrated Li.Fi Widget allows deposits from Ethereum, Base, Solana, and Arbitrum directly into the Polygon Smart Account.*

---

## 🏗 System Architecture

The platform uses a hybrid architecture combining the speed of centralized execution with the security of decentralized custody.

[📖 **Read the Full Architecture Guide**](./ARCHITECTURE.md)

```mermaid
graph TD
    User["User / Wallet"] -->|"Signs Session Key"| React["Web Terminal"]
    React -->|"Encrypted Key"| API["Node.js API Server"]
    
    subgraph "Cloud Infrastructure"
        API -->|"Persist State"| DB[("MongoDB Atlas")]
        API -->|"AI Analysis"| Gemini["Gemini 2.5 Flash"]
        API -->|"Bridge Quotes"| LiFi["Li.Fi Protocol"]
    end
    
    subgraph "Blockchain (Polygon)"
        API -->|"Execute Trade (Session Key)"| SmartAccount["ZeroDev Smart Account"]
        SmartAccount -->|"Interact"| Poly["Polymarket CTF"]
    end
```

### 💎 Key Features

#### 1. 🛡️ Non-Custodial Smart Accounts (ZeroDev)
We do not ask for your Private Key. Instead, the app deploys a **Smart Contract Wallet** owned by you.
- **Security:** You can revoke the bot's access on-chain at any time.
- **Gas Abstraction:** Future-proofed for gasless transactions.

#### 2. ☁️ Cloud Persistence (MongoDB Atlas)
Your bot runs 24/7 on the server.
- **Auto-Recovery:** If the server restarts, your bot automatically rehydrates from the database and resumes trading.
- **Trade History:** Every trade, PnL, and AI reasoning log is permanently stored.

#### 3. 🌉 Cross-Chain Bridge (Li.Fi)
Fund your trading bot from anywhere.
- **Supported Chains:** Ethereum, Base, Arbitrum, BSC, Solana.
- **One-Click:** Swaps and Bridges funds directly into your Polygon Smart Account in one transaction.

---

## 📸 Screenshots

![Dashboard View](./docs/assets/dashboard_view.png)
*Real-time Dashboard with Asset Matrix and Performance Metrics.*

![Bridge Interface](./docs/assets/bridge_view.png)
*Cross-Chain Deposit via Li.Fi.*

---

## 🛠️ Technology Stack

*   **Frontend:** React, Vite, TailwindCSS, Lucide Icons.
*   **Backend:** Node.js, Express, TypeScript.
*   **Database:** MongoDB (Mongoose ODM).
*   **Web3:** Viem, Ethers.js, ZeroDev SDK (Kernel v3.1), Li.Fi SDK.
*   **AI:** Google GenAI SDK (Gemini 2.5).

---

## 🚀 Quick Start Guide

### 1. Prerequisites
- Node.js v18+
- MongoDB Atlas Cluster (Free Tier is fine)
- ZeroDev Project ID (Free Tier)
- Google Gemini API Key (Free)

### 2. Installation
```bash
git clone https://github.com/your-repo/bet-mirror.git
cd bet-mirror
npm install
```

### 3. Configuration
Create a `.env` file in the root directory:

```env
# --- Database (Required) ---
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/?retryWrites=true&w=majority

# --- Account Abstraction (Required) ---
# Get this from dashboard.zerodev.app (Polygon Mainnet)
ZERODEV_PROJECT_ID=your_project_id
ZERODEV_RPC=https://rpc.zerodev.app/api/v2/bundler/your_project_id

# --- Admin Revenue ---
# Wallet that receives 1% platform fees
ADMIN_REVENUE_WALLET=0xYourColdWalletAddress
```

### 4. Run Development Environment
This starts both the Backend API (Port 3000) and Frontend (Port 5173).
```bash
npm run dev:all
```

### 5. Production Build (Docker)
Deploying to a cloud provider (Railway, Sliplane, DigitalOcean)? Use the Dockerfile.
```bash
docker build -t bet-mirror .
docker run -p 3000:3000 -e MONGODB_URI=... bet-mirror
```

---

## 🔒 Security Model

| Component | Responsibility | Access Level |
| :--- | :--- | :--- |
| **Owner Key** | Held by User (Metamask) | **Full Admin**. Can withdraw funds, pause bot, change settings. |
| **Session Key** | Held by Server (Encrypted DB) | **Limited**. Can only execute trades. Cannot withdraw. |
| **Database** | MongoDB Atlas | Stores Config, History, and Encrypted Session Keys. |

---

## ⚠️ Disclaimer

This software is for educational purposes only. Prediction markets involve risk. The "Trustless" architecture protects against server-side theft, but it does not protect against bad trading decisions or smart contract bugs. Use at your own risk.
