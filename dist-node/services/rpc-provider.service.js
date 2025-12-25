import { JsonRpcProvider } from 'ethers';
import { loadEnv } from '../config/env.js';
class RpcProviderService {
    static instance = null;
    static lastRequestTime = 0;
    static requestCount = 0;
    static RATE_LIMIT_MS = 100; // 100ms between requests
    static MAX_REQUESTS_PER_SECOND = 10;
    static getProvider() {
        if (!this.instance) {
            // Use QuickNode first, fallback to polygon-rpc.com
            const rpcUrl = loadEnv().quicknodeRpcUrl || loadEnv().rpcUrl;
            console.log(`🔗 Using RPC: ${rpcUrl}`);
            this.instance = new JsonRpcProvider(rpcUrl);
        }
        return this.instance;
    }
    static async rateLimitedCall(call) {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        // Rate limiting: wait if we're making too many requests
        if (timeSinceLastRequest < this.RATE_LIMIT_MS && this.requestCount >= this.MAX_REQUESTS_PER_SECOND) {
            const waitTime = this.RATE_LIMIT_MS - timeSinceLastRequest;
            console.log(`⏳ Rate limiting: waiting ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.lastRequestTime = Date.now();
        this.requestCount++;
        // Reset counter after 1 second
        setTimeout(() => {
            this.requestCount = Math.max(0, this.requestCount - 1);
        }, 1000);
        return call();
    }
    static async getBalance(address) {
        return this.rateLimitedCall(async () => {
            const provider = this.getProvider();
            return provider.getBalance(address);
        });
    }
    static async call(contract, data) {
        return this.rateLimitedCall(async () => {
            const provider = this.getProvider();
            return provider.call({ to: contract, data });
        });
    }
}
export { RpcProviderService };
