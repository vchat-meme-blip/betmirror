import { Contract, MaxUint256 } from 'ethers';
import { computeProportionalSizing } from '../config/copy-strategy.js';
import { postOrder } from '../utils/post-order.util.js';
import { getUsdBalanceApprox, getPolBalance } from '../utils/get-balance.util.js';
import { httpGet } from '../utils/http.js';
// Polymarket CTF Exchange Address (Polygon)
const POLYMARKET_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const USDC_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
];
export class TradeExecutorService {
    constructor(deps) {
        this.deps = deps;
        this.usdcContract = new Contract(deps.env.usdcContractAddress, USDC_ABI, deps.client.wallet);
    }
    async ensureAllowance() {
        const { logger, client } = this.deps;
        try {
            const allowance = await this.usdcContract.allowance(client.wallet.address, POLYMARKET_EXCHANGE);
            // If allowance is less than 1 million USDC, assume it needs approval (infinity)
            if (allowance < BigInt(1000000 * 1000000)) {
                logger.info('🔓 Token Allowance Low. Auto-Approving Polymarket Exchange...');
                const tx = await this.usdcContract.approve(POLYMARKET_EXCHANGE, MaxUint256);
                logger.info(`⏳ Approval Tx Sent: ${tx.hash}`);
                await tx.wait();
                logger.info('✅ USDC Auto-Approved for Trading!');
                return true;
            }
            logger.info('✅ USDC Allowance Active');
            return true;
        }
        catch (e) {
            // Enhanced Error Handling for ZeroDev
            if (e.message?.includes('ProjectId not found') || e.details?.includes('ProjectId not found') || e.status === 404) {
                logger.error('❌ ZeroDev RPC Error: Project ID invalid or not found. Please check ZERODEV_RPC in your .env file.');
            }
            else {
                logger.error('Failed to check/set allowance', e);
            }
            return false;
        }
    }
    async revokeAllowance() {
        const { logger } = this.deps;
        try {
            logger.info('🔒 Revoking Token Allowance...');
            const tx = await this.usdcContract.approve(POLYMARKET_EXCHANGE, 0);
            logger.info(`⏳ Revoke Tx Sent: ${tx.hash}`);
            await tx.wait();
            logger.info('✅ Allowance Revoked. Bot cannot trade.');
            return true;
        }
        catch (e) {
            logger.error('Failed to revoke allowance', e);
            return false;
        }
    }
    /**
     * Manually exit a position (e.g. for Auto TP or Stop Loss)
     * Independent of the copy target's actions.
     */
    async executeManualExit(position, currentPrice) {
        const { logger, client } = this.deps;
        try {
            logger.info(`📉 Executing Manual Exit (Auto-TP) for ${position.tokenId} @ ${currentPrice}`);
            await postOrder({
                client,
                marketId: position.marketId,
                tokenId: position.tokenId,
                outcome: position.outcome,
                side: 'SELL',
                sizeUsd: position.sizeUsd // Sell full size
            });
            return true;
        }
        catch (e) {
            logger.error(`Failed to execute manual exit`, e);
            return false;
        }
    }
    /**
     * Executes the copy trade.
     * Returns the ACTUAL size executed in USD.
     */
    async copyTrade(signal) {
        const { logger, env, client } = this.deps;
        try {
            const yourUsdBalance = await getUsdBalanceApprox(client.wallet, env.usdcContractAddress);
            const polBalance = await getPolBalance(client.wallet);
            const traderBalance = await this.getTraderBalance(signal.trader);
            logger.info(`Balance check - POL: ${polBalance.toFixed(4)} POL, USDC: ${yourUsdBalance.toFixed(2)} USDC`);
            const sizing = computeProportionalSizing({
                yourUsdBalance,
                traderUsdBalance: traderBalance,
                traderTradeUsd: signal.sizeUsd,
                multiplier: env.tradeMultiplier,
            });
            logger.info(`${signal.side} ${sizing.targetUsdSize.toFixed(2)} USD`);
            // Balance validation before executing trade
            const requiredUsdc = sizing.targetUsdSize;
            const minPolForGas = 0.01; // Minimum POL needed for gas
            if (signal.side === 'BUY') {
                if (yourUsdBalance < requiredUsdc) {
                    logger.error(`Insufficient USDC balance. Required: ${requiredUsdc.toFixed(2)} USDC, Available: ${yourUsdBalance.toFixed(2)} USDC`);
                    return 0;
                }
            }
            // Strict Gas Check skipped for Smart Accounts (Paymaster handles it), 
            // but good to keep for legacy EOA fallback
            if (polBalance < minPolForGas && !this.deps.proxyWallet.startsWith('0x')) {
                // Basic check only if not AA
            }
            await postOrder({
                client,
                marketId: signal.marketId,
                tokenId: signal.tokenId,
                outcome: signal.outcome,
                side: signal.side,
                sizeUsd: sizing.targetUsdSize,
            });
            logger.info(`Successfully executed ${signal.side} order for ${sizing.targetUsdSize.toFixed(2)} USD`);
            return sizing.targetUsdSize;
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            if (errorMessage.includes('closed') || errorMessage.includes('resolved') || errorMessage.includes('No orderbook')) {
                logger.warn(`Skipping trade - Market ${signal.marketId} is closed or resolved: ${errorMessage}`);
            }
            else {
                logger.error(`Failed to copy trade: ${errorMessage}`, err);
            }
            return 0;
        }
    }
    async getTraderBalance(trader) {
        try {
            const positions = await httpGet(`https://data-api.polymarket.com/positions?user=${trader}`);
            const totalValue = positions.reduce((sum, pos) => sum + (pos.currentValue || pos.initialValue || 0), 0);
            return Math.max(100, totalValue);
        }
        catch {
            return 1000;
        }
    }
}
