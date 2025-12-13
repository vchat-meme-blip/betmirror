import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
// 1. Load standard .env
dotenv.config();
// 2. Explicitly load .env.local if it exists (Vite does this auto, Node does not)
const localEnvPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(localEnvPath)) {
    console.log(`📄 Detected .env.local at ${localEnvPath}. Loading...`);
    const result = dotenv.config({ path: localEnvPath, override: true });
    if (result.error) {
        console.warn("   ⚠️ Error loading .env.local:", result.error);
    }
}
// --- CONSTANTS ---
// Polygon Mainnet Chain ID
export const POLYGON_CHAIN_ID = 137;
// STRICT TOKEN DEFINITIONS
export const TOKENS = {
    POL: '0x0000000000000000000000000000000000000000', // Native Gas Token
    USDC_NATIVE: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Circle Standard (NOT USED BY POLYMARKET)
    USDC_BRIDGED: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' // Polymarket Standard (USDC.e)
};
export const WS_URLS = {
    CLOB: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    DATA: 'wss://ws-subscriptions-clob.polymarket.com/ws/data'
};
export function loadEnv() {
    const parseList = (val) => {
        if (!val)
            return [];
        try {
            const maybeJson = JSON.parse(val);
            if (Array.isArray(maybeJson))
                return maybeJson.map(String);
        }
        catch (_) {
            // not JSON, parse as comma separated
        }
        return val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    };
    // --- Load Wallets from File (wallets.txt) ---
    const loadWalletsFromFile = () => {
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
            }
            catch (e) {
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
    // --- BUILDER CREDENTIALS DEBUG ---
    const bKey = process.env.POLY_BUILDER_API_KEY;
    const bSecret = process.env.POLY_BUILDER_SECRET;
    const bPass = process.env.POLY_BUILDER_PASSPHRASE;
    if (bKey && bSecret && bPass) {
        console.log(`🔑 Builder Credentials Loaded: YES (Key: ${bKey.substring(0, 4)}...)`);
    }
    else {
        console.warn(`⚠️ Builder Credentials NOT FOUND in process.env. Check .env or .env.local location.`);
    }
    const defaultMongoUri = 'mongodb+srv://limeikenji_db_user:lT4HIyBhbui8vFQr@cluster0.bwk2i6s.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
    const env = {
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
        builderApiKey: bKey,
        builderApiSecret: bSecret,
        builderApiPassphrase: bPass,
        builderId: process.env.POLY_BUILDER_ID || 'BetMirror',
        registryApiUrl: process.env.REGISTRY_API_URL || 'http://localhost:3000/api',
        adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET || '0x0000000000000000000000000000000000000000',
        // Automation
        mainWalletAddress: process.env.MAIN_WALLET_ADDRESS,
        maxRetentionAmount: process.env.MAX_RETENTION_AMOUNT ? Number(process.env.MAX_RETENTION_AMOUNT) : undefined,
        enableAutoCashout: String(process.env.ENABLE_AUTO_CASHOUT ?? 'false') === 'true',
        // Safety
        maxTradeAmount: Number(process.env.MAX_TRADE_AMOUNT ?? 100), // Default $100 cap per trade
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
