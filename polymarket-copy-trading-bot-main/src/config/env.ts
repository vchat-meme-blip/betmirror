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

  const required = (name: string, v: string | undefined): string => {
    // If we are just running the server, we might not need these, but for the BOT they are required.
    // We throw to ensure the bot doesn't start in a broken state.
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };

  // Graceful fallback for Admin-only setup
  const isServerMode = process.env.npm_lifecycle_event === 'start:server';

  const userAddresses = parseList(process.env.USER_ADDRESSES);
  if (userAddresses.length === 0 && !isServerMode) {
    console.warn('USER_ADDRESSES is empty. Configure via Dashboard.');
  }

  const env: RuntimeEnv = {
    userAddresses,
    // THE PROXY WALLET: Only required if running the BOT.
    proxyWallet: isServerMode ? '' : required('PUBLIC_KEY', process.env.PUBLIC_KEY), 
    privateKey: isServerMode ? '' : required('PRIVATE_KEY', process.env.PRIVATE_KEY),
    
    rpcUrl: process.env.RPC_URL || 'https://polygon-rpc.com',
    fetchIntervalSeconds: Number(process.env.FETCH_INTERVAL ?? 1),
    tradeMultiplier: Number(process.env.TRADE_MULTIPLIER ?? 1.0),
    retryLimit: Number(process.env.RETRY_LIMIT ?? 3),
    aggregationEnabled: String(process.env.TRADE_AGGREGATION_ENABLED ?? 'false') === 'true',
    aggregationWindowSeconds: Number(process.env.TRADE_AGGREGATION_WINDOW_SECONDS ?? 300),
    usdcContractAddress: process.env.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    polymarketApiKey: process.env.POLYMARKET_API_KEY,
    polymarketApiSecret: process.env.POLYMARKET_API_SECRET,
    polymarketApiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    
    // Default to localhost for dev, but this should be your deployed server URL
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
  };

  return env;
}
