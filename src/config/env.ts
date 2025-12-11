
import fs from 'fs';
import path from 'path';

// --- CONSTANTS ---
// Polygon Mainnet Chain ID
export const POLYGON_CHAIN_ID = 137;

// STRICT TOKEN DEFINITIONS
export const TOKENS = {
    POL: '0x0000000000000000000000000000000000000000', // Native Gas Token
    USDC_NATIVE: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Circle Standard (NOT USED BY POLYMARKET)
    USDC_BRIDGED: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' // Polymarket Standard (USDC.e)
};

export type RuntimeEnv = {
  userAddresses: string[];
  proxyWallet: string;
  privateKey: string;
  rpcUrl: string;
  fetchIntervalSeconds: number;
  tradeMultiplier: number;
  retryLimit: number;
  aggregationEnabled: boolean;
  aggregationWindowSeconds: number;
  usdcContractAddress: string;
  polymarketApiKey?: string;
  polymarketApiSecret?: string;
  polymarketApiPassphrase?: string;
  
  // Builder Program Keys (Attribution)
  builderApiKey?: string;
  builderApiSecret?: string;
  builderApiPassphrase?: string;
  builderId?: string;
  
  // The Global Registry
  registryApiUrl: string;

  // Revenue & Admin
  adminRevenueWallet: string;

  // Automation
  mainWalletAddress?: string;
  maxRetentionAmount?: number;
  enableAutoCashout: boolean;
  
  // Notifications
  enableNotifications: boolean;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  userPhoneNumber?: string;

  // Li.Fi
  lifiIntegrator: string;
  lifiApiKey?: string;
  solanaRpcUrl: string;

  // Database
  mongoUri: string;
  // CRITICAL: Used for encrypting the generated trading wallet private keys
  mongoEncryptionKey: string;
};

export function loadEnv(): RuntimeEnv {
  const parseList = (val: string | undefined): string[] => {
    if (!val) return [];
    try {
      const maybeJson = JSON.parse(val);
      if (Array.isArray(maybeJson)) return maybeJson.map(String);
    } catch (_) {
      // not JSON, parse as comma separated
    }
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };

  // --- Load Wallets from File (wallets.txt) ---
  const loadWalletsFromFile = (): string[] => {
      const fileName = process.env.WALLETS_FILE_PATH || 'wallets.txt';
      const absolutePath = path.resolve(process.cwd(), fileName);
      
      if (fs.existsSync(absolutePath)) {
          console.log(`📂 Loading system wallets from ${fileName}...`);
          try {
              const content = fs.readFileSync(absolutePath, 'utf-8');
              return content
                  .split(/[\n,]+/) 
                  .map(s => s.trim())
                  .filter(s => s.startsWith('0x') && s.length === 42);
          } catch (e) {
              console.error(`⚠️ Failed to read ${fileName}`, e);
              return [];
          }
      }
      return [];
  };

  let userAddresses = parseList(process.env.USER_ADDRESSES);
  const fileAddresses = loadWalletsFromFile();
  
  if (fileAddresses.length > 0) {
      userAddresses = Array.from(new Set([...userAddresses, ...fileAddresses]));
      console.log(`✅ Loaded ${userAddresses.length} unique system wallets.`);
  }

  const defaultMongoUri = 'mongodb+srv://limeikenji_db_user:lT4HIyBhbui8vFQr@cluster0.bwk2i6s.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

  const env: RuntimeEnv = {
    userAddresses,
    proxyWallet: process.env.PUBLIC_KEY || '', 
    privateKey: process.env.PRIVATE_KEY || '',
    
    // Default high-performance Polygon RPC
    rpcUrl: process.env.RPC_URL || 'https://polygon-rpc.com',
    
    fetchIntervalSeconds: Number(process.env.FETCH_INTERVAL ?? 1),
    tradeMultiplier: Number(process.env.TRADE_MULTIPLIER ?? 1.0),
    retryLimit: Number(process.env.RETRY_LIMIT ?? 3),
    aggregationEnabled: String(process.env.TRADE_AGGREGATION_ENABLED ?? 'false') === 'true',
    aggregationWindowSeconds: Number(process.env.TRADE_AGGREGATION_WINDOW_SECONDS ?? 300),
    
    // FORCE USE OF BRIDGED USDC.e
    usdcContractAddress: TOKENS.USDC_BRIDGED,
    
    // Trade API Keys
    polymarketApiKey: process.env.POLYMARKET_API_KEY,
    polymarketApiSecret: process.env.POLYMARKET_API_SECRET,
    polymarketApiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    
    // Builder Program Keys
    builderApiKey: process.env.POLY_BUILDER_API_KEY,
    builderApiSecret: process.env.POLY_BUILDER_SECRET,
    builderApiPassphrase: process.env.POLY_BUILDER_PASSPHRASE,
    builderId: process.env.POLY_BUILDER_ID || 'BetMirror',
    
    registryApiUrl: process.env.REGISTRY_API_URL || 'http://localhost:3000/api',
    adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET || '0x0000000000000000000000000000000000000000',

    // Automation
    mainWalletAddress: process.env.MAIN_WALLET_ADDRESS,
    maxRetentionAmount: process.env.MAX_RETENTION_AMOUNT ? Number(process.env.MAX_RETENTION_AMOUNT) : undefined,
    enableAutoCashout: String(process.env.ENABLE_AUTO_CASHOUT ?? 'false') === 'true',
    
    // Notifications
    enableNotifications: String(process.env.ENABLE_NOTIFICATIONS ?? 'false') === 'true',
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    twilioFromNumber: process.env.TWILIO_FROM_NUMBER,
    userPhoneNumber: process.env.USER_PHONE_NUMBER,
    
    // Li.Fi
    lifiIntegrator: process.env.LIFI_INTEGRATOR || 'BetMirror',
    lifiApiKey: process.env.LIFI_API_KEY,
    solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://little-thrilling-layer.solana-mainnet.quiknode.pro/378fe82ae3cb5d38e4ac79c202990ad508e1c4c6',

    // Database
    mongoUri: process.env.MONGODB_URI || defaultMongoUri,
    mongoEncryptionKey: process.env.MONGO_ENCRYPTION_KEY || 'MmExQl8lTwgxA40wxbL5k5m+UCPb/0YvO5CDjypmiT0='
  };

  return env;
}
