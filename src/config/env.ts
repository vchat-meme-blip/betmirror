
import fs from 'fs';
import path from 'path';

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
  
  // Polymarket Builder Program Credentials
  builderApiKey?: string;
  builderApiSecret?: string;
  builderApiPassphrase?: string;
  
  // Builder Profile ID for Stats (e.g. "BetMirror")
  builderId?: string;
  
  // The Global Registry (The "Backend" that tracks who listed what)
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

  // AA
  zeroDevRpc: string;
  zeroDevProjectId?: string;
  
  // Li.Fi Monetization
  lifiIntegrator: string;
  lifiApiKey?: string;

  // Database
  mongoUri: string;
  mongoEncryptionKey?: string;
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
              // Split by newline OR comma, trim, and filter for valid EVM addresses
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
  
  // Merge .env addresses with file addresses and remove duplicates
  if (fileAddresses.length > 0) {
      userAddresses = Array.from(new Set([...userAddresses, ...fileAddresses]));
      console.log(`✅ Loaded ${userAddresses.length} unique system wallets.`);
  }

  // Use the provided Atlas URI as the default if env var is missing
  const defaultMongoUri = 'mongodb+srv://limeikenji_db_user:lT4HIyBhbui8vFQr@cluster0.bwk2i6s.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

  const env: RuntimeEnv = {
    userAddresses,
    proxyWallet: process.env.PUBLIC_KEY || '', 
    privateKey: process.env.PRIVATE_KEY || '',
    
    rpcUrl: process.env.RPC_URL || 'https://polygon-rpc.com',
    fetchIntervalSeconds: Number(process.env.FETCH_INTERVAL ?? 1),
    tradeMultiplier: Number(process.env.TRADE_MULTIPLIER ?? 1.0),
    retryLimit: Number(process.env.RETRY_LIMIT ?? 3),
    aggregationEnabled: String(process.env.TRADE_AGGREGATION_ENABLED ?? 'false') === 'true',
    aggregationWindowSeconds: Number(process.env.TRADE_AGGREGATION_WINDOW_SECONDS ?? 300),
    usdcContractAddress: process.env.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    
    // Trade API Keys
    polymarketApiKey: process.env.POLYMARKET_API_KEY,
    polymarketApiSecret: process.env.POLYMARKET_API_SECRET,
    polymarketApiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    
    // Builder Program Keys (Attribution)
    builderApiKey: process.env.POLY_BUILDER_API_KEY,
    builderApiSecret: process.env.POLY_BUILDER_SECRET,
    builderApiPassphrase: process.env.POLY_BUILDER_PASSPHRASE,
    builderId: process.env.POLY_BUILDER_ID || 'BetMirror',
    
    registryApiUrl: process.env.REGISTRY_API_URL || 'http://localhost:3000/api',

    adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET || '0xAdminRevenueWalletHere',

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

    // AA
    zeroDevRpc: process.env.ZERODEV_RPC || 'https://rpc.zerodev.app/api/v2/bundler/your-project-id',
    zeroDevProjectId: process.env.ZERODEV_PROJECT_ID,
    
    // Li.Fi
    lifiIntegrator: process.env.LIFI_INTEGRATOR || 'BetMirror',
    lifiApiKey: process.env.LIFI_API_KEY,

    // Database
    mongoUri: process.env.MONGODB_URI || defaultMongoUri,
    mongoEncryptionKey: process.env.MONGO_ENCRYPTION_KEY || 'MmExQl8lTwgxA40wxbL5k5m+UCPb/0YvO5CDjypmiT0='
  };

  return env;
}
