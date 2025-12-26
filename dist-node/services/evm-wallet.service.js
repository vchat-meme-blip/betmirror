import { Wallet, JsonRpcProvider, Contract, parseEther, parseUnits } from 'ethers';
import { Wallet as WalletV5, providers as providersV5 } from 'ethers-v5';
import { DatabaseEncryptionService } from './database-encryption.service.js';
// Basic standard ABI for ERC20
const USDC_ABI = [
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
];
/**
 * Service to manage Dedicated Trading Wallets (EOAs).
 * Includes Shim for Ethers v6 compatibility with Polymarket SDK (v5).
 */
export class EvmWalletService {
    provider;
    rpcUrl;
    constructor(rpcUrl, encryptionKey) {
        this.rpcUrl = rpcUrl;
        this.provider = new JsonRpcProvider(rpcUrl);
        // Ensure centralized encryption service is initialized
        if (!DatabaseEncryptionService.validateEncryptionKey()) {
            DatabaseEncryptionService.init(encryptionKey);
        }
    }
    /**
     * Generates a new random wallet, encrypts the private key, and returns config.
     */
    async createTradingWallet(ownerAddress) {
        const wallet = Wallet.createRandom();
        // Centralized GCM encryption
        const encryptedKey = DatabaseEncryptionService.encrypt(wallet.privateKey);
        return {
            address: wallet.address,
            encryptedPrivateKey: encryptedKey,
            ownerAddress: ownerAddress.toLowerCase(),
            createdAt: new Date().toISOString()
        };
    }
    /**
     * Decrypts the private key and returns a connected Wallet instance (Ethers V6).
     */
    async getWalletInstance(encryptedPrivateKey) {
        const privateKey = DatabaseEncryptionService.decrypt(encryptedPrivateKey);
        const wallet = new Wallet(privateKey, this.provider);
        // --- COMPATIBILITY SHIM START (Legacy Support) ---
        if (typeof wallet._signTypedData === 'undefined' && typeof wallet.signTypedData === 'function') {
            wallet._signTypedData = async (domain, types, value) => {
                const { EIP712Domain, ...cleanTypes } = types;
                return await wallet.signTypedData(domain, cleanTypes, value);
            };
        }
        // --- COMPATIBILITY SHIM END ---
        return wallet;
    }
    /**
     * Returns an Ethers V5 Wallet instance.
     * REQUIRED for Polymarket SDKs to function correctly without hacks.
     */
    async getWalletInstanceV5(encryptedPrivateKey) {
        const privateKey = DatabaseEncryptionService.decrypt(encryptedPrivateKey);
        const provider = new providersV5.JsonRpcProvider(this.rpcUrl);
        return new WalletV5(privateKey, provider);
    }
    /**
     * Withdraws funds from the Trading Wallet to the Owner Address.
     * Supports both Native (POL) and ERC20 (USDC).
     */
    async withdrawFunds(encryptedPrivateKey, toAddress, tokenAddress, amount // If undefined, withdraws max
    ) {
        const wallet = await this.getWalletInstance(encryptedPrivateKey);
        const isNative = tokenAddress === '0x0000000000000000000000000000000000000000';
        if (isNative) {
            // Native Withdrawal (POL)
            const balance = await this.provider.getBalance(wallet.address);
            // Ethers v6 FeeData
            const feeData = await this.provider.getFeeData();
            // Fallback to 30 gwei if null
            const gasPrice = feeData.gasPrice ?? 30000000000n;
            const gasLimit = 21000n;
            const cost = gasPrice * gasLimit;
            let valueToSend = amount ? parseEther(amount) : balance - cost;
            if (valueToSend <= 0n) {
                throw new Error("Insufficient native balance for gas");
            }
            const tx = await wallet.sendTransaction({
                to: toAddress,
                value: valueToSend
            });
            await tx.wait();
            return tx.hash;
        }
        else {
            // ERC20 Withdrawal (USDC)
            const contract = new Contract(tokenAddress, USDC_ABI, wallet);
            const balance = await contract.balanceOf(wallet.address);
            const valueToSend = amount ? parseUnits(amount, 6) : balance;
            if (valueToSend <= 0n)
                throw new Error("Insufficient token balance");
            const tx = await contract.transfer(toAddress, valueToSend);
            await tx.wait();
            return tx.hash;
        }
    }
}
