import twilio from 'twilio';
import { Logger } from '../utils/logger.util';
import { RuntimeEnv } from '../config/env';

export class NotificationService {
  private client: twilio.Twilio | null = null;
  private enabled: boolean = false;

  constructor(private env: RuntimeEnv, private logger: Logger) {
    if (env.enableNotifications && env.twilioAccountSid && env.twilioAuthToken) {
      this.client = twilio(env.twilioAccountSid, env.twilioAuthToken);
      this.enabled = true;
      this.logger.info('📱 Notification Service: ONLINE');
    } else {
      this.logger.info('📱 Notification Service: DISABLED');
    }
  }

  async sendTradeAlert(signal: { side: string; outcome: string; price: number; sizeUsd: number; marketId: string }) {
    if (!this.enabled || !this.client || !this.env.userPhoneNumber) return;

    const message = `🤖 BET MIRROR ALERT\nExecuted: ${signal.side} ${signal.outcome}\nSize: $${signal.sizeUsd.toFixed(0)}\nPrice: ${signal.price}\nMarket: ${signal.marketId.slice(0, 8)}...`;
    
    await this.sendMessage(message);
  }

  async sendCashoutAlert(amount: number, txHash: string) {
    if (!this.enabled || !this.client || !this.env.userPhoneNumber) return;

    const message = `💰 PROFIT SECURED\nAuto-Cashout: $${amount.toFixed(2)} USDC\nTx: ${txHash.slice(0, 10)}...`;
    
    await this.sendMessage(message);
  }

  private async sendMessage(body: string) {
    try {
      await this.client!.messages.create({
        body,
        from: this.env.twilioFromNumber,
        to: this.env.userPhoneNumber!,
      });
      this.logger.info('📱 Notification sent successfully.');
    } catch (error) {
      this.logger.error('Failed to send notification', error as Error);
    }
  }
}