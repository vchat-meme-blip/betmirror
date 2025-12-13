
export type WalletType = 'TRADING_EOA' | 'GNOSIS_SAFE';

export interface L2ApiCredentials {
    key: string;        // Client expects 'key'
    secret: string;     // Client expects 'secret'
    passphrase: string;
}

export interface TradingWalletConfig {
  address: string; // The EOA Signer Address
  type: WalletType;
  
  // Encrypted Private Key (Server-Side Custody / Burner Wallet)
  encryptedPrivateKey: string; 
  
  // Link to the main user (Admin)
  ownerAddress: string; 
  createdAt: string;

  // L2 Auth (Trading) Credentials
  l2ApiCredentials?: L2ApiCredentials;

  // Gnosis Safe Fields (Type 2)
  safeAddress?: string; // The deployed Safe Address (Funder)
  isSafeDeployed?: boolean; 
}

export interface WalletBalance {
  pol: number;
  usdc: number;
  formatted: string;
}
