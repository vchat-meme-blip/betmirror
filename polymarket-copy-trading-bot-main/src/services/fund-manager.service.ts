import { Wallet, Contract, formatUnits, parseUnits } from 'ethers';
import { Logger } from '../utils/logger.util';
import { RuntimeEnv } from '../config/env';
import { NotificationService } from './notification.service';

const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(addressto, uint256 amount) returns (bool)',
];

export class FundManagerService {
  private usdcContract: Contract;

  constructor(
    private wallet: Wallet,
    private env: RuntimeEnv,
    private logger: Logger,
    private notifier: NotificationService
  ) {
    this.usdcContract = new Contract(env.usdcContractAddress, USDC_ABI, wallet);
  }

  async checkAndSweepProfits(): Promise<void> {
    if (!this.env.enableAutoCashout || !this.env.mainWalletAddress || !this.env.maxRetentionAmount) {
      return;
    }

    try {
      const balanceBigInt = await this.usdcContract.balanceOf(this.wallet.address);
      const balance = parseFloat(formatUnits(balanceBigInt, 6));

      this.logger.info(`🏦 Fund Check: Balance $${balance.toFixed(2)} / Retention Cap $${this.env.maxRetentionAmount}`);

      if (balance > this.env.maxRetentionAmount) {
        const sweepAmount = balance - this.env.maxRetentionAmount;
        
        // Safety check: Don't sweep tiny dust (e.g. < $10) to save gas relevance
        if (sweepAmount < 10) return;

        this.logger.info(`💸 Sweeping excess funds: $${sweepAmount.toFixed(2)} -> ${this.env.mainWalletAddress}`);

        const amountInUnits = parseUnits(sweepAmount.toFixed(6), 6);
        
        const tx = await this.usdcContract.transfer(this.env.mainWalletAddress, amountInUnits);
        this.logger.info(`⏳ Cashout Tx Sent: ${tx.hash}`);
        
        await tx.wait();
        this.logger.info(`✅ Cashout Confirmed: ${tx.hash}`);

        await this.notifier.sendCashoutAlert(sweepAmount, tx.hash);
      }
    } catch (error) {
      this.logger.error('Fund Manager failed to sweep', error as Error);
    }
  }
}