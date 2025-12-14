
# 🏛️ Upgrade Plan: Gnosis Safe & Builder Attribution

> **STATUS: COMPLETED / LIVE**
> This upgrade was successfully deployed in v2.3.0.

**Version:** 3.0.0-beta
**Objective:** Transition Bet Mirror Pro from Standard EOA Trading to Gnosis Safe (Smart Wallet) Trading.
**Goal:** Enable gasless trading, institutional-grade security, and full Polymarket Builder Program attribution.

---

## 1. Executive Summary

Currently, Bet Mirror uses **Signature Type 0 (EOA)**. The bot holds a private key, funds are stored in that EOA, and the bot signs trades directly.

We are migrating to **Signature Type 2 (Gnosis Safe)** via the **Polymarket Relayer**.
*   **Signer (EOA):** The bot still generates/holds an encrypted private key. This key is now only the **Owner/Controller**.
*   **Funder (Safe):** A Gnosis Safe Proxy is deployed on Polygon. This contract holds the USDC.e and positions.
*   **Relayer:** We submit meta-transactions to the Relayer. The Relayer pays the MATIC gas fees and submits the tx to the blockchain.

**Benefits:**
1.  **Gasless for Users:** Users no longer need to deposit POL (Matic).
2.  **Builder Rewards:** We get official attribution for volume generated.
3.  **Future Proofing:** Ready for session keys and advanced permissions.

---

## 2. Architecture Changes

### A. Entity Relationship
| Component | Old Model (EOA) | New Model (Safe) |
| :--- | :--- | :--- |
| **Address** | EOA Public Key | Gnosis Safe Proxy Address |
| **Custody** | Private Key | Smart Contract (Controlled by Private Key) |
| **Gas Payer** | User (Must deposit POL) | Polymarket Relayer (Free) |
| **Trade Signature** | Type 0 (Direct) | Type 2 (Ask Safe to trade) |
| **Token Approvals** | Standard `token.approve()` | Relayer Meta-Transaction |

### B. Data Flow
1.  **Startup:** Bot checks if Safe is deployed for the Signer EOA.
2.  **Deployment:** If not, Bot asks Relayer to deploy Safe (Gasless).
3.  **Approval:** Bot asks Relayer to approve USDC for CTF Exchange (Gasless).
4.  **Trading:** Bot generates order -> Signs with EOA -> Sends to CLOB with `funderAddress` = Safe Address.

---

## 3. Implementation Specification

### 3.1. Dependencies
We need to add the official Polymarket Builder SDKs.
*   `@polymarket/builder-relayer-client`: For deploying Safes and sending gasless transactions.
*   `@polymarket/builder-signing-sdk`: For signing headers required by the Builder program.

### 3.2. Database Schema (`TradingWalletConfig`)
We need to track the Safe address alongside the Signer address.

```typescript
// src/domain/wallet.types.ts
export interface TradingWalletConfig {
  address: string; // The EOA Signer Address
  type: 'TRADING_EOA' | 'GNOSIS_SAFE'; // Update type definition
  safeAddress?: string; // NEW: The deployed Safe address (The Funder)
  isSafeDeployed?: boolean; // NEW: Deployment status
  // ... existing fields
}
```

### 3.3. New Service: `SafeManagerService`
A dedicated service to handle interactions with the Relayer.

*   **Responsibility:**
    *   Derive deterministic Safe Address.
    *   Check deployment status.
    *   Deploy Safe via Relayer.
    *   Execute Batch Approvals (USDC/CTF) via Relayer.
*   **Location:** `src/services/safe-manager.service.ts`

### 3.4. Adapter Upgrade: `PolymarketAdapter`
The core trading logic needs a massive overhaul.

*   **`initialize()`**: Must now initialize `RelayClient` alongside `ClobClient`.
*   **`authenticate()`**:
    *   **Old:** Check EOA allowance.
    *   **New:** Check Safe allowance. If missing, call `SafeManager.enableApprovals()`.
*   **`createOrder()`**:
    *   **Old:** `SignatureType.EOA` (0).
    *   **New:** `SignatureType.POLY_GNOSIS_SAFE` (2).
    *   **Param:** Must pass `funderAddress: safeAddress` to the CLOB client.

### 3.5. Bot Engine Orchestration
The `BotEngine.start()` flow must be updated to handle the deployment lifecycle.

1.  **Decrypt Key:** Load EOA Signer.
2.  **Init Safe Manager:** Derive Safe Address.
3.  **Check Funding:** Check balances of **Safe Address** (not EOA).
4.  **Deploy (If Funded):** If the user has deposited funds but Safe isn't deployed, deploy it now.
5.  **Approve:** Ensure Proxy has allowances.
6.  **Trade:** Start the loop.

---

## 4. Migration Strategy (Crucial)

We have existing users with funds in EOA wallets.

### Scenario A: New User
*   System generates EOA.
*   System derives Safe Address.
*   User deposits to **Safe Address**.
*   Bot starts -> Deploys Safe -> Trades.

### Scenario B: Existing User (Migration)
*   User has funds in EOA.
*   **Action:** When bot starts, it detects EOA Balance > 0.
*   **Logic:**
    *   1. Deploy Safe (if needed).
    *   2. Perform an internal transfer: `EOA -> Safe`.
    *   3. This costs Gas (POL). We use the remaining POL in the EOA to fund this migration transaction.
    *   4. Once funds are in Safe, proceed with gasless trading.

---

## 5. Execution Checklist

- [x] **Step 1:** Install npm dependencies.
- [x] **Step 2:** Define new types in `wallet.types.ts`.
- [x] **Step 3:** Implement `src/services/safe-manager.service.ts`.
- [x] **Step 4:** Refactor `PolymarketAdapter` to support Dual-Client (Relay + CLOB).
- [x] **Step 5:** Update `BotEngine` startup sequence.
- [x] **Step 6:** Update Frontend (Dashboard) to display "Safe Address" instead of EOA.
- [x] **Step 7:** Update Bridge Service to target Safe Address.

---

## 6. Safety & Security

*   **Builder Credentials:** The `POLY_BUILDER_API_KEY` and `SECRET` must be stored in `.env`.
*   **Isolation:** We still use the "Dedicated Key" model. The EOA is only used for this specific Safe.
*   **Attribution:** All orders will now carry the `brokerCode` (Builder ID) automatically via the SDK.
