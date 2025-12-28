import { PortfolioSnapshotModel } from '../database/portfolio.schema.js';
export class PortfolioService {
    logger;
    snapshotInterval = null;
    SNAPSHOT_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    constructor(logger) {
        this.logger = logger;
    }
    // Start regular portfolio snapshots
    startSnapshotService(userId, getPortfolioData) {
        // Stop existing interval if any
        this.stopSnapshotService();
        // Create initial snapshot
        this.createSnapshot(userId, getPortfolioData);
        // Set up regular snapshots
        this.snapshotInterval = setInterval(async () => {
            try {
                await this.createSnapshot(userId, getPortfolioData);
                this.logger.info(`[Portfolio] Snapshot created for ${userId}`);
            }
            catch (error) {
                this.logger.error(`[Portfolio] Failed to create snapshot: ${error.message}`);
            }
        }, this.SNAPSHOT_INTERVAL);
        this.logger.info(`[Portfolio] Snapshot service started (every 6 hours)`);
    }
    // Stop regular snapshots
    stopSnapshotService() {
        if (this.snapshotInterval) {
            clearInterval(this.snapshotInterval);
            this.snapshotInterval = null;
            this.logger.info(`[Portfolio] Snapshot service stopped`);
        }
    }
    // Create a portfolio snapshot
    async createSnapshot(userId, getPortfolioData) {
        try {
            const portfolioData = await getPortfolioData();
            // Calculate positions breakdown
            const positionsBreakdown = portfolioData.positions.map(pos => ({
                marketId: pos.marketId,
                outcome: pos.outcome,
                shares: pos.shares,
                entryPrice: pos.entryPrice,
                currentPrice: pos.currentPrice || pos.entryPrice,
                value: pos.shares * (pos.currentPrice || pos.entryPrice),
                pnl: pos.unrealizedPnL || 0
            }));
            // Calculate starting value for P&L percentage
            const investedValue = portfolioData.positions.reduce((sum, pos) => sum + (pos.shares * pos.entryPrice), 0);
            const totalPnLPercent = investedValue > 0 ? (portfolioData.totalPnL / investedValue) * 100 : 0;
            await PortfolioSnapshotModel.createSnapshot(userId, portfolioData.totalValue, portfolioData.cashBalance, portfolioData.positions.reduce((sum, pos) => sum + (pos.shares * (pos.currentPrice || pos.entryPrice)), 0), portfolioData.positions.length, portfolioData.totalPnL, totalPnLPercent, positionsBreakdown);
            this.logger.debug(`[Portfolio] Snapshot created: $${portfolioData.totalValue.toFixed(2)}`);
        }
        catch (error) {
            this.logger.error(`[Portfolio] Failed to create snapshot: ${error.message}`);
            throw error;
        }
    }
    // Get portfolio analytics for a specific period
    async getAnalytics(userId, period) {
        try {
            const analytics = await PortfolioSnapshotModel.getAnalytics(userId, period);
            return analytics;
        }
        catch (error) {
            this.logger.error(`[Portfolio] Failed to get analytics: ${error.message}`);
            throw error;
        }
    }
    // Get raw snapshots for chart rendering
    async getSnapshots(userId, period) {
        try {
            const now = new Date();
            let startDate;
            switch (period) {
                case '1D':
                    startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    break;
                case '1W':
                    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    break;
                case '30D':
                    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    break;
                case 'ALL':
                default:
                    startDate = new Date(0);
                    break;
            }
            // Fix for Error at line 142: Using lean() and mapping _id to id ensures objects match the PortfolioSnapshot interface
            const snapshots = await PortfolioSnapshotModel.find({
                userId,
                timestamp: { $gte: startDate }
            }).sort({ timestamp: 1 }).lean();
            return snapshots.map((s) => ({
                ...s,
                id: s._id.toString()
            }));
        }
        catch (error) {
            this.logger.error(`[Portfolio] Failed to get snapshots: ${error.message}`);
            throw error;
        }
    }
    // Create snapshot on trade completion
    async createTradeSnapshot(userId, portfolioData) {
        try {
            await this.createSnapshot(userId, async () => portfolioData);
            this.logger.info(`[Portfolio] Trade snapshot created for ${userId}`);
        }
        catch (error) {
            this.logger.error(`[Portfolio] Failed to create trade snapshot: ${error.message}`);
            // Don't throw - trade shouldn't fail if snapshot fails
        }
    }
    // Cleanup old snapshots
    async cleanupOldSnapshots() {
        try {
            const result = await PortfolioSnapshotModel.cleanupOldSnapshots();
            if (result.deletedCount > 0) {
                this.logger.info(`[Portfolio] Cleaned up ${result.deletedCount} old snapshots`);
            }
        }
        catch (error) {
            this.logger.error(`[Portfolio] Failed to cleanup snapshots: ${error.message}`);
        }
    }
    // Get latest snapshot
    async getLatestSnapshot(userId) {
        try {
            // Fix for Error at line 186: Using lean() and mapping _id to id ensures returned object matches the PortfolioSnapshot interface
            const snapshot = await PortfolioSnapshotModel
                .findOne({ userId })
                .sort({ timestamp: -1 })
                .lean();
            if (!snapshot)
                return null;
            return {
                ...snapshot,
                id: snapshot._id.toString()
            };
        }
        catch (error) {
            this.logger.error(`[Portfolio] Failed to get latest snapshot: ${error.message}`);
            throw error;
        }
    }
}
