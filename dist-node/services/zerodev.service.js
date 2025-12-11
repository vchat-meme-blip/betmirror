/**
 * DEPRECATED
 *
 * This service has been replaced by EvmWalletService.ts.
 * The system now uses standard EOA wallets ("Trading Wallets") instead of
 * Smart Accounts (Kernel) to ensure compatibility with Polymarket CLOB.
 */
export class ZeroDevService {
    constructor() {
        throw new Error("ZeroDevService is deprecated. Use EvmWalletService.");
    }
}
