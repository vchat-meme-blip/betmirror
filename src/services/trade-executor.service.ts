
import type { ClobClient } from '@polymarket/clob-client';
import { Wallet, Contract, MaxUint256 } from 'ethers';
import type { RuntimeEnv } from '../config/env.js';
import type { Logger } from '../utils/logger.util.js';
import type { TradeSignal, ActivePosition } from '../domain/trade.types.js';
import { computeProportionalSizing } from '../config/copy-strategy.js';
import { postOrder } from '../utils/post-order.util.js';
import { getUsdBalanceApprox } from '../utils/get-balance.util.js';
import { httpGet } from '../utils/http.js';

export type TradeExecutorDeps = {
  client: ClobClient & { wallet: Wallet };
  proxyWallet: string;
  env: RuntimeEnv;
  logger: Logger;
};

interface Position {
  conditionId: string;
  initialValue: number;
  currentValue: number;
}

// Polymarket CTF Exchange Address (Polygon)
const POLYMARKET_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const USDC_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
];

export class TradeExecutorService {
  private readonly deps: TradeExecutorDeps;
  private usdcContract: Contract;

  constructor(deps: TradeExecutorDeps) {
    this.deps = deps;
    this.usdcContract = new Contract(deps.env.usdcContractAddress, USDC_ABI, deps.client.wallet);
  }

  async ensureAllowance(): Promise<boolean> {
    const { logger } = this.deps;
    try {
      const allowance = await this.usdcContract.allowance(this.deps.proxyWallet, POLYMARKET_EXCHANGE);
      
      if (allowance < BigInt(1000000 * 1000000)) {
        logger.info('🔓 Token Allowance Low. Auto-Approving Polymarket Exchange...');
        try {
            const tx = await this.usdcContract.approve(POLYMARKET_EXCHANGE, MaxUint256);
            logger.info(`⏳ Approval Tx Sent: ${tx.hash}`);
            await tx.wait();
            logger.info('✅ USDC Auto-Approved for Trading!');
        } catch (err: any) {
            logger.warn(`Allowance update skipped (Session Key might typically delegate this): ${err.message}`);
        }
        return true;
      }
      
      logger.info('✅ USDC Allowance Active');
      return true;
    } catch (e: any) {
      logger.error('Failed to check/set allowance', e as Error);
      return false;
    }
  }

  async revokeAllowance(): Promise<boolean> {
      const { logger } = this.deps;
      try {
          logger.info('🔒 Revoking Token Allowance...');
          const tx = await this.usdcContract.approve(POLYMARKET_EXCHANGE, 0);
          logger.info(`⏳ Revoke Tx Sent: ${tx.hash}`);
          await tx.wait();
          logger.info('✅ Allowance Revoked. Bot cannot trade.');
          return true;
      } catch (e) {
          logger.error('Failed to revoke allowance', e as Error);
          return false;
      }
  }

  async executeManualExit(position: ActivePosition, currentPrice: number): Promise<boolean> {
      const { logger, client } = this.deps;
      try {
          logger.info(`📉 Executing Manual Exit (Auto-TP) for ${position.tokenId} @ ${currentPrice}`);
          
          await postOrder({
              client,
              marketId: position.marketId,
              tokenId: position.tokenId,
              outcome: position.outcome as any,
              side: 'SELL',
              sizeUsd: position.sizeUsd
          });
          
          return true;
      } catch (e) {
          logger.error(`Failed to execute manual exit`, e as Error);
          return false;
      }
  }

  async copyTrade(signal: TradeSignal): Promise<number> {
    const { logger, env, client } = this.deps;
    try {
      const yourUsdBalance = await getUsdBalanceApprox(client.wallet, env.usdcContractAddress);
      
      // Use robust HTTP get for whale balance
      const traderBalance = await this.getTraderBalance(signal.trader);

      const sizing = computeProportionalSizing({
        yourUsdBalance,
        traderUsdBalance: traderBalance,
        traderTradeUsd: signal.sizeUsd,
        multiplier: env.tradeMultiplier,
      });

      logger.info(`[Sizing] Whale: $${traderBalance.toFixed(0)} | Signal: $${signal.sizeUsd.toFixed(0)} | You: $${yourUsdBalance.toFixed(2)} | Target: $${sizing.targetUsdSize.toFixed(2)}`);

      if (sizing.targetUsdSize === 0) {
          if (yourUsdBalance < 0.50) {
             logger.warn(`❌ Skipped: Insufficient balance ($${yourUsdBalance.toFixed(2)}) for min trade ($0.50).`);
          } else {
             logger.warn(`❌ Skipped: Calculated size $0.00 (Whale trade too small relative to portfolio ratio).`);
          }
          return 0;
      }

      if (signal.side === 'BUY') {
        if (yourUsdBalance < sizing.targetUsdSize) {
          logger.error(`Insufficient USDC. Need: $${sizing.targetUsdSize.toFixed(2)}, Have: $${yourUsdBalance.toFixed(2)}`);
          return 0;
        }
      }

      await postOrder({
        client,
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        outcome: signal.outcome,
        side: signal.side,
        sizeUsd: sizing.targetUsdSize,
      });
      
      return sizing.targetUsdSize;

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes('closed') || errorMessage.includes('resolved') || errorMessage.includes('No orderbook')) {
        logger.warn(`Skipping - Market closed/resolved.`);
      } else {
        logger.error(`Failed to copy trade: ${errorMessage}`, err as Error);
      }
      return 0;
    }
  }

  private async getTraderBalance(trader: string): Promise<number> {
    try {
      // Use the robust httpGet with retry
      const positions: Position[] = await httpGet<Position[]>(
        `https://data-api.polymarket.com/positions?user=${trader}`,
      );
      const totalValue = positions.reduce((sum, pos) => sum + (pos.currentValue || pos.initialValue || 0), 0);
      return Math.max(1000, totalValue);
    } catch {
      return 10000; // Fallback whale size on API fail
    }
  }
}
