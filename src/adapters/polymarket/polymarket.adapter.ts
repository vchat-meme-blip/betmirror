
import { 
    IExchangeAdapter, 
    OrderParams
} from '../interfaces.js';
import { OrderBook } from '../../domain/market.types.js';
import { TradeSignal } from '../../domain/trade.types.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { Wallet, JsonRpcProvider, Contract, formatUnits } from 'ethers';
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { SafeManagerService } from '../../services/safe-manager.service.js';
import { TradingWalletConfig } from '../../domain/wallet.types.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { Logger } from '../../utils/logger.util.js';
import { TOKENS } from '../../config/env.js';
import axios from 'axios';

const HOST_URL = 'https://clob.polymarket.com';
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

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
    private safeManager?: SafeManagerService;
    private usdcContract?: Contract;
    private provider?: JsonRpcProvider;
    private safeAddress?: string;

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
        this.logger.info(`[${this.exchangeName}] Initializing Adapter...`);
        
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        
        if (this.config.walletConfig.encryptedPrivateKey) {
             this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
             this.patchWalletForSdk(this.wallet);
        } else {
             throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }

        // Initialize Safe Manager
        const existingSafeAddress = this.config.walletConfig.safeAddress;

        this.safeManager = new SafeManagerService(
            this.wallet,
            this.config.builderApiKey,
            this.config.builderApiSecret,
            this.config.builderApiPassphrase,
            this.logger,
            existingSafeAddress 
        );

        // Derive/Get Safe Address
        this.safeAddress = await this.safeManager.getSafeAddress();
        this.logger.info(`   Smart Bot Address: ${this.safeAddress}`);

        this.provider = new JsonRpcProvider(this.config.rpcUrl);
        this.usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI, this.provider);
    }

    private patchWalletForSdk(wallet: Wallet) {
        if (!(wallet as any)._signTypedData) {
            (wallet as any)._signTypedData = async (domain: any, types: any, value: any) => {
                // Ethers v6 vs Polymarket SDK Compatibility Patch
                const sanitizedTypes = { ...types };
                
                // 1. Remove EIP712Domain from types (it's implicit in v6)
                if (sanitizedTypes.EIP712Domain) {
                    delete sanitizedTypes.EIP712Domain;
                }
                
                // 2. Ensure Domain ChainID is a Number (SDK sometimes passes string "137")
                const sanitizedDomain = { ...domain };
                if (sanitizedDomain.chainId) {
                    sanitizedDomain.chainId = parseInt(String(sanitizedDomain.chainId), 10);
                }

                // 3. Forward to standard v6 method
                return wallet.signTypedData(sanitizedDomain, sanitizedTypes, value);
            };
        }
    }

    async validatePermissions(): Promise<boolean> {
        return true;
    }

    async authenticate(): Promise<void> {
        if (!this.wallet || !this.safeManager || !this.safeAddress) throw new Error("Adapter not initialized");

        // 1. Ensure Safe is Deployed
        await this.safeManager.deploySafe();

        // 2. Ensure Approvals
        await this.safeManager.enableApprovals();

        // 3. L2 Auth (API Keys)
        let apiCreds = this.config.l2ApiCredentials;
        if (!apiCreds || !apiCreds.key) {
            this.logger.info('🤝 Deriving L2 API Keys...');
            await this.deriveAndSaveKeys();
            apiCreds = this.config.l2ApiCredentials; 
        } else {
             this.logger.info('🔌 Using existing CLOB Credentials');
        }

        // 4. Initialize Clob Client
        this.initClobClient(apiCreds);
    }

    private initClobClient(apiCreds: any) {
        let builderConfig: BuilderConfig | undefined;
        if (this.config.builderApiKey && this.config.builderApiSecret && this.config.builderApiPassphrase) {
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
            this.wallet as any, // Signer is EOA
            apiCreds,
            SignatureType.POLY_GNOSIS_SAFE, // Funder is Safe
            this.safeAddress, // Explicitly set funder
            undefined, 
            undefined,
            builderConfig
        );
    }

    private async deriveAndSaveKeys() {
        try {
            // Keys must be derived using SignatureType.EOA because the EOA is the signer.
            // Polymarket associates keys with the signer address, not the proxy address.
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

    async createOrder(params: OrderParams, retryCount = 0): Promise<string> {
        if (!this.client) throw new Error("Client not authenticated");

        try {
            // 0. DETERMINE MARKET TYPE (NEG RISK vs STANDARD)
            let negRisk = false;
            try {
                // marketId in params is the conditionId
                const market = await this.client.getMarket(params.marketId);
                negRisk = market.neg_risk;
            } catch (e) {
                // If getMarket fails (common for some old markets), fallback to Data API or assume False
                this.logger.debug(`[Order] Could not fetch market details for ${params.marketId}, assuming negRisk=false`);
            }

            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            
            // 1. PRICE DISCOVERY
            let priceToUse: number;
            if (params.priceLimit !== undefined) {
                priceToUse = params.priceLimit;
            } else {
                 const book = await this.client.getOrderBook(params.tokenId);
                 if (side === Side.BUY) {
                     if (!book.asks || book.asks.length === 0) return "skipped_no_liquidity";
                     priceToUse = Number(book.asks[0].price);
                 } else {
                     if (!book.bids || book.bids.length === 0) return "skipped_no_liquidity";
                     priceToUse = Number(book.bids[0].price);
                 }
            }
            
            let price = Math.floor(priceToUse * 100) / 100;
            if (price >= 1.00) price = 0.99;
            if (price < 0.01) price = 0.01;

            // 2. SIZE CALCULATION
            const rawSize = params.sizeUsd / price;
            let size = Math.floor(rawSize);

            if (size < 1) return "skipped_dust_size";

            // 3. CONSTRUCT ORDER (Aligned with Wagmi Safe Builder Example)
            // Note: We deliberately allow 'nonce' to be undefined so the SDK handles it
            // We explicit set taker to zero address
            const order: any = {
                tokenID: params.tokenId,
                price: price,
                side: side,
                size: size,
                feeRateBps: 0,
                expiration: 0,
                taker: "0x0000000000000000000000000000000000000000"
            };

            this.logger.info(`📝 Placing Order (Safe): ${params.side} $${(size*price).toFixed(2)} (${size} shares @ ${price}) [NegRisk: ${negRisk}]`);

            // Use createAndPostOrder helper which handles signature & posting in one go
            const res = await this.client.createAndPostOrder(
                order, 
                { negRisk }, 
                OrderType.GTC 
            );

            if (res && res.success) {
                this.logger.success(`✅ Order Accepted. Tx: ${res.transactionHash || res.orderID || 'OK'}`);
                return res.orderID || res.transactionHash || "filled";
            }
            
            throw new Error(res.errorMsg || "Order failed");

        } catch (error: any) {
            // Check for Auth Errors and Retry ONCE
            const errStr = String(error);
            if (retryCount < 1 && (errStr.includes("401") || errStr.includes("403") || errStr.includes("invalid signature") || errStr.includes("auth"))) {
                this.logger.warn("⚠️ Auth Error during Order. Refreshing keys and retrying...");
                this.config.l2ApiCredentials = undefined; // Force refresh
                await this.deriveAndSaveKeys();
                this.initClobClient(this.config.l2ApiCredentials);
                return this.createOrder(params, retryCount + 1);
            }
            
            const errorMsg = error.response?.data?.error || error.message;
            if (errorMsg?.includes("allowance")) {
                this.logger.error("❌ Trade Failed: Not Enough Allowance. Retrying approvals...");
                await this.safeManager?.enableApprovals();
            } else if (errorMsg?.includes("balance")) {
                this.logger.error("❌ Trade Failed: Insufficient USDC.e Balance in Safe.");
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
        if (!this.safeManager) throw new Error("Safe Manager not initialized");
        const amountStr = Math.floor(amount * 1000000).toString();
        return await this.safeManager.withdrawUSDC(destination, amountStr);
    }
    
    getFunderAddress() {
        return this.safeAddress || this.config.walletConfig.address;
    }
}
