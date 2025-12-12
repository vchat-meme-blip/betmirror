
import { 
    IExchangeAdapter, 
    OrderParams
} from '../interfaces.js';
import { OrderBook } from '../../domain/market.types.js';
import { TradeSignal } from '../../domain/trade.types.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { Wallet, JsonRpcProvider, Contract, MaxUint256, formatUnits, parseUnits } from 'ethers';
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { TradingWalletConfig } from '../../domain/wallet.types.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { Logger } from '../../utils/logger.util.js';
import axios from 'axios';

// --- CONSTANTS ---
const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYMARKET_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const HOST_URL = 'https://clob.polymarket.com';

const USDC_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
];

enum SignatureType {
    EOA = 0,
    POLY_PROXY = 1,
    POLY_GNOSIS_SAFE = 2
}

interface PolyActivityResponse {
  type: string;
  timestamp: number;
  conditionId: string;
  asset: string;
  size: number;
  usdcSize: number;
  price: number;
  side: string;
  outcomeIndex: number;
  transactionHash: string;
}

export class PolymarketAdapter implements IExchangeAdapter {
    readonly exchangeName = 'Polymarket';
    
    private client?: ClobClient;
    private wallet?: Wallet; 
    private walletService?: EvmWalletService;
    private usdcContract?: Contract;
    private provider?: JsonRpcProvider;
    
    constructor(
        private config: {
            rpcUrl: string;
            walletConfig: TradingWalletConfig;
            userId: string;
            l2ApiCredentials?: any;
            builderApiKey?: string;
            builderApiSecret?: string;
            builderApiPassphrase?: string;
            mongoEncryptionKey: string;
        },
        private logger: Logger
    ) {}

    async initialize(): Promise<void> {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter (EOA Mode)...`);
        
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        
        if (this.config.walletConfig.encryptedPrivateKey) {
             this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
             this.patchWalletForSdk(this.wallet);
        } else {
             throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }

        this.provider = new JsonRpcProvider(this.config.rpcUrl);
        this.usdcContract = new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, this.provider);
    }

    private patchWalletForSdk(wallet: Wallet) {
        if (!(wallet as any)._signTypedData) {
            (wallet as any)._signTypedData = async (domain: any, types: any, value: any) => {
                if (types && types.EIP712Domain) {
                    delete types.EIP712Domain;
                }
                return wallet.signTypedData(domain, types, value);
            };
        }
    }

    async validatePermissions(): Promise<boolean> {
        return true;
    }

    async authenticate(): Promise<void> {
        let apiCreds = this.config.l2ApiCredentials;
        
        if (!this.wallet) throw new Error("Wallet not initialized");

        // 1. L2 Auth
        if (!apiCreds || !apiCreds.key) {
            this.logger.info('🤝 Deriving L2 API Keys...');
            await this.deriveAndSaveKeys();
            apiCreds = this.config.l2ApiCredentials; 
        } else {
             this.logger.info('🔌 Using existing CLOB Credentials');
        }
        this.initClobClient(apiCreds);

        // 2. Blockchain Auth (Allowance) - BLOCKING CHECK
        await this.ensureAllowance();
    }

    private initClobClient(apiCreds: any) {
        let builderConfig: BuilderConfig | undefined;
        
        // Inject Builder Credentials if available in Env
        if (this.config.builderApiKey && this.config.builderApiSecret && this.config.builderApiPassphrase) {
            this.logger.info('🏗️ Builder Attribution Enabled');
            builderConfig = new BuilderConfig({ 
                localBuilderCreds: {
                    key: this.config.builderApiKey,
                    secret: this.config.builderApiSecret,
                    passphrase: this.config.builderApiPassphrase
                }
            });
        }

        this.client = new ClobClient(
            HOST_URL,
            Chain.POLYGON,
            this.wallet as any, 
            apiCreds,
            SignatureType.EOA, 
            undefined,
            undefined, 
            undefined,
            builderConfig // Pass builder config here
        );
    }

    private async deriveAndSaveKeys() {
        try {
            const tempClient = new ClobClient(
                HOST_URL,
                Chain.POLYGON,
                this.wallet as any,
                undefined,
                SignatureType.EOA,
                undefined
            );

            const rawCreds = await tempClient.createOrDeriveApiKey();
            if (!rawCreds || !rawCreds.key) throw new Error("Empty keys returned");

            const apiCreds = {
                key: rawCreds.key,
                secret: rawCreds.secret,
                passphrase: rawCreds.passphrase
            };

            await User.findOneAndUpdate(
                { address: this.config.userId },
                { "tradingWallet.l2ApiCredentials": apiCreds }
            );
            this.config.l2ApiCredentials = apiCreds;
            this.logger.success('✅ API Keys Derived & Saved');
        } catch (e: any) {
            this.logger.error(`Handshake Failed: ${e.message}`);
            throw e;
        }
    }

    private async ensureAllowance() {
        if(!this.wallet || !this.usdcContract || !this.provider) return;
        
        try {
            const address = this.wallet.address;
            const signerContract = this.usdcContract.connect(this.wallet) as Contract;
            
            // 1. Check Current Allowance
            const allowance = await signerContract.allowance(address, POLYMARKET_EXCHANGE);
            const minRequired = BigInt(1000000 * 100); // $100 USDC allowance minimum
            
            if (allowance >= minRequired) return;

            // 2. Check Gas (POL)
            const polBalance = await this.provider.getBalance(address);
            // Min 0.01 POL needed for approval tx
            const minGas = parseUnits("0.01", 18); 
            
            if (polBalance < minGas) {
                const msg = `CRITICAL: Insufficient POL (Gas) to approve USDC. Balance: ${formatUnits(polBalance, 18)}. Need ~0.01 POL.`;
                this.logger.error(msg);
                // We do NOT throw here, we let it fail downstream so the bot stays "online" but logs errors, 
                // but for trade execution this is fatal.
                return; 
            }

            this.logger.info('🔓 Approving USDC for Trading (One-time)...');
            const tx = await signerContract.approve(POLYMARKET_EXCHANGE, MaxUint256);
            this.logger.info(`   Tx Sent: ${tx.hash} (Waiting for mine...)`);
            await tx.wait();
            this.logger.success(`✅ USDC Approved successfully.`);

        } catch(e: any) { 
            this.logger.error(`Allowance Setup Failed: ${e.message}`);
            throw new Error("Failed to approve USDC allowance. Cannot trade.");
        }
    }

    async fetchBalance(address: string): Promise<number> {
        if(!this.usdcContract) return 0;
        try {
            const bal = await this.usdcContract.balanceOf(address);
            return parseFloat(formatUnits(bal, 6));
        } catch (e) { return 0; }
    }

    async getMarketPrice(marketId: string, tokenId: string): Promise<number> {
        if (!this.client) return 0;
        try {
            const mid = await this.client.getMidpoint(tokenId);
            return parseFloat(mid.mid);
        } catch (e) { return 0; }
    }

    async getOrderBook(tokenId: string): Promise<OrderBook> {
        if (!this.client) throw new Error("Not auth");
        try {
            const book = await this.client.getOrderBook(tokenId);
            return {
                bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
                asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
            };
        } catch (e: any) {
            if (e.message && e.message.includes('404')) {
                throw new Error("Orderbook not found (Market might be closed)");
            }
            throw e;
        }
    }

    async fetchPublicTrades(address: string, limit: number = 20): Promise<TradeSignal[]> {
        try {
            const url = `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`;
            const res = await axios.get<PolyActivityResponse[]>(url);
            if (!res.data || !Array.isArray(res.data)) return [];

            return res.data
                .filter(act => act.type === 'TRADE' || act.type === 'ORDER_FILLED')
                .map(act => ({
                    trader: address,
                    marketId: act.conditionId,
                    tokenId: act.asset,
                    outcome: act.outcomeIndex === 0 ? 'YES' : 'NO',
                    side: act.side.toUpperCase() as 'BUY' | 'SELL',
                    sizeUsd: act.usdcSize || (act.size * act.price),
                    price: act.price,
                    timestamp: (act.timestamp > 1e11 ? act.timestamp : act.timestamp * 1000)
                }));
        } catch (e) { return []; }
    }

    async createOrder(params: OrderParams): Promise<string> {
        if (!this.client) throw new Error("Client not authenticated");

        try {
            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            
            // 1. PRICE DISCOVERY & PROTECTION
            let priceToUse: number;

            // BUG FIX: Check strictly for undefined, as 0 is a number but falsy
            if (params.priceLimit !== undefined) {
                priceToUse = params.priceLimit;
            } else {
                 // Fallback: Get top of book (Risky for low liquidity)
                 const book = await this.client.getOrderBook(params.tokenId);
                 if (side === Side.BUY) {
                     if (!book.asks || book.asks.length === 0) return "skipped_no_liquidity";
                     priceToUse = Number(book.asks[0].price);
                 } else {
                     if (!book.bids || book.bids.length === 0) return "skipped_no_liquidity";
                     priceToUse = Number(book.bids[0].price);
                 }
            }
            
            // Round to 2 decimals for FOK compatibility
            // IMPORTANT: If value is < 0.01 (e.g. 0.005), math.floor(0.5) = 0.
            // We must enforce min tick size of 0.01 for most markets.
            let price = Math.floor(priceToUse * 100) / 100;

            // SANITY CHECK: Clamps
            if (price >= 1.00) price = 0.99;
            if (price < 0.01) price = 0.01;

            // 2. SIZE CALCULATION (CRITICAL FIX)
            // We calculate size based on the ACTUAL price we are sending.
            // This ensures size * price <= sizeUsd.
            const rawSize = params.sizeUsd / price;
            let size = Math.floor(rawSize);

            // 3. MINIMUM SIZE ENFORCEMENT
            if (size < 1) {
                // If the user really wants to bet, we bump to 1 share IF the cost is within bounds
                // But since we calc size based on price, size < 1 means we can't afford even 1 share.
                return "skipped_dust_size";
            }

            const orderArgs = {
                tokenID: params.tokenId,
                price: price,
                side: side,
                size: size,
                feeRateBps: 0,
                nonce: 0 
            };

            this.logger.info(`📝 Placing Order: ${params.side} $${(size*price).toFixed(2)} (${size} shares @ ${price})`);

            const signedOrder = await this.client.createOrder(orderArgs);
            const res = await this.client.postOrder(signedOrder, OrderType.FOK);

            if (res && res.success) {
                this.logger.success(`✅ Order Accepted. Tx: ${res.transactionHash || res.orderID || 'OK'}`);
                return res.orderID || res.transactionHash || "filled";
            }
            
            throw new Error(res.errorMsg || "Order failed");

        } catch (error: any) {
            // AUTH RETRY
            if (String(error).includes("403") || String(error).includes("auth")) {
                this.logger.warn("403 Auth Error during Order. Refreshing keys...");
                this.config.l2ApiCredentials = undefined;
                await this.deriveAndSaveKeys();
                this.initClobClient(this.config.l2ApiCredentials);
                // Retry once
                return this.createOrder(params);
            }
            
            const errorMsg = error.response?.data?.error || error.message;
            
            // Helpful errors
            if (errorMsg?.includes("allowance")) {
                this.logger.error("❌ Trade Failed: Not Enough Allowance. Please deposit ~0.1 POL (Matic) for gas approval.");
                // Trigger an allowance check for next time
                this.ensureAllowance().catch(() => {});
            } else if (errorMsg?.includes("balance")) {
                this.logger.error("❌ Trade Failed: Insufficient USDC.e Balance.");
            } else {
                this.logger.error(`Order Error: ${errorMsg}`);
            }
            
            return "failed";
        }
    }

    async cancelOrder(orderId: string): Promise<boolean> {
        if (!this.client) return false;
        try {
            await this.client.cancelOrder({ orderID: orderId });
            return true;
        } catch (e) { return false; }
    }

    async cashout(amount: number, destination: string): Promise<string> {
        if (!this.walletService || !this.config.walletConfig.encryptedPrivateKey) throw new Error("Wallet not available");
        
        const units = parseUnits(amount.toFixed(6), 6);
        return this.walletService.withdrawFunds(
            this.config.walletConfig.encryptedPrivateKey,
            destination,
            USDC_BRIDGED_POLYGON,
            units
        );
    }
    
    getFunderAddress() {
        return this.config.walletConfig.address;
    }
}
