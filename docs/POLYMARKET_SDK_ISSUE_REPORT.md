
# 🐛 Polymarket SDK Integration Issue: Gnosis Safe Address Mismatch

**Issue Summary:**
Our application deploys Gnosis Safes using a specific Proxy Factory configuration. However, the `@polymarket/builder-relayer-client` and `@polymarket/clob-client` SDKs appear to auto-derive the Safe Address from the Signer (EOA) using default parameters, resulting in a mismatch.

As a result:
1.  We hold funds in Safe `0x80Ff...` (Correct).
2.  The Relayer SDK attempts to execute transactions via Safe `0xEFae...` (Derived/Incorrect).
3.  Transactions fail or execute against an empty wallet.

---

## 1. Environment

*   **Signer (EOA):** `0xBBc264c10F54A61607A31B53358a5A87d4B045be`
*   **Correct Safe (Funded):** `0x80Ff8Bc8306387Bd5B05fF2627fbef97C5D875df`
*   **SDK Derived Safe (Wrong):** `0xEFae63145ffb73Ab047e578324bcA9BaABE5E1Ad`
*   **Factory Used:** `0xa6b71e26c5e0845f74c812102ca7114b6a896ab2` (Polygon Standard 1.3.0)

---

## 2. Code Flow

### A. Initialization & Deployment
We initialize the `RelayClient` with the EOA signer. We expect it to target the `knownSafeAddress` we pass, but it seems to ignore it.

```typescript
// src/services/safe-manager.service.ts

this.relayClient = new RelayClient(
    "https://relayer-v2.polymarket.com",
    137,
    viemClient,
    builderConfig
);

// We verify deployment
const isDeployed = await this.isDeployed(knownSafeAddress); // Returns TRUE for 0x80Ff...
```

### B. Withdrawal Attempt
We attempt to transfer USDC using the Relayer.

```typescript
const usdcInterface = new Interface(ERC20_ABI);
const data = usdcInterface.encodeFunctionData("transfer", [to, amount]);

const tx = {
    to: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e
    value: "0",
    data: data,
    operation: 0
};

// Execution
const task = await this.relayClient.execute([tx]);
```

---

## 3. The Error (Logs)

The SDK constructs a transaction request where `proxyWallet` does not match our deployed Safe.

```json
[0] [SERVER] 💸 Withdrawing via Relayer...
[0] [SERVER]    Target Safe: 0x80Ff8Bc8306387Bd5B05fF2627fbef97C5D875df (Correct)
[0] Created Safe Transaction Request: 
[0] {
[0]   "from": "0xBBc264c10F54A61607A31B53358a5A87d4B045be",
[0]   "proxyWallet": "0xEFae63145ffb73Ab047e578324bcA9BaABE5E1Ad",  <-- ERROR: Wrong Address
[0]   "to": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
[0]   ...
[0] }
```

## 4. Question for Polymarket Support

1.  How can we **force** the `RelayClient` (and `ClobClient`) to use a specific Gnosis Safe address (`0x80Ff...`) instead of the one it auto-derives?
2.  Is there a configuration parameter in `BuilderConfig` or `RelayClient` constructor to specify the `proxyAddress` explicitly?
3.  If we must match the SDK's derivation logic, what specific **Proxy Factory Address** and **SaltNonce** does the SDK use by default?

