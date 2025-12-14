
export type WalletType = 'TRADING_EOA' | 'GNOSIS_SAFE';

export interface L2ApiCredentials {
    key: string;        // Client expects 'key'
    secret: string;     // Client expects 'secret'
    passphrase: string;
}

export interface TradingWalletConfig {
  address: string; // The EOA Signer Address (Controller)
  type: WalletType;
  
  // Encrypted Private Key (Server-Side Custody)
  encryptedPrivateKey: string; 
  
  // Link to the main user
  ownerAddress: string; 
  createdAt: string;

  // L2 Auth Credentials
  l2ApiCredentials?: L2ApiCredentials;

  // GNOSIS SAFE SOURCE OF TRUTH
  // Once set, this NEVER changes. It is the vault.
  safeAddress?: string; 
  
  // Track if we have confirmed code on-chain
  isSafeDeployed?: boolean; 
  
  // Metadata for recovery (Salt used to derive)
  saltNonce?: number;
}

export interface WalletBalance {
  pol: number;
  usdc: number;
  formatted: string;
}
