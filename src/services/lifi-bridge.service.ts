import { createConfig, getRoutes, executeRoute, Solana, EVM } from '@lifi/sdk';
import axios from 'axios';

// --- HELPER: Solana Adapter for LiFi ---
// Wraps window.solana (Phantom/Backpack) to satisfy the WalletAdapter interface
const getSolanaAdapter = async () => {
    const provider = (window as any).solana;
    if (!provider) return null;
    
    if (!provider.isConnected) {
        try {
            await provider.connect();
        } catch (e) {
            return null; // User rejected
        }
    }

    // Map Phantom's API to the standard WalletAdapter interface expected by LiFi
    return {
        publicKey: provider.publicKey,
        signTransaction: provider.signTransaction.bind(provider),
        signAllTransactions: provider.signAllTransactions.bind(provider),
        signMessage: provider.signMessage?.bind(provider),
        
        // Critical: Map sendTransaction to Phantom's signAndSendTransaction
        sendTransaction: async (transaction: any, connection: any, options: any = {}) => {
             const { signature } = await provider.signAndSendTransaction(transaction, {
                 skipPreflight: options.skipPreflight || false,
             });
             return signature;
        },
        
        connect: provider.connect.bind(provider),
        disconnect: provider.disconnect.bind(provider),
        on: provider.on.bind(provider),
        off: provider.off.bind(provider),
    };
};

// --- GLOBAL CONFIGURATION ---
// We explicitly register both EVM (MetaMask) and Solana (Phantom) providers.
createConfig({
  integrator: 'BetMirror', 
  providers: [
      EVM(), // Automatically detects window.ethereum
      Solana({
          async getWalletAdapter() {
              const adapter = await getSolanaAdapter();
              if (!adapter) {
                  throw new Error("Solana wallet not found. Please install Phantom.");
              }
              return adapter as any; 
          }
      })
  ],
  routeOptions: {
    fee: 0.005, // 0.5% Platform Fee
  }
});

export interface BridgeQuoteParams {
  fromChainId: number;
  fromTokenAddress: string;
  fromAmount: string; 
  fromAddress?: string; // Sender Address
  toChainId: number;
  toTokenAddress: string;
  toAddress: string; // Destination (Smart Account)
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
  
  async getDepositRoute(params: BridgeQuoteParams) {
    try {
      const result = await getRoutes({
        fromChainId: params.fromChainId,
        fromTokenAddress: params.fromTokenAddress,
        fromAmount: params.fromAmount,
        fromAddress: params.fromAddress, // Critical for LiFi to know WHO is sending
        toChainId: params.toChainId,
        toTokenAddress: params.toTokenAddress, 
        toAddress: params.toAddress,
        options: {
            slippage: 0.005, // 0.5% Slippage
            order: 'CHEAPEST'
        }
      });
      
      return result.routes;
    } catch (error) {
      console.error("LiFi Route Error:", error);
      throw error;
    }
  }

  async executeBridge(route: any, onUpdate: (status: string, step?: any) => void) {
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
                 const activeProcess = process?.find((p: any) => p.status === 'STARTED' || p.status === 'PENDING') || process?.[process.length - 1];
                 
                 let statusMsg = "Processing...";
                 if (activeProcess) {
                     if (activeProcess.type === 'TOKEN_ALLOWANCE') statusMsg = "Approving Token Spend...";
                     if (activeProcess.type === 'SWAP') statusMsg = "Swapping Assets...";
                     if (activeProcess.type === 'CROSS_CHAIN') statusMsg = "Bridging to Polygon...";
                 }
                 
                 onUpdate(statusMsg, step);
             }
         });
         
         const lastStep = result.steps[result.steps.length - 1];
         // Attempt to extract TxHash from various locations in the response
         const txHash = (lastStep.execution as any)?.toTx || 
                        lastStep.execution?.process?.find((p: any) => p.txHash)?.txHash ||
                        lastStep.execution?.process?.slice(-1)[0]?.txHash;

         await this.saveRecord({ ...record, status: 'COMPLETED', txHash });
         return result;
     } catch (e) {
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
      const index = this.history.findIndex(r => r.id === record.id);
      if (index >= 0) {
          this.history[index] = record;
      } else {
          this.history.unshift(record);
      }

      if (this.userId) {
          try {
              await axios.post('/api/bridge/record', {
                  userId: this.userId,
                  transaction: record
              });
          } catch (e) {
              console.error("Failed to persist bridge record", e);
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

  getTokenAddress(chainId: number, type: 'NATIVE' | 'USDC'): string {
      // Solana
      if (chainId === 1151111081099710) {
          if (type === 'NATIVE') return '11111111111111111111111111111111'; 
          if (type === 'USDC') return 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; 
      }

      // EVM Native
      if (type === 'NATIVE') {
          return '0x0000000000000000000000000000000000000000';
      }

      // EVM USDC
      switch(chainId) {
          case 1: return '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
          case 137: return '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
          case 8453: return '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
          case 42161: return '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
          case 56: return '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
          default: return '0x0000000000000000000000000000000000000000';
      }
  }
}

export const lifiService = new LiFiBridgeService();