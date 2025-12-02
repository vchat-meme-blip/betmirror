
import { createConfig, getRoutes, executeRoute } from '@lifi/sdk';
import axios from 'axios';

// Initialize LiFi Config
const lifiConfig = createConfig({
  integrator: 'BetMirror', // Registered DApp Name for Monetization (Must be alphanumeric/dashes only)
  providers: [], // Auto-detect window.ethereum / window.solana
  routeOptions: {
    fee: 0.005, // 0.5% Protocol Fee (Global Setting)
  }
});

export interface BridgeQuoteParams {
  fromChainId: number;
  fromTokenAddress: string;
  fromAmount: string; // Atomic units
  toChainId: number;
  toTokenAddress: string;
  toAddress: string; // The Proxy/Smart Account Address
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
  
  /**
   * Get a quote to bridge funds from User's Chain -> Polygon Proxy
   * Fees are now applied globally via createConfig
   */
  async getDepositRoute(params: BridgeQuoteParams) {
    try {
      const result = await getRoutes({
        fromChainId: params.fromChainId,
        fromTokenAddress: params.fromTokenAddress,
        fromAmount: params.fromAmount,
        toChainId: params.toChainId, // Target: Polygon
        toTokenAddress: params.toTokenAddress, // Target: USDC
        toAddress: params.toAddress,
        options: {
            slippage: 0.005, // 0.5% Slippage
            order: 'CHEAPEST'
            // Integrator and Fee are now handled globally
        }
      });
      
      return result.routes;
    } catch (error) {
      console.error("LiFi Route Error:", error);
      throw error;
    }
  }

  /**
   * Execute the bridge transaction
   * Returns the full route object for tracking
   */
  async executeBridge(route: any, onUpdate: (status: string, step?: any) => void) {
     const recordId = Math.random().toString(36).substring(7);
     
     // 1. Log Start
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
         // 2. Execute
         const result = await executeRoute(route, {
             updateRouteHook: (updatedRoute) => {
                 const step = updatedRoute.steps[0];
                 const process = step.execution?.process;
                 // Find the active process
                 const activeProcess = process?.find(p => p.status === 'STARTED' || p.status === 'PENDING') || process?.[process.length - 1];
                 
                 let statusMsg = "Processing...";
                 if (activeProcess) {
                     if (activeProcess.type === 'TOKEN_ALLOWANCE') statusMsg = "Approving Token Spend...";
                     if (activeProcess.type === 'SWAP') statusMsg = "Swapping Assets...";
                     if (activeProcess.type === 'CROSS_CHAIN') statusMsg = "Bridging to Polygon...";
                 }
                 
                 onUpdate(statusMsg, step);
             }
         });
         
         // 3. Success
         const lastStep = result.steps[result.steps.length - 1];
         // Safe access to txHash via casting or process inspection
         const txHash = (lastStep.execution as any)?.toTx || 
                        lastStep.execution?.process?.find((p: any) => p.txHash)?.txHash ||
                        lastStep.execution?.process?.slice(-1)[0]?.txHash;

         await this.saveRecord({ ...record, status: 'COMPLETED', txHash });
         return result;
     } catch (e) {
         // 4. Fail
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
          console.error("Failed to fetch bridge history", e);
          return [];
      }
  }

  getHistory(): BridgeTransactionRecord[] {
      return this.history;
  }

  private async saveRecord(record: BridgeTransactionRecord) {
      // Update Local State
      const index = this.history.findIndex(r => r.id === record.id);
      if (index >= 0) {
          this.history[index] = record;
      } else {
          this.history.unshift(record);
      }

      // Persist to DB
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

  /**
   * Returns the correct token address for LiFi based on Chain and Type.
   * FIX: Solana Native must use specific mint address, not 0x00.
   */
  getTokenAddress(chainId: number, type: 'NATIVE' | 'USDC'): string {
      // Solana Special Case
      if (chainId === 1151111081099710) {
          if (type === 'NATIVE') return '11111111111111111111111111111111'; // SOL Mint
          if (type === 'USDC') return 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC (Solana)
      }

      // EVM Native (ETH/MATIC/BNB)
      if (type === 'NATIVE') {
          return '0x0000000000000000000000000000000000000000';
      }

      // EVM USDC Addresses
      switch(chainId) {
          case 1: return '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // Ethereum
          case 137: return '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // Polygon (Bridged)
          case 8453: return '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // Base
          case 42161: return '0xaf88d065e77c8cc2239327c5edb3a432268e5831'; // Arbitrum
          case 56: return '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'; // BNB
          default: return '0x0000000000000000000000000000000000000000'; // Fallback
      }
  }

  // Deprecated: Use getTokenAddress instead
  getNativeToken(chainId: number): string {
      return this.getTokenAddress(chainId, 'NATIVE');
  }
}

export const lifiService = new LiFiBridgeService();
