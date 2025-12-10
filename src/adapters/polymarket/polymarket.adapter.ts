import { 
    IExchangeAdapter, 
    OrderParams
} from '../interfaces.js';
import { OrderBook } from '../../domain/market.types.js';
import { TradeSignal } from '../../domain/trade.types.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { Wallet, JsonRpcProvider, Contract, MaxUint256, formatUnits, parseUnits } from 'ethers';
import { ZeroDevService } from '../../services/zerodev.service.js';
import { ProxyWalletConfig, L2ApiCredentials } from '../../domain/wallet.types.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { Logger } from '../../utils/logger.util.js';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

// --- CONSTANTS ---
const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYMARKET_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const HOST_URL = 'https://clob.polymarket.com';

// DEDICATED STATIC RESIDENTIAL PROXY (WebShare)
// Format: http://user:pass@ip:port
const PROXY_URL = 'http://toagonef:1t19is7izars@142.111.48.253:7030';

const USDC_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
];

// Adapter to make Ethers v6 Wallet compatible with ClobClient requirements
class EthersV6Adapter extends Wallet {
    async _signTypedData(domain: any, types: any, value: any): Promise<string> {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { EIP712Domain, ...cleanTypes } = types;
        if (domain.chainId) domain.chainId = Number(domain.chainId);
        return this.signTypedData(domain, cleanTypes, value);
    }
}

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
    private signerImpl?: any;
    private funderAddress?: string | undefined; 
    private zdService?: ZeroDevService;
    private usdcContract?: Contract;
    
    constructor(
        private config: {
            rpcUrl: string;
            walletConfig: ProxyWalletConfig;
            userId: string;
            l2ApiCredentials?: L2ApiCredentials;
            zeroDevRpc?: string;
            zeroDevPaymasterRpc?: string;
            builderApiKey?: string;
            builderApiSecret?: string;
            builderApiPassphrase?: string;
        },
        private logger: Logger
    ) {}

    async initialize(): Promise<void> {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter (Dedicated Proxy Mode)...`);
        const provider = new JsonRpcProvider(this.config.rpcUrl);
        
        if (this.config.walletConfig.type === 'SMART_ACCOUNT') {
             if (!this.config.zeroDevRpc) throw new Error("Missing ZeroDev RPC");
             this.zdService = new ZeroDevService(
                 this.config.zeroDevRpc, 
                 this.config.zeroDevPaymasterRpc
             );
             this.funderAddress = this.config.walletConfig.address;
             if (!this.config.walletConfig.sessionPrivateKey) {
                 throw new Error("Missing Session Private Key for Auth");
             }
             this.signerImpl = new EthersV6Adapter(this.config.walletConfig.sessionPrivateKey, provider);
        } else {
             throw new Error("Only Smart Accounts supported in this adapter version.");
        }

        this.usdcContract = new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, this.signerImpl);
    }

    async validatePermissions(): Promise<boolean> {
        if (this.zdService && this.funderAddress) {
            try {
                this.logger.info('🔄 Verifying Smart Account Deployment...');
                await this.zdService.sendTransaction(
                    this.config.walletConfig.serializedSessionKey,
                    USDC_BRIDGED_POLYGON,
                    USDC_ABI,
                    'approve',
                    [this.funderAddress, 0]
                );
                this.logger.success('✅ Smart Account Ready.');
                return true;
            } catch (e: any) {
                this.logger.error(`Deployment Failed: ${e.message}`);
                throw new Error("Smart Account deployment failed. Check funds or network.");
            }
        }
        return true;
    }

    private base64UrlToBase64(base64Url: string): string {
        return base64Url.replace(/-/g, '+').replace(/_/g, '/');
    }
    
    // Inject Dedicated Proxy Agent into Client
    private applyProxy(client: ClobClient) {
        try {
            const agent = new HttpsProxyAgent(PROXY_URL);
            
            // Try to patch known internal axios locations
            if ((client as any).axiosInstance) {
                (client as any).axiosInstance.defaults.httpsAgent = agent;
                (client as any).axiosInstance.defaults.proxy = false; 
            }
            
            if ((client as any).httpClient) {
                 (client as any).httpClient.defaults.httpsAgent = agent;
                 (client as any).httpClient.defaults.proxy = false;
            }
            
            this.logger.info("🛡️ Dedicated Proxy Injected");
        } catch (e) {
            this.logger.warn("Failed to inject proxy into SDK");
        }
    }

    async authenticate(): Promise<void> {
        let apiCreds = this.config.l2ApiCredentials;

        if (!apiCreds || !apiCreds.key) {
            this.logger.info('🤝 Performing L2 Handshake...');
            
            const tempClient = new ClobClient(
                HOST_URL,
                Chain.POLYGON,
                this.signerImpl,
                undefined,
                SignatureType.EOA,
                this.funderAddress
            );
            
            this.applyProxy(tempClient);

            try {
                const rawCreds = await tempClient.createOrDeriveApiKey();
                if (!rawCreds || !rawCreds.key) {
                    throw new Error("Handshake returned empty keys");
                }

                apiCreds = {
                    key: rawCreds.key,
                    secret: rawCreds.secret,
                    passphrase: rawCreds.passphrase
                };

                await User.findOneAndUpdate(
                    { address: this.config.userId },
                    { "proxyWallet.l2ApiCredentials": apiCreds }
                );
                this.logger.success('✅ Authenticated & Keys Saved.');
                
            } catch (e: any) {
                this.logger.error(`Auth Failed: ${e.message}`);
                throw e;
            }
        } else {
             this.logger.info('🔌 Connecting to CLOB...');
        }

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
        
        const normalizedCreds = {
            ...apiCreds,
            secret: this.base64UrlToBase64(apiCreds.secret)
        };

        this.client = new ClobClient(
            HOST_URL,
            Chain.POLYGON,
            this.signerImpl,
            normalizedCreds,
            SignatureType.EOA,
            this.funderAddress,
            undefined, 
            undefined,
            builderConfig
        );
        
        this.applyProxy(this.client);
        
        await this.ensureAllowance();
    }

    private async ensureAllowance() {
        if(!this.usdcContract || !this.funderAddress) return;
        try {
            const publicProvider = new JsonRpcProvider("https://polygon-rpc.com");
            const readContract = new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, publicProvider);
            const allowance = await readContract.allowance(this.funderAddress, POLYMARKET_EXCHANGE);
            
            this.logger.info(`🔍 Allowance Check: ${formatUnits(allowance, 6)} USDC Approved for Exchange`);

            if (allowance < BigInt(1000000 * 1000)) {
                this.logger.info('🔓 Approving USDC for CTF Exchange...');
                
                if (this.zdService) {
                    const txHash = await this.zdService.sendTransaction(
                        this.config.walletConfig.serializedSessionKey,
                        USDC_BRIDGED_POLYGON,
                        USDC_ABI,
                        'approve',
                        [POLYMARKET_EXCHANGE, MaxUint256]
                    );
                    this.logger.success(`✅ Approved. Tx: ${txHash}`);
                }
            } else {
                 this.logger.info('✅ Allowance Sufficient.');
            }
        } catch(e: any) { 
            this.logger.error(`Allowance Check Failed: ${e.message}`);
            throw new Error(`Failed to approve USDC. Bot cannot trade. Error: ${e.message}`);
        }
    }

    async fetchBalance(address: string): Promise<number> {
        if (!this.usdcContract) return 0;
        try {
            const balanceBigInt = await this.usdcContract.balanceOf(address);
            return parseFloat(formatUnits(balanceBigInt, 6));
        } catch (e) {
            return 0;
        }
    }

    async getMarketPrice(marketId: string, tokenId: string): Promise<number> {
        if (!this.client) return 0;
        try {
            const mid = await this.client.getMidpoint(tokenId);
            return parseFloat(mid.mid);
        } catch (e) {
            return 0;
        }
    }

    async getOrderBook(tokenId: string): Promise<OrderBook> {
        if (!this.client) throw new Error("Client not authenticated");
        // Ensure proxy is used
        const book = await this.client.getOrderBook(tokenId);
        return {
            bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
            asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        };
    }

    async fetchPublicTrades(address: string, limit: number = 20): Promise<TradeSignal[]> {
        try {
            const url = `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`;
            // Use dedicated proxy
            const agent = new HttpsProxyAgent(PROXY_URL);
            const res = await axios.get<PolyActivityResponse[]>(url, {
                httpsAgent: agent,
                proxy: false
            });
            
            if (!res.data || !Array.isArray(res.data)) return [];

            const trades: TradeSignal[] = [];
            for (const act of res.data) {
                if (act.type === 'TRADE' || act.type === 'ORDER_FILLED') {
                     const activityTime = typeof act.timestamp === 'number' ? act.timestamp : Math.floor(new Date(act.timestamp).getTime() / 1000);
                     
                     trades.push({
                         trader: address,
                         marketId: act.conditionId,
                         tokenId: act.asset,
                         outcome: act.outcomeIndex === 0 ? 'YES' : 'NO',
                         side: act.side.toUpperCase() as 'BUY' | 'SELL',
                         sizeUsd: act.usdcSize || (act.size * act.price),
                         price: act.price,
                         timestamp: activityTime * 1000,
                     });
                }
            }
            return trades;
        } catch (e) {
            return [];
        }
    }

    async createOrder(params: OrderParams): Promise<string> {
        if (!this.client) throw new Error("Client not authenticated");
        
        const isBuy = params.side === 'BUY';
        const orderSide = isBuy ? Side.BUY : Side.SELL;

        let remaining = params.sizeUsd;
        let retryCount = 0;
        const maxRetries = 3;
        let lastOrderId = "";

        while (remaining >= 0.50 && retryCount < maxRetries) { 
            try {
                const currentOrderBook = await this.client.getOrderBook(params.tokenId);
                const currentLevels = isBuy ? currentOrderBook.asks : currentOrderBook.bids;

                if (!currentLevels || currentLevels.length === 0) {
                     if (retryCount === 0) throw new Error("No liquidity in orderbook");
                     break; 
                }

                const level = currentLevels[0];
                const levelPrice = parseFloat(level.price);

                if (isBuy && params.priceLimit && levelPrice > params.priceLimit) break;
                if (!isBuy && params.priceLimit && levelPrice < params.priceLimit) break;

                let orderSize: number;
                let orderValue: number;

                if (isBuy) {
                    const levelValue = parseFloat(level.size) * levelPrice;
                    orderValue = Math.min(remaining, levelValue);
                    orderSize = orderValue / levelPrice;
                } else {
                    const levelValue = parseFloat(level.size) * levelPrice;
                    orderValue = Math.min(remaining, levelValue);
                    orderSize = orderValue / levelPrice;
                }

                orderSize = Math.floor(orderSize * 100) / 100;

                if (orderSize <= 0) break;

                const orderArgs: any = {
                    tokenID: params.tokenId,
                    side: orderSide,
                    price: levelPrice,
                    size: orderSize, 
                    feeRateBps: 0,
                    orderType: OrderType.FOK 
                };

                const response = await this.client.createAndPostOrder(orderArgs);

                if (response.success && response.orderID) {
                    remaining -= orderValue;
                    retryCount = 0;
                    lastOrderId = response.orderID;
                } else {
                    const errMsg = response.errorMsg || 'Unknown Relayer Error';
                    this.logger.error(`❌ Exchange Rejection: ${errMsg}`);
                    
                    if (errMsg.toLowerCase().includes("proxy") || errMsg.toLowerCase().includes("allowance")) {
                         this.logger.warn("Triggering emergency allowance check...");
                         await this.ensureAllowance();
                    }
                    retryCount++;
                }
            } catch (error: any) {
                this.logger.error(`Order attempt error: ${error.message}`);
                retryCount++;
            }
            
            await new Promise(r => setTimeout(r, 1000));
        }
        
        return lastOrderId || "failed";
    }

    async cancelOrder(orderId: string): Promise<boolean> {
        if (!this.client) return false;
        try {
            await this.client.cancelOrder({ orderID: orderId });
            return true;
        } catch (e) {
            return false;
        }
    }

    async cashout(amount: number, destination: string): Promise<string> {
        if (!this.zdService || !this.funderAddress) {
            throw new Error("Smart Account service not initialized");
        }
        
        this.logger.info(`💸 Adapters initiating cashout of $${amount} to ${destination}`);
        const amountUnits = parseUnits(amount.toFixed(6), 6);
        const txHash = await this.zdService.sendTransaction(
            this.config.walletConfig.serializedSessionKey,
            USDC_BRIDGED_POLYGON,
            USDC_ABI,
            'transfer',
            [destination, amountUnits]
        );
        return txHash;
    }
    
    public getRawClient() { return this.client; }
    public getSigner() { return this.signerImpl; }
    public getFunderAddress() { return this.funderAddress; }
}