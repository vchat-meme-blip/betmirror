
import { createConfig, getRoutes, executeRoute, Solana, EVM, Route } from '@lifi/sdk';
import { createWalletClient, custom } from 'viem';
import axios from 'axios';
import { web3Service } from './web3.service.js';

// --- GLOBAL CONFIGURATION ---
// Use private RPCs to avoid public rate limits (403/429 Errors)
const privateSolanaRpc = process.env.SOLANA_RPC_URL || 'https://little-thrilling-layer.solana-mainnet.quiknode.pro/378fe82ae3cb5d38e4ac79c202990ad508e1c4c6';
const privatePolygonRpc = process.env.RPC_URL || 'https://polygon-rpc.com';

// --- HELPER: Solana Adapter for LiFi ---
// Robust wrapper for Phantom, Solflare, Backpack, and Standard Wallets
const getSolanaAdapter = async () => {
    // 1. Detect Provider (Standard > Phantom > Solflare)
    const provider = (window as any).solana || (window as any).phantom?.solana || (window as any).solflare;
    
    if (!provider) return null;
    
    // 2. Ensure Connection
    try {
        if (!provider.isConnected) {
            await provider.connect();
        }
    } catch (e) {
        console.warn("User rejected Solana connection", e);
        return null;
    }

    // 3. Create Adapter Proxy
    // We return a proxy to ensure we always access the latest state (publicKey) 
    // and map functions correctly to the WalletAdapter interface.
    return {
        // Properties
        get publicKey() { return provider.publicKey; },
        get connected() { return provider.isConnected; },
        
        // Methods
        connect: provider.connect.bind(provider),
        disconnect: provider.disconnect.bind(provider),
        signMessage: provider.signMessage?.bind(provider),
        signTransaction: provider.signTransaction?.bind(provider),
        signAllTransactions: provider.signAllTransactions?.bind(provider),
        
        // Critical: Custom sendTransaction to handle simulation skipping and return types
        sendTransaction: async (transaction: any, connection: any, options: any = {}) => {
             const { signature } = await provider.signAndSendTransaction(transaction, {
                 ...options,
                 skipPreflight: true, // IMPORTANT: Skips strict simulation which often fails on-chain due to rent/fee fluctuation
             });
             return signature;
        },
        
        // Events
        on: (event: any, callback: any) => {
            if (provider.on) provider.on(event, callback);
        },
        off: (event: any, callback: any) => {
            if (provider.off) provider.off(event, callback);
        }
    };
};

// --- LIFI SDK CONFIG ---
createConfig({
  integrator: 'BetMirror', 
  providers: [
      // EVM Provider: Direct instantiation to avoid auto-switching loops
      EVM({
        getWalletClient: async () => {
            if (typeof window === 'undefined' || !(window as any).ethereum) return undefined as any;
            try {
                // Return current client WITHOUT forcing chain switch
                // LiFi will call switchChain if needed
                const [account] = await (window as any).ethereum.request({ method: 'eth_accounts' });
                if (!account) return undefined as any;
                
                return createWalletClient({
                    account,
                    transport: custom((window as any).ethereum)
                });
            } catch (e) {
                console.warn("LiFi EVM Client Error:", e);
                return undefined as any;
            }
        },
        switchChain: async (chainId: number) => {
            // Use our service for the actual switching logic which handles errors gracefully
            await web3Service.switchToChain(chainId);
            
            // Return new client after switch
            const [account] = await (window as any).ethereum.request({ method: 'eth_accounts' });
            return createWalletClient({
                account,
                transport: custom((window as any).ethereum)
            });
        }
      } as any), 
      // Solana Provider
      Solana({
          async getWalletAdapter() {
              const adapter = await getSolanaAdapter();
              if (!adapter) {
                  // This error is caught by LiFi and simply disables the provider if not available
                  throw new Error("Solana wallet not found.");
              }
              return adapter as any; 
          }
      })
  ],
  // RPC Configuration to prevent rate limits
  rpcUrls: {
      1: [ 'https://eth.llamarpc.com' ],
      137: [ privatePolygonRpc ],
      8453: [ 'https://mainnet.base.org' ],
      1151111081099710: [ privateSolanaRpc ]
  },
  routeOptions: {
    fee: 0.005, // 0.5% Platform Fee
  }
});

export interface BridgeQuoteParams {
  fromChainId: number;
  fromTokenAddress: string;
  fromAmount: string; 
  fromAddress?: string; 
  toChainId: number;
  toTokenAddress: string;
  toAddress: string; 
}

export interface BridgeTransactionRecord {
  id: string;
  timestamp: string;
  fromChain: string;
  toChain: string;
  amountIn: string;
  amountOut: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  txHash?: string;
  tool?: string;
  fees?: string;
}

export class LiFiBridgeService {
  private history: BridgeTransactionRecord[] = [];
  private userId: string = '';

  setUserId(userId: string) {
      this.userId = userId;
  }
  
  // Renamed for generic usage, maintains backward compat structure
  async getRoute(params: BridgeQuoteParams) {
    try {
      // Ensure amount is string
      const amountStr = typeof params.fromAmount === 'number' ? String(params.fromAmount) : params.fromAmount;

      const result = await getRoutes({
        fromChainId: params.fromChainId,
        fromTokenAddress: params.fromTokenAddress,
        fromAmount: amountStr,
        fromAddress: params.fromAddress, 
        toChainId: params.toChainId,
        toTokenAddress: params.toTokenAddress, 
        toAddress: params.toAddress,
        options: {
            slippage: 0.005, // 0.5%
            order: 'CHEAPEST',
            allowSwitchChain: true
        }
      });
      
      return result.routes;
    } catch (error) {
      console.error("LiFi Route Error:", error);
      throw error;
    }
  }

  async executeBridge(route: Route, onUpdate: (status: string, step?: any) => void) {
     const recordId = Math.random().toString(36).substring(7);
     
     const record: BridgeTransactionRecord = {
         id: recordId,
         timestamp: new Date().toISOString(),
         fromChain: this.getChainName(route.fromChainId),
         toChain: this.getChainName(route.toChainId),
         amountIn: route.fromAmountUSD,
         amountOut: route.toAmountUSD,
         status: 'PENDING',
         tool: route.steps[0]?.toolDetails?.name || 'LiFi',
         fees: route.gasCostUSD
     };
     
     await this.saveRecord(record);

     try {
         const result = await executeRoute(route, {
             updateRouteHook: (updatedRoute) => {
                 const step = updatedRoute.steps[0];
                 const process = step.execution?.process;
                 // Get the most relevant active or failed process
                 const activeProcess = process?.find((p: any) => p.status === 'STARTED' || p.status === 'PENDING' || p.status === 'FAILED') || process?.[process.length - 1];
                 
                 let statusMsg = "Processing...";
                 if (activeProcess) {
                     if (activeProcess.type === 'TOKEN_ALLOWANCE') statusMsg = "Approving Token Spend...";
                     if (activeProcess.type === 'SWAP') statusMsg = "Swapping Assets...";
                     if (activeProcess.type === 'CROSS_CHAIN') statusMsg = "Bridging to Destination...";
                     if (activeProcess.status === 'FAILED') statusMsg = `Failed: ${activeProcess.errorMessage || 'Unknown error'}`;
                 }
                 
                 onUpdate(statusMsg, step);
             }
         });
         
         const lastStep = result.steps[result.steps.length - 1];
         // Try to find any transaction hash from the process list
         let txHash = (lastStep.execution as any)?.toTx;
         if (!txHash) {
             result.steps.forEach(s => {
                 s.execution?.process.forEach(p => {
                     if (p.txHash) txHash = p.txHash;
                 });
             });
         }

         await this.saveRecord({ ...record, status: 'COMPLETED', txHash });
         return result;
     } catch (e: any) {
         console.error("Bridge Execution Failed:", e);
         await this.saveRecord({ ...record, status: 'FAILED' });
         throw e;
     }
  }

  async fetchHistory(): Promise<BridgeTransactionRecord[]> {
      if (!this.userId) return [];
      try {
          const res = await axios.get(`/api/bridge/history/${this.userId}`);
          this.history = res.data;
          return this.history;
      } catch (e) {
          return [];
      }
  }

  getHistory(): BridgeTransactionRecord[] {
      return this.history;
  }

  private async saveRecord(record: BridgeTransactionRecord) {
      // Local update
      const index = this.history.findIndex(r => r.id === record.id);
      if (index >= 0) {
          this.history[index] = record;
      } else {
          this.history.unshift(record);
      }

      // Server persistence
      if (this.userId) {
          try {
              await axios.post('/api/bridge/record', {
                  userId: this.userId,
                  transaction: record
              });
          } catch (e) {
              // Silent fail for stats
          }
      }
  }

  getChainName(chainId: number): string {
      switch(chainId) {
          case 1: return 'Ethereum';
          case 137: return 'Polygon';
          case 8453: return 'Base';
          case 42161: return 'Arbitrum';
          case 56: return 'BNB Chain';
          case 1151111081099710: return 'Solana';
          default: return `Chain ${chainId}`;
      }
  }

  // Enhanced to support native/bridged toggling
  getTokenAddress(chainId: number, type: 'NATIVE' | 'USDC' | 'USDC.e'): string {
      if (chainId === 1151111081099710) { // Solana
          if (type === 'NATIVE') return '11111111111111111111111111111111'; 
          if (type === 'USDC' || type === 'USDC.e') return 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; 
      }
      if (type === 'NATIVE') {
          return '0x0000000000000000000000000000000000000000';
      }
      
      // EVM USDC Addresses
      switch(chainId) {
          case 1: return '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
          case 137: 
              // Explicit handling for Polygon Bridged vs Native
              if (type === 'USDC.e') return '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // Bridged USDC.e
              return '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC
          case 8453: return '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
          case 42161: return '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
          case 56: return '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
          default: return '0x0000000000000000000000000000000000000000';
      }
  }
}

export const lifiService = new LiFiBridgeService();
