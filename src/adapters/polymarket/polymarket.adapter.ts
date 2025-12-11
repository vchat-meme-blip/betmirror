
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

// Polymarket CLOB Signature Types
// 0: EOA (Standard Ethereum Wallet) - WE USE THIS NOW
// 1: PolyProxy (Old Magic Link)
// 2: Gnosis Safe
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
    
    constructor(
        private config: {
            rpcUrl: string;
            walletConfig: TradingWalletConfig;
            userId: string;
            l2ApiCredentials?: any;
            builderApiKey?: string;
            builderApiSecret?: string;
            builderApiPassphrase?: string;
            // Passed from server environment for encryption/decryption
            mongoEncryptionKey: string;
        },
        private logger: Logger
    ) {}

    async initialize(): Promise<void> {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter (EOA Mode)...`);
        
        // Initialize Wallet Service
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        
        // Rehydrate Wallet from Encrypted Key
        if (this.config.walletConfig.encryptedPrivateKey) {
             this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
             this.patchWalletForSdk(this.wallet);
        } else {
             throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }

        const provider = new JsonRpcProvider(this.config.rpcUrl);
        this.usdcContract = new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, provider);
    }

    /**
     * CRITICAL FIX: Ethers v6 removed `_signTypedData` but Polymarket SDK relies on it.
     * We re-add it as a proxy to `signTypedData`.
     */
    private patchWalletForSdk(wallet: Wallet) {
        if (!(wallet as any)._signTypedData) {
            (wallet as any)._signTypedData = async (domain: any, types: any, value: any) => {
                // Ethers v6 separates domain/types/value same as v5, just renamed method.
                // We remove EIP712Domain from types if present to avoid duplication errors in v6
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

        // 2. Derive Keys if missing
        if (!apiCreds || !apiCreds.key) {
            this.logger.info('🤝 Deriving L2 API Keys...');
            await this.deriveAndSaveKeys();
            apiCreds = this.config.l2ApiCredentials; 
        } else {
             this.logger.info('🔌 Using existing CLOB Credentials');
        }

        // 3. Initialize Client
        this.initClobClient(apiCreds);
        
        // 4. Allowance
        this.ensureAllowance().catch(e => this.logger.warn(`Allowance check deferred: ${e.message}`));
    }

    private initClobClient(apiCreds: any) {
        let builderConfig: BuilderConfig | undefined;
        if (this.config.builderApiKey) {
            builderConfig = new BuilderConfig({ 
                localBuilderCreds: {
                    key: this.config.builderApiKey,
                    secret: this.config.builderApiSecret!,
                    passphrase: this.config.builderApiPassphrase!
                }
            });
        }

        // USE STANDARD EOA (0) SIGNATURE TYPE
        // The wallet (EOA) is both the signer AND the funder.
        // CASTING TO ANY: Ethers v6 Wallet structure differs slightly from v5 expected by SDK
        this.client = new ClobClient(
            HOST_URL,
            Chain.POLYGON,
            this.wallet as any, 
            apiCreds,
            SignatureType.EOA, 
            undefined, // Funder defaults to signer address for EOA
            undefined, 
            undefined,
            builderConfig
        );
    }

    private async deriveAndSaveKeys() {
        try {
            // Handshake using standard EOA signature
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
        if(!this.wallet || !this.usdcContract) return;
        
        try {
            // Need a signer connected to the contract for write ops
            const signerContract = this.usdcContract.connect(this.wallet) as Contract;
            
            const allowance = await signerContract.allowance(this.wallet.address, POLYMARKET_EXCHANGE);
            
            if (allowance < BigInt(1000000 * 50)) { // < 50 USDC
                this.logger.info('🔓 Approving USDC (Native Gas Transaction)...');
                
                // Note: User needs MATIC (POL) in this wallet for gas!
                const tx = await signerContract.approve(POLYMARKET_EXCHANGE, MaxUint256);
                await tx.wait();
                
                this.logger.success(`✅ Approved. Tx: ${tx.hash}`);
            }
        } catch(e: any) { 
            this.logger.warn(`Allowance check failed: ${e.message}. Ensure wallet has POL for gas.`);
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
        const book = await this.client.getOrderBook(tokenId);
        return {
            bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
            asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        };
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
            
            const book = await this.client.getOrderBook(params.tokenId);
            const price = params.priceLimit || (side === Side.BUY ? Number(book.asks[0]?.price) : Number(book.bids[0]?.price));
            
            if (!price || isNaN(price)) throw new Error("Could not determine price");
            
            const rawSize = params.sizeUsd / price;
            const size = Math.floor(rawSize * 100) / 100;

            if (size <= 0) return "skipped_dust";

            const orderArgs = {
                tokenID: params.tokenId,
                price: price,
                side: side,
                size: size,
                feeRateBps: 0,
                nonce: 0 // SDK auto-fills
            };

            this.logger.info(`📝 Placing Order: ${params.side} $${params.sizeUsd.toFixed(2)} (${size} shares @ ${price})`);

            const signedOrder = await this.client.createOrder(orderArgs);
            const res = await this.client.postOrder(signedOrder, OrderType.FOK);

            if (res && res.success) {
                return res.orderID || "filled";
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
            
            // DETAILED ERROR LOGGING
            const errorMsg = error.response?.data?.error || error.message;
            this.logger.error(`Order Error: ${errorMsg}`);
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
    
    // Helper to get raw wallet address if needed
    getFunderAddress() {
        return this.config.walletConfig.address;
    }
}
