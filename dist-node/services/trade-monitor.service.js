import axios from 'axios';
const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
};
export class TradeMonitorService {
    deps;
    isPolling = false;
    pollInterval;
    targetWallets = new Set();
    processedHashes = new Map();
    constructor(deps) {
        this.deps = deps;
        this.updateTargets(deps.userAddresses);
    }
    updateTargets(newTargets) {
        this.deps.userAddresses = newTargets;
        this.targetWallets = new Set(newTargets.map(t => t.toLowerCase()));
        this.deps.logger.info(`🎯 Monitor target list updated to ${this.targetWallets.size} wallets.`);
    }
    async start(startCursor) {
        if (this.isPolling)
            return;
        this.isPolling = true;
        this.deps.logger.info(`🔌 Starting High-Frequency Polling (Data API)...`);
        await this.poll();
        this.pollInterval = setInterval(() => this.poll(), 2000);
    }
    stop() {
        this.isPolling = false;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = undefined;
        }
        this.deps.logger.info('Cb Monitor Stopped.');
    }
    async poll() {
        if (this.targetWallets.size === 0)
            return;
        const targets = Array.from(this.targetWallets);
        for (const user of targets) {
            await this.checkUserActivity(user);
            if (targets.length > 5)
                await new Promise(r => setTimeout(r, 100));
        }
        this.pruneCache();
    }
    async checkUserActivity(user) {
        try {
            const url = `https://data-api.polymarket.com/activity?user=${user}&limit=5`;
            // Added User-Agent header
            const res = await axios.get(url, {
                timeout: 3000,
                headers: HTTP_HEADERS
            });
            if (!res.data || !Array.isArray(res.data))
                return;
            const trades = res.data.filter(a => a.type === 'TRADE' || a.type === 'ORDER_FILLED');
            trades.sort((a, b) => a.timestamp - b.timestamp);
            for (const trade of trades) {
                await this.processTrade(user, trade);
            }
        }
        catch (e) {
            // Silent fail
        }
    }
    async processTrade(user, activity) {
        const txHash = activity.transactionHash;
        if (this.processedHashes.has(txHash))
            return;
        const now = Date.now();
        const tradeTime = activity.timestamp > 10000000000 ? activity.timestamp : activity.timestamp * 1000;
        if (now - tradeTime > 5 * 60 * 1000) {
            this.processedHashes.set(txHash, now);
            return;
        }
        this.processedHashes.set(txHash, now);
        const outcomeLabel = activity.outcomeIndex === 0 ? "YES" : "NO";
        const side = activity.side.toUpperCase();
        const sizeUsd = activity.usdcSize || (activity.size * activity.price);
        this.deps.logger.info(`🚨 [SIGNAL] ${user.slice(0, 6)}... ${side} ${outcomeLabel} @ ${activity.price} ($${sizeUsd.toFixed(2)})`);
        const signal = {
            trader: user,
            marketId: activity.conditionId,
            tokenId: activity.asset,
            outcome: outcomeLabel,
            side: side,
            sizeUsd: sizeUsd,
            price: activity.price,
            timestamp: tradeTime
        };
        this.deps.onDetectedTrade(signal).catch(err => {
            this.deps.logger.error(`Execution Trigger Failed`, err);
        });
    }
    pruneCache() {
        const now = Date.now();
        const TTL = 10 * 60 * 1000;
        if (this.processedHashes.size > 2000) {
            for (const [key, ts] of this.processedHashes.entries()) {
                if (now - ts > TTL) {
                    this.processedHashes.delete(key);
                }
            }
        }
    }
}
