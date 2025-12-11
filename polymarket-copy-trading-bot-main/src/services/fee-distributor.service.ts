import { Wallet, Contract, parseUnits } from 'ethers';
import { Logger } from '../utils/logger.util';
import { RuntimeEnv } from '../config/env';
import { FeeDistributionEvent } from '../domain/alpha.types';
import { alphaRegistry } from './alpha-registry.service';

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
];

export class FeeDistributorService {
  private usdcContract: Contract;

  constructor(
    private wallet: Wallet,
    private env: RuntimeEnv,
    private logger: Logger
  ) {
    this.usdcContract = new Contract(env.usdcContractAddress, USDC_ABI, wallet);
    // Ensure the registry client knows where to look (if env var is set)
    if(env.registryApiUrl) {
        alphaRegistry.setApiUrl(env.registryApiUrl);
    }
  }

  /**
   * Real Implementation:
   * 1. Check registry to see who listed the trader we just profited from.
   * 2. Send them 1%.
   * 3. Send Admin 1%.
   */
  async distributeFeesOnProfit(
    tradeId: string,
    netProfitUsdc: number,
    traderAddressWeCopied: string
  ): Promise<FeeDistributionEvent | null> {
    if (netProfitUsdc <= 0) return null;

    // --- 1. Real Lookup ---
    const listerAddress = await alphaRegistry.getListerForWallet(traderAddressWeCopied);

    if (!listerAddress) {
        this.logger.info(`No lister found for ${traderAddressWeCopied}. Keeping fee in wallet (or burning).`);
        return null;
    }

    // 1% Fee Calculation
    const feePercentage = 0.01;
    const listerShare = netProfitUsdc * feePercentage;
    const platformShare = netProfitUsdc * feePercentage;
    
    if (listerShare < 0.01) return null; // Dust protection

    this.logger.info(`💸 Distributing Fees: Profit $${netProfitUsdc} -> Lister (${listerAddress.slice(0,6)}): $${listerShare.toFixed(2)}`);

    try {
      // --- 2. Real Transfer ---
      
      // Send to Lister
      const listerTx = await this.usdcContract.transfer(
        listerAddress, 
        parseUnits(listerShare.toFixed(6), 6)
      );
      
      // Send to Admin
      const adminTx = await this.usdcContract.transfer(
        this.env.adminRevenueWallet, 
        parseUnits(platformShare.toFixed(6), 6)
      );

      await Promise.all([listerTx.wait(), adminTx.wait()]);

      return {
        tradeId,
        profitAmount: netProfitUsdc,
        listerFee: listerShare,
        platformFee: platformShare,
        listerAddress,
        platformAddress: this.env.adminRevenueWallet,
        txHash: listerTx.hash
      };

    } catch (error) {
      this.logger.error(`Failed to distribute fees`, error as Error);
      return null;
    }
  }
}