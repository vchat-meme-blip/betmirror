
# 🗺️ Bet Mirror Architecture Roadmap

This document outlines the migration path from the current **Custodial SaaS Model** to a **Non-Custodial Account Abstraction Model** with Cross-Chain capabilities.

## Phase 1: Current State (Managed SaaS)
- **Wallet:** EOA (Standard Private Key).
- **Custody:** Server holds private key in `users.json`.
- **Security:** "Trust me bro" model (Server promises not to withdraw).
- **Network:** Polygon Native only.

---

## Phase 2: Cross-Chain Onboarding (LiFi Integration)
**Goal:** Allow users to fund their bot from Solana, Base, BSC, or Mainnet.

### Architecture
1.  **Frontend Integration:**
    - Install `@lifi/sdk`.
    - Create `DepositWidget` component.
    - User selects "Source Chain" (e.g., Base) and "Amount".
2.  **Route Execution:**
    - Source: User's Wallet (Arbitrum/Base/Solana).
    - Destination: User's Proxy Wallet Address (Polygon).
    - LiFi handles the bridging and swapping to USDC.
3.  **Bot Awareness:**
    - Bot listens for incoming transfers on the Proxy Wallet to auto-update balances.

### Technical Tasks
- [x] Implement `src/services/lifi.service.ts`.
- [x] Update Frontend `handleDeposit` to use LiFi instead of direct Ethers tx.
- [x] Add `liFiConfig` to `RuntimeEnv`.

---

## Phase 3: Account Abstraction & Gasless Trading (COMPLETED)
**Goal:** Remove user gas liability and integrate with Polymarket Builder Program.

### Architecture
1.  **Gnosis Safe (Smart Wallet):**
    - Instead of a raw EOA holding funds, we deploy a Gnosis Safe Proxy.
    - The Safe holds the USDC and positions.
2.  **Relayer Execution:**
    - The server holds an encrypted EOA "Signer".
    - The Signer signs a meta-transaction.
    - The **Polymarket Relayer** submits the transaction and pays the gas.
3.  **Authentication:**
    - We use `SignatureType.POLY_GNOSIS_SAFE` (2) for CLOB orders.
    - This allows high-frequency trading via the Safe without on-chain signatures for every order.

### Technical Tasks
- [x] Integrate `@polymarket/builder-relayer-client`.
- [x] Refactor `BotEngine` to use `SafeManagerService`.
- [x] Implement `withdrawNative` and `withdrawUSDC` via Relayer.
- [x] Build "Rescue Tools" for on-chain emergency recovery.

---

## Phase 4: Decentralized Registry (Future)
**Goal:** Move `registry.json` to an on-chain Smart Contract.
- Listers call `Registry.register(wallet)`.
- Copiers call `Registry.payFee()` (handled by bot).
- Removes the central server dependency for fee sharing.
