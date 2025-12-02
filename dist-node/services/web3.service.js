import { BrowserProvider, Contract, parseUnits } from 'ethers';
import { createWalletClient, custom } from 'viem';
import { polygon } from 'viem/chains';
export const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
export const USDC_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)'
];
export class Web3Service {
    constructor() {
        this.provider = null;
        this.signer = null;
        this.viemClient = null;
    }
    async connect() {
        if (!window.ethereum) {
            throw new Error("No wallet found. Please install MetaMask, Rabbit, or Coinbase Wallet.");
        }
        this.provider = new BrowserProvider(window.ethereum);
        await this.provider.send("eth_requestAccounts", []);
        this.signer = await this.provider.getSigner();
        // Auto-switch to Polygon on connect for best UX
        try {
            await this.switchToChain(137);
        }
        catch (e) {
            console.warn("Auto-switch failed on connect (non-critical):", e);
        }
        return await this.signer.getAddress();
    }
    /**
     * Returns a Viem Wallet Client (Required for ZeroDev / AA)
     * Automatically enforces the correct chain context with robust polling.
     */
    async getViemWalletClient(targetChainId = 137) {
        if (!window.ethereum)
            throw new Error("No Wallet");
        const provider = window.ethereum;
        // 1. Strict Chain Check with Retry
        await this.ensureChain(provider, targetChainId);
        const [account] = await provider.request({ method: 'eth_requestAccounts' });
        // Always recreate the client to ensure it binds to the freshly switched provider context
        // Cast to unknown then WalletClient to avoid "Type instantiation is excessively deep" error
        this.viemClient = createWalletClient({
            account,
            chain: polygon, // ZeroDev expects Polygon
            transport: custom(provider)
        });
        return this.viemClient;
    }
    /**
     * Polling mechanism to ensure provider is actually on the target chain
     * preventing 'Provider is not connected to requested chain' errors.
     */
    async ensureChain(provider, targetChainId) {
        const hexTarget = "0x" + targetChainId.toString(16);
        // Try up to 5 times to verify chain
        for (let i = 0; i < 5; i++) {
            const currentChainIdHex = await provider.request({ method: 'eth_chainId' });
            if (parseInt(currentChainIdHex, 16) === targetChainId) {
                return; // We are good
            }
            if (i === 0 || i === 2) {
                // Trigger switch on first and third attempt (aggressive retry)
                await this.switchToChain(targetChainId);
            }
            // Wait 500ms before checking again
            await new Promise(r => setTimeout(r, 500));
        }
        throw new Error(`Failed to switch network. Please manually switch to Polygon (Chain ID ${targetChainId}) in your wallet.`);
    }
    async switchToChain(chainId) {
        if (!this.provider) {
            this.provider = new BrowserProvider(window.ethereum);
        }
        const hexChainId = "0x" + chainId.toString(16);
        try {
            await this.provider.send("wallet_switchEthereumChain", [{ chainId: hexChainId }]);
        }
        catch (switchError) {
            // Error 4902: Chain not added. Add it.
            // Also catch generic -32603 which sometimes happens on mobile wallets
            if (switchError.code === 4902 || switchError.code === -32603 || switchError.data?.originalError?.code === 4902 || switchError.message?.includes("Unrecognized chain")) {
                const chainConfig = this.getChainConfig(chainId);
                if (chainConfig) {
                    try {
                        await this.provider.send("wallet_addEthereumChain", [chainConfig]);
                    }
                    catch (addError) {
                        throw new Error(`Failed to add network: ${addError.message}`);
                    }
                }
                else {
                    throw new Error(`Chain ID ${chainId} configuration not found.`);
                }
            }
            else {
                console.error("Switch Error:", switchError);
                throw switchError;
            }
        }
    }
    async deposit(toAddress, amount) {
        if (!this.signer)
            await this.connect();
        // Ensure we are on Polygon for direct deposit
        await this.switchToChain(137);
        // Refresh signer after switch to avoid "underlying network changed" errors
        this.signer = await this.provider?.getSigner();
        const usdc = new Contract(USDC_POLYGON, USDC_ABI, this.signer);
        const decimals = await usdc.decimals();
        const amountUnits = parseUnits(amount, decimals);
        try {
            const tx = await usdc.transfer(toAddress, amountUnits);
            await tx.wait();
            return tx.hash;
        }
        catch (e) {
            console.error(e);
            // Catch common RPC errors
            if (e.code === 'CALL_EXCEPTION' || e.message?.includes('estimateGas') || e.message?.includes('missing revert data')) {
                throw new Error("Transaction failed during gas estimation. You likely have insufficient MATIC/POL for gas or insufficient USDC funds on Polygon.");
            }
            throw e;
        }
    }
    getChainConfig(chainId) {
        // Basic configs for popular chains
        if (chainId === 137)
            return {
                chainId: "0x89",
                chainName: "Polygon Mainnet",
                nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
                rpcUrls: ["https://polygon-rpc.com/"],
                blockExplorerUrls: ["https://polygonscan.com/"]
            };
        if (chainId === 56)
            return {
                chainId: "0x38",
                chainName: "BNB Smart Chain",
                nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
                rpcUrls: ["https://bsc-dataseed.binance.org/"],
                blockExplorerUrls: ["https://bscscan.com/"]
            };
        if (chainId === 8453)
            return {
                chainId: "0x2105",
                chainName: "Base Mainnet",
                nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://mainnet.base.org"],
                blockExplorerUrls: ["https://basescan.org"]
            };
        if (chainId === 42161)
            return {
                chainId: "0xA4B1",
                chainName: "Arbitrum One",
                nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://arb1.arbitrum.io/rpc"],
                blockExplorerUrls: ["https://arbiscan.io"]
            };
        return null;
    }
}
export const web3Service = new Web3Service();
