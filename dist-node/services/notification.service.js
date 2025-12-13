/**
 * Browser-Compatible Notification Service
 * Replaces 'twilio' Node SDK with direct fetch calls to prevent Vite build errors.
 */
export class NotificationService {
    env;
    logger;
    enabled = false;
    constructor(env, logger) {
        this.env = env;
        this.logger = logger;
        if (env.enableNotifications && env.twilioAccountSid && env.twilioAuthToken && env.userPhoneNumber) {
            this.enabled = true;
            this.logger.info('📱 Notification Service: ONLINE (Browser Mode)');
        }
        else {
            this.logger.info('📱 Notification Service: DISABLED');
        }
    }
    async sendTradeAlert(signal) {
        if (!this.enabled)
            return;
        const message = `🤖 BET MIRROR ALERT\nExecuted: ${signal.side} ${signal.outcome}\nSize: $${signal.sizeUsd.toFixed(0)}\nPrice: ${signal.price}\nMarket: ${signal.marketId.slice(0, 8)}...`;
        await this.sendMessage(message);
    }
    async sendCashoutAlert(amount, txHash) {
        if (!this.enabled)
            return;
        const message = `💰 PROFIT SECURED\nAuto-Cashout: $${amount.toFixed(2)} USDC\nTx: ${txHash.slice(0, 10)}...`;
        await this.sendMessage(message);
    }
    async sendMessage(body) {
        try {
            // Direct Twilio API Call (Browser Compatible)
            // Note: This exposes the Auth Token in the network tab if inspected, but this is a user-controlled client terminal.
            const url = `https://api.twilio.com/2010-04-01/Accounts/${this.env.twilioAccountSid}/Messages.json`;
            const formData = new URLSearchParams();
            formData.append('To', this.env.userPhoneNumber);
            formData.append('From', this.env.twilioFromNumber);
            formData.append('Body', body);
            const auth = btoa(`${this.env.twilioAccountSid}:${this.env.twilioAuthToken}`);
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: formData
            });
            if (!response.ok) {
                throw new Error(`Twilio API Error: ${response.statusText}`);
            }
            this.logger.info('📱 SMS Notification Sent');
        }
        catch (error) {
            // In browser, CORS might block this if not configured on Twilio side, 
            // but we log it to UI so user knows we tried.
            this.logger.warn(`Failed to send SMS (Network/CORS): ${error.message}`);
        }
    }
}
