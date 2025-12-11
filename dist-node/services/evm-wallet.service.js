import { Wallet, JsonRpcProvider, Contract, parseUnits } from 'ethers';
import crypto from 'crypto';
// Basic standard ABI for ERC20
const USDC_ABI = [
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
];
/**
 * Service to manage Dedicated Trading Wallets (EOAs).
 * Replaces the complex ZeroDev Smart Account logic with standard EVM wallet operations.
 * Ensures strict compatibility with Polymarket CLOB signature requirements.
 */
export class EvmWalletService {
    constructor(rpcUrl, encryptionKey) {
        this.provider = new JsonRpcProvider(rpcUrl);
        this.encryptionKey = encryptionKey;
    }
    /**
     * Generates a new random wallet, encrypts the private key, and returns config.
     */
    async createTradingWallet(ownerAddress) {
        const wallet = Wallet.createRandom();
        const encryptedKey = this.encrypt(wallet.privateKey);
        return {
            address: wallet.address,
            encryptedPrivateKey: encryptedKey,
            ownerAddress: ownerAddress.toLowerCase(),
            createdAt: new Date().toISOString()
        };
    }
    /**
     * Decrypts the private key and returns a connected Wallet instance.
     */
    async getWalletInstance(encryptedPrivateKey) {
        const privateKey = this.decrypt(encryptedPrivateKey);
        return new Wallet(privateKey, this.provider);
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
            // Leave some gas behind if withdrawing native
            const balance = await this.provider.getBalance(wallet.address);
            const gasPrice = (await this.provider.getFeeData()).gasPrice || parseUnits('30', 'gwei');
            const gasLimit = 21000n;
            const cost = gasPrice * gasLimit;
            let valueToSend = amount || (balance - cost);
            if (valueToSend <= 0n)
                throw new Error("Insufficient native balance for gas");
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
            const valueToSend = amount || balance;
            if (valueToSend <= 0n)
                throw new Error("Insufficient token balance");
            const tx = await contract.transfer(toAddress, valueToSend);
            await tx.wait();
            return tx.hash;
        }
    }
    // --- Encryption Helpers (AES-256-CBC) ---
    encrypt(text) {
        const iv = crypto.randomBytes(16);
        // Ensure key is 32 bytes
        const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(text);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    }
    decrypt(text) {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    }
}
