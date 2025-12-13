export class FundManagerService {
    adapter;
    funderAddress;
    config;
    logger;
    notifier;
    // OPTIMIZATION: Throttle balance checks to avoid RPC Limits
    lastCheckTime = 0;
    THROTTLE_MS = 60 * 60 * 1000; // Check max once per hour unless forced
    constructor(adapter, funderAddress, config, logger, notifier) {
        this.adapter = adapter;
        this.funderAddress = funderAddress;
        this.config = config;
        this.logger = logger;
        this.notifier = notifier;
    }
    async checkAndSweepProfits(force = false) {
        if (!this.config.enabled || !this.config.destinationAddress || !this.config.maxRetentionAmount) {
            return null;
        }
        // THROTTLING CHECK: Avoid hitting RPC limits with frequent balance checks
        // If not forced (manual trigger), enforce 1 hour delay between checks
        if (!force && Date.now() - this.lastCheckTime < this.THROTTLE_MS) {
            return null;
        }
        this.lastCheckTime = Date.now();
        try {
            // Use Adapter to fetch balance
            const balance = await this.adapter.fetchBalance(this.funderAddress);
            this.logger.info(`🏦 Vault Check: Proxy Balance $${balance.toFixed(2)} (Cap: $${this.config.maxRetentionAmount})`);
            if (balance > this.config.maxRetentionAmount) {
                const sweepAmount = balance - this.config.maxRetentionAmount;
                // Safety check: Don't sweep tiny dust (e.g. < $10) to save gas/spam
                if (sweepAmount < 10)
                    return null;
                this.logger.info(`💸 Sweeping excess funds: $${sweepAmount.toFixed(2)} -> ${this.config.destinationAddress}`);
                // Use Adapter to execute cashout
                const txHash = await this.adapter.cashout(sweepAmount, this.config.destinationAddress);
                this.logger.info(`✅ Cashout Tx: ${txHash}`);
                await this.notifier.sendCashoutAlert(sweepAmount, txHash);
                return {
                    id: txHash,
                    amount: sweepAmount,
                    txHash: txHash,
                    destination: this.config.destinationAddress,
                    timestamp: new Date().toISOString()
                };
            }
        }
        catch (error) {
            this.logger.error('Fund Manager failed to sweep', error);
        }
        return null;
    }
}
