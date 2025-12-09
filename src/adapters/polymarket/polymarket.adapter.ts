import { 
    IExchangeAdapter, 
    OrderParams
} from '../interfaces.js';
import { OrderBook } from '../../domain/market.types.js';
import { TradeSignal } from '../../domain/trade.types.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { Wallet, JsonRpcProvider, Contract, MaxUint256, formatUnits, parseUnits } from 'ethers';
import { ZeroDevService } from '../../services/zerodev.service.js';
import { ProxyWalletConfig } from '../../domain/wallet.types.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { Logger } from '../../utils/logger.util.js';
import axios, { AxiosInstance } from 'axios';
// Removed conflicting wrapper import
import { CookieJar } from 'tough-cookie';
import * as crypto from 'crypto'; 
import { HttpsProxyAgent } from 'https-proxy-agent';

// --- CONSTANTS ---
const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYMARKET_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const HOST_URL = 'https://clob.polymarket.com';
const FALLBACK_PROXY = 'http://toagonef-rotate:1t19is7izars@p.webshare.io:80';

const USDC_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
];

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
    private cookieJar: CookieJar;
    private httpsAgent: any;
    
    // Stored credentials for manual fallback
    private apiCreds?: { key: string; secret: string; passphrase: string };

    constructor(
        private config: {
            rpcUrl: string;
            walletConfig: ProxyWalletConfig;
            userId: string;
            l2ApiCredentials?: any;
            zeroDevRpc?: string;
            zeroDevPaymasterRpc?: string;
            builderApiKey?: string;
            builderApiSecret?: string;
            builderApiPassphrase?: string;
            proxyUrl?: string; 
        },
        private logger: Logger
    ) {
        this.cookieJar = new CookieJar();
    }

    async initialize(): Promise<void> {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter...`);
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
    
    private applyProxySettings() {
        const proxyUrl = this.config.proxyUrl || FALLBACK_PROXY;
        
        // Browser Emulation Headers
        const STEALTH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        
        axios.defaults.headers.common['User-Agent'] = STEALTH_UA;
        axios.defaults.headers.common['Accept'] = 'application/json, text/plain, */*';
        axios.defaults.headers.common['Accept-Language'] = 'en-US,en;q=0.9';
        axios.defaults.headers.common['Accept-Encoding'] = 'gzip, deflate, br';
        axios.defaults.headers.common['Connection'] = 'keep-alive';
        
        if (proxyUrl && proxyUrl.startsWith('http')) {
            try {
                this.httpsAgent = new HttpsProxyAgent(proxyUrl);
                
                // Set global axios defaults
                axios.defaults.httpsAgent = this.httpsAgent;
                const url = new URL(proxyUrl);
                axios.defaults.proxy = {
                    protocol: url.protocol.replace(':', ''),
                    host: url.hostname,
                    port: parseInt(url.port) || 80,
                    auth: (url.username && url.password) ? {
                        username: url.username,
                        password: url.password
                    } : undefined
                };
                
                this.logger.info(`🛡️ Proxy Configured: ${url.hostname}`);
            } catch (e) {
                this.logger.warn(`Invalid Proxy URL: ${proxyUrl}`);
            }
        }
        
        // --- MANUAL COOKIE MANAGEMENT INTERCEPTORS ---
        axios.interceptors.request.use(async (config) => {
            if (config.url && config.url.includes('polymarket.com')) {
                config.headers['User-Agent'] = STEALTH_UA;
                config.headers['Origin'] = 'https://polymarket.com';
                config.headers['Referer'] = 'https://polymarket.com/';
                
                try {
                    // Attach cookies from tough-cookie jar
                    const cookieString = await this.cookieJar.getCookieString(config.url);
                    if (cookieString) {
                        config.headers['Cookie'] = cookieString;
                    }
                } catch(e) { /* ignore cookie read error */ }
            }
            return config;
        });

        axios.interceptors.response.use(async (response) => {
            if (response.headers['set-cookie']) {
                const cookies = response.headers['set-cookie'];
                const url = response.config.url;
                if (url && Array.isArray(cookies)) {
                    for (const cookie of cookies) {
                         try {
                             await this.cookieJar.setCookie(cookie, url);
                         } catch(e) {}
                    }
                }
            }
            return response;
        }, async (error) => {
            if (error.response && error.response.headers && error.response.headers['set-cookie']) {
                const cookies = error.response.headers['set-cookie'];
                const url = error.config?.url;
                 if (url && Array.isArray(cookies)) {
                    for (const cookie of cookies) {
                         try {
                             await this.cookieJar.setCookie(cookie, url);
                         } catch(e) {}
                    }
                }
            }
            return Promise.reject(error);
        });
    }

    private async warmUpCookies() {
        try {
            this.logger.info("🍪 Warming up cookies via Proxy...");
            await axios.get('https://polymarket.com/', {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none'
                }
            });
            this.logger.info("✅ Cookies secured.");
        } catch (e) {
             if (e instanceof Error && e.message.includes('403')) {
                  this.logger.info("✅ Cookies captured (from 403 challenge).");
             } else {
                  this.logger.warn("Cookie warm-up response: " + (e as Error).message);
             }
        }
    }
    
    private patchClient(client: any) {
        try {
            if (client.axiosInstance) {
                 client.axiosInstance.defaults.httpsAgent = this.httpsAgent;
                 client.axiosInstance.defaults.proxy = axios.defaults.proxy;
                 client.axiosInstance.defaults.headers['User-Agent'] = axios.defaults.headers.common['User-Agent'];
            }
            if (client.httpClient) {
                 client.httpClient.defaults.httpsAgent = this.httpsAgent;
                 client.httpClient.defaults.proxy = axios.defaults.proxy;
                 client.httpClient.defaults.headers['User-Agent'] = axios.defaults.headers.common['User-Agent'];
            }
        } catch(e) {
            console.warn("Failed to patch ClobClient internals");
        }
    }

    async authenticate(): Promise<void> {
        this.applyProxySettings();
        await this.warmUpCookies();

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
            
            this.patchClient(tempClient);

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
        
        this.apiCreds = apiCreds; 

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

        this.client = new ClobClient(
            HOST_URL,
            Chain.POLYGON,
            this.signerImpl,
            apiCreds,
            SignatureType.EOA,
            this.funderAddress,
            undefined, 
            undefined,
            builderConfig
        );
        
        this.patchClient(this.client);
        
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
        
        // MANUAL AXIOS FALLBACK for Orderbook to avoid UA leak in SDK
        // The SDK's getOrderBook might be simple enough to replicate
        try {
             const res = await axios.get(`${HOST_URL}/book`, { 
                 params: { token_id: tokenId } 
             });
             return {
                 bids: res.data.bids.map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
                 asks: res.data.asks.map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
             };
        } catch(e) {
             // Fallback to SDK if manual fails, though manual is preferred for proxy
             const book = await this.client.getOrderBook(tokenId);
             return {
                bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
                asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
             };
        }
    }

    async fetchPublicTrades(address: string, limit: number = 20): Promise<TradeSignal[]> {
        try {
            const url = `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`;
            // Uses global axios with proxy/cookies
            const res = await axios.get<PolyActivityResponse[]>(url);
            
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
    
    private signL2Request(method: string, path: string, body: any): any {
        if (!this.apiCreds) throw new Error("No API Credentials for manual signing");
        
        const timestamp = Math.floor(Date.now() / 1000);
        const sigString = `${timestamp}${method}${path}${JSON.stringify(body)}`;
        
        const hmac = crypto.createHmac('sha256', this.apiCreds.secret);
        const signature = hmac.update(sigString).digest('base64');
        
        return {
            'POLY_API_KEY': this.apiCreds.key,
            'POLY_TIMESTAMP': timestamp.toString(),
            'POLY_SIGNATURE': signature,
            'POLY_PASSPHRASE': this.apiCreds.passphrase,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
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
            // Use our manual getOrderBook to avoid UA leak
            const currentOrderBook = await this.getOrderBook(params.tokenId);
            const currentLevels = isBuy ? currentOrderBook.asks : currentOrderBook.bids;

            if (!currentLevels || currentLevels.length === 0) {
                 if (retryCount === 0) throw new Error("No liquidity in orderbook");
                 break; 
            }

            const level = currentLevels[0];
            const levelPrice = level.price;

            if (isBuy && params.priceLimit && levelPrice > params.priceLimit) break;
            if (!isBuy && params.priceLimit && levelPrice < params.priceLimit) break;

            let orderSize: number;
            let orderValue: number;

            if (isBuy) {
                const levelValue = level.size * levelPrice;
                orderValue = Math.min(remaining, levelValue);
                orderSize = orderValue / levelPrice;
            } else {
                const levelValue = level.size * levelPrice;
                orderValue = Math.min(remaining, levelValue);
                orderSize = orderValue / levelPrice;
            }

            orderSize = Math.floor(orderSize * 100) / 100;

            if (orderSize <= 0) break;

            const orderArgs = {
                side: orderSide,
                tokenID: params.tokenId,
                amount: orderSize,
                price: levelPrice,
            };

            try {
                // 1. Sign Order using SDK (Local Operation)
                const signedOrder = await this.client.createMarketOrder(orderArgs);
                
                let response: any;
                
                try {
                    // 2. Try Standard SDK Post (Now patched to use cookies/proxy)
                    response = await this.client.postOrder(signedOrder, OrderType.FOK);
                } catch(postError: any) {
                    // 3. Fallback: Manual HTTP POST
                    if ((postError.message.includes("403") || postError.message.includes("Forbidden") || postError.message.includes("502")) && this.apiCreds) {
                        this.logger.warn("⚠️ SDK Network Error. Attempting Manual Fallback...");
                        
                        const body = {
                            order: signedOrder,
                            owner: this.apiCreds.key, 
                            orderType: OrderType.FOK
                        };
                        
                        const headers = this.signL2Request('POST', '/order', body);
                        
                        // Use global axios (patched with interceptors for cookies/proxy)
                        const manualRes = await axios.post(`${HOST_URL}/order`, body, { headers });
                        response = manualRes.data;
                        this.logger.success("✅ Manual Fallback Succeeded.");
                    } else {
                        throw postError;
                    }
                }

                if (response.success || response.orderID) {
                    remaining -= orderValue;
                    retryCount = 0;
                    lastOrderId = response.orderID || response.transactionHash;
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
            
            // Random Jitter (2s - 4.5s)
            const jitter = Math.floor(Math.random() * 2500) + 2000;
            await new Promise(r => setTimeout(r, jitter));
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