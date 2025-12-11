
export type WalletType = 'TRADING_EOA';

export interface L2ApiCredentials {
    key: string;        // Client expects 'key'
    secret: string;     // Client expects 'secret'
    passphrase: string;
}

export interface TradingWalletConfig {
  address: string;
  type: WalletType;
  
  // Encrypted Private Key (Server-Side Custody / Burner Wallet)
  encryptedPrivateKey: string; 
  
  // Link to the main user (Admin)
  ownerAddress: string; 
  createdAt: string;

  // L2 Auth (Trading) Credentials
  l2ApiCredentials?: L2ApiCredentials;
}

export interface WalletBalance {
  pol: number;
  usdc: number;
  formatted: string;
}
