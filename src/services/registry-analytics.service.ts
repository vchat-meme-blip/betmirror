
import axios from 'axios';
import { Registry } from '../database/index.js';

interface PolyTrade {
    side: string;
    size: number;
    price: number;
    timestamp: number;
    conditionId: string; // Market ID
    outcome: string;
    asset: string;
    transactionHash: string;
}

export class RegistryAnalyticsService {
    
    /**
     * Updates stats for all wallets in the registry.
     * Should be run periodically (e.g., every 10 mins).
     */
    async updateAllRegistryStats() {
        console.log("📊 Starting Registry Analytics Update...");
        
        try {
            const wallets = await Registry.find({});
            for (const wallet of wallets) {
                // Ensure we access address correctly. The model is typed as IRegistry which extends TraderProfile.
                await this.analyzeWallet(wallet.address);
                // Rate limit politeness
                await new Promise(r => setTimeout(r, 1000)); 
            }
            console.log("✅ Registry Analytics Updated.");
        } catch (e) {
            console.error("Registry Update Failed:", e);
        }
    }

    /**
     * Fetches trades and calculates Win Rate & PnL
     */
    async analyzeWallet(address: string) {
        try {
            // 1. Fetch raw trades from Polymarket Data API
            const url = `https://data-api.polymarket.com/trades?user=${address}&limit=500`;
            const response = await axios.get<PolyTrade[]>(url);
            const trades = response.data;

            if (!trades || trades.length === 0) return;

            // 2. Calculate Metrics
            const stats = this.calculateMetrics(trades);

            // 3. Update DB
            await Registry.updateOne(
                { address: { $regex: new RegExp(`^${address}$`, "i") } },
                { 
                    winRate: stats.winRate,
                    totalPnl: stats.realizedPnl,
                    tradesLast30d: stats.count30d,
                    lastUpdated: new Date()
                }
            );
            
            console.log(`   Updated ${address.slice(0,6)}: ${stats.winRate}% Win / $${stats.realizedPnl.toFixed(0)} PnL`);

        } catch (e) {
            console.error(`Failed to analyze ${address}:`, e instanceof Error ? e.message : 'Unknown error');
        }
    }

    /**
     * Logic to determine "Winning" trades.
     * Approach: 
     * - We track "Round Trips" (Buy then Sell).
     * - If Sell Price > Avg Buy Price, it's a Win.
     */
    private calculateMetrics(trades: PolyTrade[]) {
        let profitableTrades = 0;
        let closedTrades = 0;
        let realizedPnl = 0;
        let count30d = 0;

        const thirtyDaysAgo = Date.now() / 1000 - (30 * 24 * 60 * 60);

        // Map to track Average Entry Price per Market+Outcome
        // Key: conditionId_outcome
        const positions = new Map<string, { totalCost: number, totalSize: number }>();

        // Process oldest to newest to build state
        const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);

        for (const trade of sortedTrades) {
            const key = `${trade.conditionId}_${trade.outcome}`;
            const size = Number(trade.size);
            const price = Number(trade.price);
            const value = size * price; // Note: In Polymarket API, size might be shares. Value is approx.

            if (trade.timestamp > thirtyDaysAgo) count30d++;

            if (trade.side === 'BUY') {
                const current = positions.get(key) || { totalCost: 0, totalSize: 0 };
                current.totalCost += value;
                current.totalSize += size;
                positions.set(key, current);
            } 
            else if (trade.side === 'SELL') {
                const position = positions.get(key);
                
                // Only count as a "Closed Trade" if we knew the entry
                if (position && position.totalSize > 0) {
                    const avgEntryPrice = position.totalCost / position.totalSize;
                    
                    // Did we sell higher than we bought?
                    if (price > avgEntryPrice) {
                        profitableTrades++;
                        realizedPnl += (price - avgEntryPrice) * size;
                    } else {
                        realizedPnl += (price - avgEntryPrice) * size; // Negative PnL
                    }
                    
                    closedTrades++;

                    // Reduce position size
                    position.totalSize = Math.max(0, position.totalSize - size);
                    // Adjust cost basis proportionally
                    position.totalCost = position.totalSize * avgEntryPrice; 
                    positions.set(key, position);
                }
            }
        }

        // Win Rate Calculation
        const winRate = closedTrades > 0 
            ? parseFloat(((profitableTrades / closedTrades) * 100).toFixed(1)) 
            : 0;

        return {
            winRate,
            realizedPnl: parseFloat(realizedPnl.toFixed(2)),
            count30d
        };
    }
}

export const registryAnalytics = new RegistryAnalyticsService();
