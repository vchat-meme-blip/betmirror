
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import axios from 'axios';
import './src/index.css';
import { 
  Shield, Play, Square, Activity, Settings, Wallet, Key, 
  Terminal, Trash2, Eye, EyeOff, Save, Lock, Users, RefreshCw, Server, Sparkles, DollarSign,
  TrendingUp, History, Copy, ExternalLink, AlertTriangle, Smartphone, Coins, PlusCircle, X,
  CheckCircle2, ArrowDownCircle, ArrowUpCircle, Brain, AlertCircle, Trophy, Globe, Zap, LogOut,
  Info, HelpCircle, ChevronRight, Rocket, Gauge, MessageSquare, Star, ArrowRightLeft, LifeBuoy,
  Sun, Moon, Loader2, Timer, Fuel, Check, BarChart3, ChevronDown, MousePointerClick,
  Zap as ZapIcon, FileText, Twitter, Github, LockKeyhole, BadgeCheck, Search, BookOpen, ArrowRightCircle, AreaChart,
  Volume2, VolumeX, Menu, ArrowUpDown, Clipboard, Wallet2, ArrowDown
} from 'lucide-react';
import { web3Service, USDC_POLYGON, USDC_BRIDGED_POLYGON, USDC_ABI } from './src/services/web3.service';
import { lifiService, BridgeTransactionRecord } from './src/services/lifi-bridge.service';
import { ZeroDevService } from './src/services/zerodev.service';
import { TradeHistoryEntry } from './src/domain/trade.types';
import { TraderProfile, CashoutRecord, BuilderVolumeData } from './src/domain/alpha.types';
import { UserStats } from './src/domain/user.types';
import { parseUnits, formatUnits, Contract, BrowserProvider, JsonRpcProvider, Provider } from 'ethers';

// Constants & Assets
const CHAIN_ICONS: Record<number, string> = {
    1: "https://cryptologos.cc/logos/ethereum-eth-logo.svg?v=026",
    137: "https://cryptologos.cc/logos/polygon-matic-logo.svg?v=026",
    8453: "https://cdn.brandfetch.io/id6XsSOVVS/theme/dark/logo.svg?c=1bxid64Mup7aczewSAYMX&t=1757929765938",
    42161: "https://cryptologos.cc/logos/arbitrum-arb-logo.svg?v=026",
    56: "https://cryptologos.cc/logos/bnb-bnb-logo.svg?v=026",
    1151111081099710: "https://cryptologos.cc/logos/solana-sol-logo.svg?v=026"
};

const CHAIN_NAMES: Record<number, string> = {
    1: "Ethereum Mainnet",
    137: "Polygon",
    8453: "Base",
    42161: "Arbitrum One",
    56: "BNB Chain",
    1151111081099710: "Solana"
};

// --- Types ---
interface Log {
  id: string;
  time: string;
  type: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

interface AppConfig {
  targets: string[];
  rpcUrl: string;
  geminiApiKey: string;
  multiplier: number;
  riskProfile: 'conservative' | 'balanced' | 'degen';
  autoTp: number;
  enableNotifications: boolean;
  userPhoneNumber: string;
  enableAutoCashout: boolean;
  maxRetentionAmount: number;
  coldWalletAddress: string;
  enableSounds: boolean; 
}

interface WalletBalances {
    native: string;
    usdc: string;
    usdcBridged?: string; // Added support for legacy bridged USDC
    usdcNative?: string;
}

interface GlobalStatsResponse {
    internal: {
        totalUsers: number;
        signalVolume: number;
        executedVolume: number;
        totalTrades: number;
        totalRevenue: number;
        totalLiquidity: number;
        activeBots: number;
    };
    builder: {
        current: BuilderVolumeData | null;
        history: BuilderVolumeData[];
        builderId: string;
        ecosystemVolume: number;
    };
}

interface PolyTrade {
    side: string;
    size: number;
    price: number;
    timestamp: number;
    conditionId: string;
    outcome: string;
    asset: string;
    transactionHash: string;
}

const STORAGE_KEY = 'bet_mirror_v3_config';

// --- Sound Manager ---
const playSound = (type: 'start' | 'stop' | 'trade' | 'cashout' | 'error') => {
    try {
        const audio = new Audio(`/sounds/${type}.mp3`);
        audio.volume = 0.5;
        audio.play().catch(e => console.warn("Audio play failed (interaction needed):", e));
    } catch (e) {
        console.warn("Audio error", e);
    }
};

// --- Components ---
const Tooltip = ({ text }: { text: string }) => (
    <div className="group relative flex items-center ml-1 inline-block">
        <HelpCircle size={12} className="text-gray-400 hover:text-blue-500 cursor-help" />
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded text-[10px] text-gray-600 dark:text-gray-300 shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 leading-relaxed">
            {text}
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white dark:bg-gray-900 border-b border-r border-gray-200 dark:border-gray-700 rotate-45"></div>
        </div>
    </div>
);

// --- New Component: Deposit Modal ---
const DepositModal = ({
    isOpen,
    onClose,
    balances,
    onDeposit,
    isDepositing,
    onBridgeRedirect
}: {
    isOpen: boolean;
    onClose: () => void;
    balances: WalletBalances;
    onDeposit: (amount: string, tokenType: 'USDC.e' | 'USDC' | 'POL') => void;
    isDepositing: boolean;
    onBridgeRedirect: () => void;
}) => {
    const [amount, setAmount] = useState('');
    const [assetTab, setAssetTab] = useState<'USDC' | 'POL'>('USDC');
    const [selectedUsdcType, setSelectedUsdcType] = useState<'USDC.e' | 'USDC'>('USDC.e');

    // Auto-select the USDC type that has balance
    useEffect(() => {
        if (isOpen) {
            const bridgedBal = parseFloat(balances.usdcBridged || '0');
            const nativeBal = parseFloat(balances.usdcNative || '0');
            if (nativeBal > bridgedBal && nativeBal > 0) {
                setSelectedUsdcType('USDC'); // Prefer Native if user has more of it
            } else {
                setSelectedUsdcType('USDC.e'); // Default or if Bridged is higher
            }
        }
    }, [isOpen, balances]);

    if (!isOpen) return null;

    const getActiveBalance = () => {
        if (assetTab === 'POL') return balances.native;
        return selectedUsdcType === 'USDC.e' ? (balances.usdcBridged || '0') : (balances.usdcNative || '0');
    };

    const handleConfirm = () => {
        if (!amount || parseFloat(amount) <= 0) return;
        onDeposit(amount, assetTab === 'POL' ? 'POL' : selectedUsdcType);
    };

    const activeBalanceNum = parseFloat(getActiveBalance());
    const isLowBalance = activeBalanceNum < 0.5;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-2xl w-full max-w-md p-6 shadow-2xl relative">
                <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-gray-900 dark:hover:text-white"><X/></button>

                <div className="text-center mb-6">
                    <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/20 rounded-full flex items-center justify-center mx-auto mb-3 text-blue-600 dark:text-blue-500">
                        <ArrowDown size={24}/>
                    </div>
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white">Deposit Funds</h3>
                    <p className="text-xs text-gray-500 mt-1">Main Wallet (You) <span className="mx-1">→</span> Smart Vault (Bot's proxy wallet)</p>
                </div>

                {/* Asset Tabs */}
                <div className="flex p-1 bg-gray-100 dark:bg-black/40 rounded-lg mb-6">
                    <button 
                        onClick={() => setAssetTab('USDC')}
                        className={`flex-1 py-2 text-xs font-bold rounded-md transition-all ${assetTab === 'USDC' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500'}`}
                    >
                        USDC (Trading)
                    </button>
                    <button 
                        onClick={() => setAssetTab('POL')}
                        className={`flex-1 py-2 text-xs font-bold rounded-md transition-all ${assetTab === 'POL' ? 'bg-white dark:bg-gray-700 shadow-sm text-purple-600 dark:text-purple-400' : 'text-gray-500'}`}
                    >
                        POL (Gas)
                    </button>
                </div>

                {/* USDC Sub-Selector (Only if USDC Tab) */}
                {assetTab === 'USDC' && (
                    <div className="mb-4 grid grid-cols-2 gap-3">
                        <div 
                            onClick={() => setSelectedUsdcType('USDC.e')}
                            className={`p-3 rounded-xl border cursor-pointer transition-all ${selectedUsdcType === 'USDC.e' ? 'bg-green-50 dark:bg-green-900/20 border-green-500 dark:border-green-500 ring-1 ring-green-500' : 'bg-gray-50 dark:bg-black/20 border-gray-200 dark:border-gray-800 hover:border-gray-300'}`}
                        >
                            <div className="text-[10px] text-gray-500 font-bold uppercase mb-1">Bridged (PoS)</div>
                            <div className="text-sm font-mono font-bold text-gray-900 dark:text-white flex justify-between items-center">
                                USDC.e 
                                <span className="text-green-600 dark:text-green-400 text-xs">${balances.usdcBridged || '0.00'}</span>
                            </div>
                        </div>
                        <div 
                            onClick={() => setSelectedUsdcType('USDC')}
                            className={`p-3 rounded-xl border cursor-pointer transition-all ${selectedUsdcType === 'USDC' ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-500 dark:border-blue-500 ring-1 ring-blue-500' : 'bg-gray-50 dark:bg-black/20 border-gray-200 dark:border-gray-800 hover:border-gray-300'}`}
                        >
                            <div className="text-[10px] text-gray-500 font-bold uppercase mb-1">Native (Circle)</div>
                            <div className="text-sm font-mono font-bold text-gray-900 dark:text-white flex justify-between items-center">
                                USDC 
                                <span className="text-blue-600 dark:text-blue-400 text-xs">${balances.usdcNative || '0.00'}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Input Area */}
                <div className="relative mb-6">
                    <label className="text-[10px] font-bold text-gray-500 uppercase mb-1.5 block flex justify-between">
                        Amount to Deposit
                        <span className="text-gray-400">Available: {getActiveBalance()}</span>
                    </label>
                    <div className="relative">
                        <input 
                            type="text" 
                            inputMode="decimal"
                            className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-gray-700 rounded-xl py-3 px-4 text-lg font-mono font-bold text-gray-900 dark:text-white outline-none focus:border-blue-500 transition-all"
                            placeholder="0.00"
                            value={amount}
                            onChange={e => {
                                if (/^\d*\.?\d*$/.test(e.target.value)) setAmount(e.target.value);
                            }}
                        />
                        <button 
                            onClick={() => setAmount(getActiveBalance())}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-blue-600 dark:text-blue-400 hover:underline bg-blue-50 dark:bg-blue-900/30 px-2 py-1 rounded"
                        >
                            MAX
                        </button>
                    </div>
                </div>

                {/* Actions or Bridge Prompt */}
                {isLowBalance ? (
                    <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-xl border border-yellow-200 dark:border-yellow-800/50">
                        <div className="flex items-start gap-3">
                            <AlertTriangle size={18} className="text-yellow-600 dark:text-yellow-500 mt-0.5"/>
                            <div>
                                <h4 className="text-sm font-bold text-yellow-800 dark:text-yellow-200">Insufficient Funds</h4>
                                <p className="text-xs text-yellow-700 dark:text-yellow-400 mt-1 leading-relaxed">
                                    You don't have enough {assetTab === 'POL' ? 'POL' : 'USDC'} on Polygon. Bridge funds from Solana, Base, or Ethereum.
                                </p>
                                <button 
                                    onClick={onBridgeRedirect}
                                    className="mt-3 w-full py-2 bg-yellow-200 dark:bg-yellow-800 text-yellow-900 dark:text-yellow-100 text-xs font-bold rounded-lg hover:bg-yellow-300 dark:hover:bg-yellow-700 transition-colors flex items-center justify-center gap-2"
                                >
                                    <Globe size={14}/> Go to Bridge
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <button 
                        onClick={handleConfirm}
                        disabled={isDepositing || parseFloat(amount) <= 0}
                        className="w-full py-4 bg-blue-600 dark:bg-blue-500 hover:bg-blue-700 dark:hover:bg-blue-600 text-white font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isDepositing ? <Loader2 className="animate-spin" size={20}/> : <ArrowDownCircle size={20}/>}
                        {isDepositing ? 'Confirming...' : 'Confirm Deposit'}
                    </button>
                )}
            </div>
        </div>
    );
};


const WithdrawalModal = ({ 
    isOpen, 
    onClose, 
    balances, 
    onWithdraw, 
    isWithdrawing,
    successTx 
}: { 
    isOpen: boolean; 
    onClose: () => void; 
    balances: WalletBalances; 
    onWithdraw: (tokenType: 'USDC' | 'USDC.e' | 'POL') => void;
    isWithdrawing: boolean;
    successTx?: string | null;
}) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-2xl w-full max-w-md p-6 shadow-2xl relative">
                <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-gray-900 dark:hover:text-white"><X/></button>
                
                {successTx ? (
                    <div className="text-center py-6 space-y-4 animate-in zoom-in-95 duration-300">
                        <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto text-green-600 dark:text-green-500 mb-4">
                            <CheckCircle2 size={40}/>
                        </div>
                        <h3 className="text-2xl font-bold text-gray-900 dark:text-white">Withdrawal Sent!</h3>
                        <p className="text-sm text-gray-500 px-4">
                            Your funds are on the way. The Smart Account has executed the transfer.
                        </p>
                        
                        <div className="p-3 bg-gray-50 dark:bg-black/40 rounded-xl border border-gray-200 dark:border-gray-800 text-[10px] font-mono text-gray-600 dark:text-gray-400 break-all mx-2">
                            <div className="flex items-center justify-center gap-2 mb-1 opacity-70 uppercase font-bold tracking-widest">Transaction Hash</div>
                            {successTx}
                        </div>
                        
                        <div className="pt-4 flex flex-col gap-3">
                            <a 
                                href={`https://jiffyscan.xyz/userOpHash/${successTx}`} 
                                target="_blank" 
                                rel="noreferrer" 
                                className="w-full py-3 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 text-blue-600 dark:text-blue-400 font-bold rounded-xl transition-all flex items-center justify-center gap-2 text-sm"
                            >
                                View on Jiffyscan <ExternalLink size={16}/>
                            </a>
                            <button 
                                onClick={onClose}
                                className="w-full py-3 bg-gray-900 dark:bg-white hover:opacity-90 text-white dark:text-black font-bold rounded-xl transition-all text-sm"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="text-center mb-6">
                            <div className="w-12 h-12 bg-red-100 dark:bg-red-900/20 rounded-full flex items-center justify-center mx-auto mb-3 text-red-600 dark:text-red-500">
                                <LogOut size={24}/>
                            </div>
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white">Trustless Withdrawal</h3>
                            <p className="text-xs text-gray-500 mt-1">Move funds from Smart Account to Main Wallet.</p>
                        </div>

                        <div className="space-y-3">
                            {/* Bridged USDC Option (USDC.e) - Primary for Polymarket */}
                            <div className="p-4 bg-green-50 dark:bg-green-900/10 rounded-xl border border-green-200 dark:border-green-900/30 flex justify-between items-center">
                                <div>
                                    <div className="font-bold text-gray-900 dark:text-white flex items-center gap-2">
                                        USDC.e (Bridged) <span className="bg-green-200 dark:bg-green-900 text-green-800 dark:text-green-300 text-[8px] px-1.5 py-0.5 rounded">ACTIVE</span>
                                    </div>
                                    <div className="text-xs text-gray-500">Polymarket Trading Funds</div>
                                </div>
                                <div className="text-right">
                                     <div className="font-mono font-bold text-gray-900 dark:text-white">${balances.usdcBridged || '0.00'}</div>
                                     <button 
                                        onClick={() => onWithdraw('USDC.e')}
                                        disabled={isWithdrawing || parseFloat(balances.usdcBridged || '0') <= 0}
                                        className="text-[10px] text-green-600 hover:underline disabled:opacity-50 disabled:no-underline font-bold mt-1"
                                     >
                                        WITHDRAW ALL
                                     </button>
                                </div>
                            </div>

                            {/* Native USDC Option - Secondary */}
                            <div className="p-4 bg-gray-50 dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/10 flex justify-between items-center">
                                <div>
                                    <div className="font-bold text-gray-900 dark:text-white">USDC (Native)</div>
                                    <div className="text-xs text-gray-500">Circle Standard (0x3c49...)</div>
                                </div>
                                <div className="text-right">
                                     <div className="font-mono font-bold text-gray-900 dark:text-white">${balances.usdcNative || '0.00'}</div>
                                     <button 
                                        onClick={() => onWithdraw('USDC')}
                                        disabled={isWithdrawing || parseFloat(balances.usdcNative || '0') <= 0}
                                        className="text-[10px] text-blue-600 hover:underline disabled:opacity-50 disabled:no-underline font-bold mt-1"
                                     >
                                        WITHDRAW ALL
                                     </button>
                                </div>
                            </div>
                            
                             {/* POL Option */}
                             <div className="p-4 bg-gray-50 dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/10 flex justify-between items-center">
                                <div>
                                    <div className="font-bold text-gray-900 dark:text-white">POL (Gas)</div>
                                    <div className="text-xs text-gray-500">Network Token</div>
                                </div>
                                <div className="text-right">
                                     <div className="font-mono font-bold text-gray-900 dark:text-white">{balances.native}</div>
                                     <button 
                                        onClick={() => onWithdraw('POL')}
                                        disabled={isWithdrawing || parseFloat(balances.native) <= 0}
                                        className="text-[10px] text-blue-600 hover:underline disabled:opacity-50 disabled:no-underline font-bold mt-1"
                                     >
                                        WITHDRAW ALL
                                     </button>
                                </div>
                            </div>
                        </div>
                        
                        {isWithdrawing && (
                            <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 flex items-center gap-3">
                                <Loader2 className="animate-spin text-blue-600" size={20}/>
                                <span className="text-xs text-blue-800 dark:text-blue-200 font-bold">Processing Withdrawal... (This takes ~15s)</span>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

const TraderDetailsModal = ({ trader, onClose }: { trader: TraderProfile, onClose: () => void }) => {
    const [trades, setTrades] = useState<PolyTrade[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchHistory = async () => {
            try {
                const res = await axios.get(`/api/proxy/trades/${trader.address}`);
                setTrades(res.data);
            } catch (e) {
                console.error("Failed to load trader details", e);
            } finally {
                setLoading(false);
            }
        };
        fetchHistory();
    }, [trader.address]);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-2xl w-full max-w-4xl h-[80vh] flex flex-col relative shadow-2xl overflow-hidden">
                <div className="p-6 border-b border-gray-200 dark:border-gray-800 flex justify-between items-start bg-gray-50 dark:bg-black/20">
                    <div className="flex gap-4">
                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-2xl font-bold text-white shadow-lg">
                            {trader.address.slice(2,4)}
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                                    {trader.ens || `${trader.address.slice(0,6)}...${trader.address.slice(-4)}`}
                                </h2>
                                {(trader as any).isSystem && <span className="bg-blue-600 text-white text-[10px] px-2 py-0.5 rounded uppercase font-bold">OFFICIAL</span>}
                            </div>
                            <div className="flex items-center gap-4 mt-2 text-xs text-gray-500 font-mono">
                                <span className="bg-white dark:bg-white/5 px-2 py-1 rounded border border-gray-200 dark:border-white/10 select-all">{trader.address}</span>
                                <a href={`https://polymarket.com/profile/${trader.address}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-blue-500 hover:underline">
                                    View on Polymarket <ExternalLink size={10}/>
                                </a>
                            </div>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-gray-200 dark:hover:bg-white/10 rounded-full transition-colors">
                        <X size={20} className="text-gray-500"/>
                    </button>
                </div>
                <div className="grid grid-cols-4 border-b border-gray-200 dark:border-gray-800 divide-x divide-gray-200 dark:divide-gray-800 bg-white dark:bg-transparent">
                    <div className="p-4 text-center">
                        <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Win Rate</div>
                        <div className="text-2xl font-bold text-green-600 dark:text-green-400">{trader.winRate}%</div>
                    </div>
                    <div className="p-4 text-center">
                        <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Est. PnL</div>
                        <div className={`text-2xl font-bold ${trader.totalPnl >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-red-500'}`}>
                            ${trader.totalPnl.toLocaleString()}
                        </div>
                    </div>
                    <div className="p-4 text-center">
                        <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Activity (30d)</div>
                        <div className="text-2xl font-bold text-gray-900 dark:text-white">{trader.tradesLast30d}</div>
                    </div>
                    <div className="p-4 text-center">
                        <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Copiers</div>
                        <div className="text-2xl font-bold text-gray-900 dark:text-white">{trader.copyCount}</div>
                    </div>
                </div>
                <div className="flex-1 overflow-hidden flex flex-col bg-gray-50 dark:bg-black/40">
                    <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
                        <h3 className="font-bold text-gray-700 dark:text-gray-300 text-sm flex items-center gap-2">
                            <Activity size={14}/> Recent Executions
                        </h3>
                        <span className="text-[10px] text-gray-500">Live Data from Chain</span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-2">
                        {loading && (
                            <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-400">
                                <Loader2 size={32} className="animate-spin text-blue-500"/>
                                <span className="text-xs">Fetching live trades...</span>
                            </div>
                        )}
                        {!loading && trades.length === 0 && (
                            <div className="text-center text-gray-500 py-10 text-sm italic">No recent public trades found.</div>
                        )}
                        {trades.map((trade, idx) => (
                            <div key={idx} className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-white/5 rounded-lg p-3 flex justify-between items-center text-xs hover:border-blue-500/30 transition-colors">
                                <div className="flex flex-col gap-1">
                                    <span className="text-gray-500">{new Date(trade.timestamp * 1000).toLocaleString()}</span>
                                    <div className="flex items-center gap-2">
                                        <span className={`font-bold px-1.5 py-0.5 rounded text-[10px] ${trade.side === 'BUY' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'}`}>
                                            {trade.side}
                                        </span>
                                        <span className="font-medium text-gray-900 dark:text-white">{trade.outcome}</span>
                                    </div>
                                </div>
                                <div className="flex flex-col items-end gap-1 text-right">
                                    <span className="font-mono text-gray-900 dark:text-white font-bold">${(trade.size * trade.price).toFixed(2)}</span>
                                    <span className="text-gray-500">@ {trade.price.toFixed(2)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="p-4 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-terminal-card flex justify-end">
                    <button onClick={onClose} className="px-6 py-2 bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 rounded-lg text-sm font-bold text-gray-900 dark:text-white transition-colors">
                        Close Insights
                    </button>
                </div>
            </div>
        </div>
    );
};

const FeedbackWidget = ({ userId }: { userId: string }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [rating, setRating] = useState(5);
    const [comment, setComment] = useState('');
    const [sent, setSent] = useState(false);

    const submit = async () => {
        try {
            await axios.post('/api/feedback', { userId, rating, comment });
            setSent(true);
            setTimeout(() => { setSent(false); setIsOpen(false); setComment(''); }, 2000);
        } catch (e) {}
    };

    return (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-4">
            {!isOpen && (
                <button 
                    onClick={() => setIsOpen(true)} 
                    className="w-14 h-14 bg-blue-600 rounded-full flex items-center justify-center text-white shadow-lg hover:scale-110 transition-all hover:shadow-blue-500/30 group relative"
                >
                    <MessageSquare size={24} className="group-hover:rotate-12 transition-transform" />
                    <span className="absolute top-0 right-0 w-3 h-3 bg-red-500 rounded-full border-2 border-white dark:border-black"></span>
                </button>
            )}
            {isOpen && (
                <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-2xl p-6 shadow-2xl w-80 animate-in slide-in-from-bottom-10 zoom-in-95 duration-300 relative overflow-hidden">
                    <div className="flex justify-between items-start mb-4">
                        <div>
                            <h4 className="text-gray-900 dark:text-white font-bold text-lg">Feedback</h4>
                            <p className="text-xs text-gray-500">Rate your experience</p>
                        </div>
                        <button onClick={() => setIsOpen(false)} className="p-1 hover:bg-gray-100 dark:hover:bg-white/10 rounded-full transition-colors">
                            <X size={16} className="text-gray-500"/>
                        </button>
                    </div>

                    {sent ? (
                        <div className="text-center py-8 flex flex-col items-center gap-3 animate-in fade-in zoom-in">
                            <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center text-green-600 dark:text-green-500">
                                <CheckCircle2 size={32}/>
                            </div>
                            <div>
                                <h5 className="font-bold text-gray-900 dark:text-white">Thank You!</h5>
                                <p className="text-xs text-gray-500">Your feedback helps us improve.</p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div className="flex justify-between px-2">
                                {[1,2,3,4,5].map(r => (
                                    <button 
                                        key={r} 
                                        onClick={() => setRating(r)} 
                                        className={`transition-all transform hover:scale-125 ${rating >= r ? "text-yellow-400 drop-shadow-sm" : "text-gray-300 dark:text-gray-700"}`}
                                    >
                                        <Star size={28} fill={rating >= r ? "currentColor" : "none"}/>
                                    </button>
                                ))}
                            </div>
                            <textarea 
                                className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-gray-800 rounded-xl p-3 text-sm text-gray-900 dark:text-white h-24 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all resize-none"
                                placeholder="Tell us what you like or what needs fixing..."
                                value={comment}
                                onChange={e => setComment(e.target.value)}
                            />
                            <button 
                                onClick={submit} 
                                className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-sm transition-all shadow-lg shadow-blue-500/20"
                            >
                                SEND FEEDBACK
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const BridgeStepper = ({ status }: { status: string }) => {
    let step = 1;
    if (status.includes("Approving") || status.includes("Swapping")) step = 2;
    if (status.includes("Bridging")) step = 3;
    if (status.includes("Receive") || status.includes("Complete")) step = 4;

    return (
        <div className="w-full py-4">
            <div className="flex justify-between items-center mb-2">
                {['Sign', 'Approve', 'Bridge', 'Finish'].map((label, idx) => {
                    const currentStep = idx + 1;
                    const isCompleted = step > currentStep;
                    const isActive = step === currentStep;
                    return (
                        <div key={label} className="flex flex-col items-center gap-1 relative z-10">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-500 ${
                                isCompleted ? 'bg-green-500 text-white' : 
                                isActive ? 'bg-blue-600 text-white scale-110 shadow-lg shadow-blue-500/30' : 
                                'bg-gray-200 dark:bg-gray-800 text-gray-400'
                            }`}>
                                {isCompleted ? <Check size={14}/> : currentStep}
                            </div>
                            <span className={`text-[10px] font-bold ${isActive ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'}`}>{label}</span>
                        </div>
                    )
                })}
                <div className="absolute top-7 left-0 w-full h-0.5 bg-gray-200 dark:bg-gray-800 -z-0 hidden"></div> 
            </div>
            <div className="text-center mt-4 p-2 bg-blue-50 dark:bg-blue-900/10 rounded-lg border border-blue-100 dark:border-blue-500/20">
                <span className="text-xs font-mono text-blue-600 dark:text-blue-400 animate-pulse flex items-center justify-center gap-2">
                    {step < 4 && <Loader2 size={12} className="animate-spin"/>}
                    {status || "Initializing..."}
                </span>
            </div>
        </div>
    );
};

const ActivationView = ({ 
    needsActivation, 
    handleActivate, 
    isActivating, 
    chainId, 
    userAddress, 
    theme, 
    toggleTheme 
}: any) => {
    const [recoveryMode, setRecoveryMode] = useState(false);
    const [computedAddress, setComputedAddress] = useState<string>('');
    const [existingBalance, setExistingBalance] = useState<string>('0.00');
    const [checking, setChecking] = useState(false);
    const [scanError, setScanError] = useState<string>('');
    const [showSafetyGuide, setShowSafetyGuide] = useState(false);
    const [manualToggle, setManualToggle] = useState(false);
    const [zeroDevService] = useState(() => new ZeroDevService(process.env.ZERODEV_RPC || 'https://rpc.zerodev.app/api/v2/bundler/PROJECT_ID'));

    const scanBlockchain = async () => {
        setChecking(true);
        setScanError('');
        setComputedAddress('');

        try {
            if (chainId !== 137) {
                try {
                    await web3Service.getViemWalletClient(137);
                } catch (e) {
                    setScanError("Please switch your wallet to Polygon Mainnet to scan.");
                    setChecking(false);
                    return;
                }
            }
            const walletClient = await web3Service.getViemWalletClient(137);
            const address = await zeroDevService.computeMasterAccountAddress(walletClient);
            
            if (address) {
                setComputedAddress(address);
                const polyProvider = new JsonRpcProvider('https://little-thrilling-layer.matic.quiknode.pro/378fe82ae3cb5d38e4ac79c202990ad508e1c4c6');
                
                // BRIDGED USDC ADDRESS (Polymarket Standard)
                // Native USDC is handled separately via USDC_POLYGON in Web3Service
                const USDC_BRIDGED_ADDR = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

                const [code, nativeBal, usdcBal] = await Promise.all([
                    polyProvider.getCode(address),
                    polyProvider.getBalance(address),
                    (async () => {
                        try {
                            // Check balance of Bridged USDC since that's likely what user has if coming from Polymarket
                            const usdcContract = new Contract(USDC_BRIDGED_ADDR, USDC_ABI, polyProvider);
                            return await usdcContract.balanceOf(address);
                        } catch { return BigInt(0); }
                    })()
                ]);

                const formattedUsdc = formatUnits(usdcBal, 6);
                setExistingBalance(formattedUsdc);

                const isDeployed = code !== '0x';
                const hasUsdc = usdcBal > BigInt(0);
                const hasPol = nativeBal > BigInt(10000000000000000); 

                if (isDeployed || hasUsdc || hasPol) {
                    setRecoveryMode(true); 
                } else {
                    setRecoveryMode(false); 
                }

            } else {
                setScanError("Could not calculate Smart Account address. RPC Error?");
            }
        } catch (e: any) {
            console.error("Scan failed", e);
            setScanError(e.message || "Failed to scan. Check console.");
        } finally {
            setChecking(false);
        }
    };

    useEffect(() => {
        if (userAddress && chainId === 137) {
            scanBlockchain();
        }
    }, [userAddress, chainId]);

    const effectiveRecoveryMode = manualToggle ? !recoveryMode : recoveryMode;

    return (
        <div className="min-h-screen bg-white dark:bg-[#050505] flex flex-col items-center justify-center text-gray-900 dark:text-white p-4 transition-colors duration-200">
            <div className="absolute top-6 right-6">
                <button onClick={toggleTheme} className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-white/10 text-gray-600 dark:text-gray-400 transition-colors">
                   {theme === 'light' ? <Moon size={20}/> : <Sun size={20}/>}
                </button>
            </div>

            <div className="max-w-xl w-full bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-8 space-y-6 relative overflow-hidden shadow-2xl">
                <div className="absolute top-0 right-0 p-8 opacity-5 text-blue-600">
                    <Shield size={120} />
                </div>
                
                <div className="flex items-center gap-4">
                    <div className={`p-4 rounded-xl border ${effectiveRecoveryMode ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-500/30' : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-500/30'}`}>
                        {effectiveRecoveryMode ? <RefreshCw size={32} className="text-green-600 dark:text-green-400" /> : <Zap size={32} className="text-blue-600 dark:text-blue-400" />}
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                            {effectiveRecoveryMode ? 'Restore Smart Session' : 'Activate Smart Bot'}
                        </h2>
                        <p className="text-gray-500">
                            {effectiveRecoveryMode ? 'Found your existing account.' : 'Create account & authorize trading.'}
                        </p>
                    </div>
                </div>
                {checking && (
                    <div className="flex items-center gap-2 text-xs text-blue-500 animate-pulse bg-blue-50 dark:bg-blue-900/10 p-3 rounded">
                        <Loader2 size={12} className="animate-spin"/> Scanning Polygon Blockchain for your account...
                    </div>
                )}

                {scanError && !checking && (
                    <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-500/30 flex items-center justify-between">
                        <div className="flex gap-2 items-center text-red-600 dark:text-red-400 text-xs">
                            <AlertCircle size={14}/> {scanError}
                        </div>
                        <button onClick={scanBlockchain} className="text-xs font-bold underline hover:text-red-800 dark:hover:text-red-300">Retry</button>
                    </div>
                )}
                {computedAddress && (
                    <div className={`p-4 rounded-lg border animate-in fade-in zoom-in duration-300 ${effectiveRecoveryMode ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-500/20' : 'bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10'}`}>
                        <div className="flex justify-between items-center mb-2">
                            <span className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1 ${effectiveRecoveryMode ? 'text-green-800 dark:text-green-400' : 'text-gray-500'}`}>
                                {effectiveRecoveryMode ? <><CheckCircle2 size={12}/> Account Found</> : "Your Future Bot Address"}
                            </span>
                            {effectiveRecoveryMode && <span className="bg-green-200 dark:bg-green-800 text-green-800 dark:text-green-200 text-[10px] px-2 py-0.5 rounded font-mono font-bold">READY</span>}
                        </div>
                        <div className="flex justify-between text-sm items-center">
                            <span className="text-gray-600 dark:text-gray-300 font-mono text-xs bg-white dark:bg-black/20 px-2 py-1 rounded select-all">{computedAddress}</span>
                            <span className="font-bold text-gray-900 dark:text-white flex items-center gap-1">
                                {parseFloat(existingBalance) > 0 ? <span className="w-2 h-2 rounded-full bg-green-500"></span> : <span className="w-2 h-2 rounded-full bg-gray-400"></span>}
                                ${existingBalance} USDC
                            </span>
                        </div>
                    </div>
                )}
                <div className="space-y-4">
                    <div className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-lg border border-gray-200 dark:border-white/5">
                        <CheckCircle2 size={16} className="text-green-500 mt-1" />
                        <div>
                            <span className="text-sm font-bold text-gray-900 dark:text-white">Lazy Activation</span>
                            <p className="text-xs text-gray-500">Account is created instantly. It activates on-chain automatically when you make your first deposit.</p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-lg border border-gray-200 dark:border-white/5">
                        <CheckCircle2 size={16} className="text-green-500 mt-1" />
                        <div>
                            <span className="text-sm font-bold text-gray-900 dark:text-white">Gas Abstraction</span>
                            <p className="text-xs text-gray-500">ZeroDev Smart Accounts handle gas optimization.</p>
                        </div>
                    </div>
                </div>
                {chainId !== 137 && !checking && (
                    <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-700/50 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <AlertTriangle size={16} className="text-yellow-600 dark:text-yellow-500"/>
                            <p className="text-xs text-yellow-700 dark:text-yellow-400 font-bold">Wrong Network Detected (Chain {chainId})</p>
                        </div>
                        <p className="text-[10px] text-yellow-700 dark:text-yellow-500/80 ml-6">
                            We need to scan Polygon to find your Smart Account.
                        </p>
                        <button 
                            onClick={() => web3Service.switchToChain(137)}
                            className="ml-6 w-fit px-3 py-1 bg-yellow-200 dark:bg-yellow-800 hover:bg-yellow-300 dark:hover:bg-yellow-700 text-yellow-900 dark:text-yellow-100 rounded text-xs font-bold transition-colors"
                        >
                            Switch to Polygon
                        </button>
                    </div>
                )}
                {!computedAddress && !checking && !scanError && (
                    <div className="flex justify-center">
                        <button onClick={scanBlockchain} className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1">
                            <Search size={12}/> {chainId === 137 ? "Re-scan for account" : "Connect to Polygon & Scan"}
                        </button>
                    </div>
                )}
                <button 
                    onClick={handleActivate}
                    disabled={isActivating || checking || (chainId !== 137 && computedAddress === '')}
                    className={`w-full py-3 px-2 sm:py-4 text-white font-bold rounded-xl hover:opacity-90 transition-all flex items-center justify-center gap-2 sm:gap-3 shadow-lg text-sm sm:text-base ${
                        effectiveRecoveryMode 
                        ? 'bg-gradient-to-r from-green-600 to-green-500 shadow-green-500/20' 
                        : 'bg-gradient-to-r from-blue-600 to-blue-500 shadow-blue-500/20'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                    {isActivating ? (
                        <RefreshCw className="animate-spin flex-shrink-0" size={18} />
                    ) : (
                        effectiveRecoveryMode ? <RefreshCw className="flex-shrink-0" size={18}/> : <Rocket className="flex-shrink-0" size={18} />
                    )}
                    <span className="whitespace-nowrap overflow-hidden text-ellipsis">
                        {isActivating ? 'PROCESSING...' : (effectiveRecoveryMode ? 'RESTORE SESSION & DATA' : 'CREATE ACCOUNT')}
                    </span>
                </button>
                
                <div className="flex flex-col items-center gap-2">
                    <p className="text-center text-[10px] text-gray-500">
                        {effectiveRecoveryMode 
                            ? "Re-syncs your database session with your existing on-chain Smart Account." 
                            : "Deploys a deterministic ZeroDev Kernel v3.1 account linked to your wallet."}
                    </p>
                    <button 
                        onClick={() => setShowSafetyGuide(true)} 
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 mt-1 font-medium"
                    >
                        <LockKeyhole size={12}/> Is my money safe? Read the Recovery Guide.
                    </button>
                    {computedAddress && (
                        <button 
                            onClick={() => setManualToggle(!manualToggle)} 
                            className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mt-2 underline"
                        >
                            Incorrect detection? Switch to {effectiveRecoveryMode ? 'Create' : 'Restore'} mode
                        </button>
                    )}
                </div>
            </div>

             {showSafetyGuide && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                    <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl max-w-2xl w-full p-6 relative shadow-2xl overflow-y-auto max-h-[90vh]">
                        <button onClick={() => setShowSafetyGuide(false)} className="absolute top-4 right-4 text-gray-500 hover:text-black dark:hover:text-white transition-colors"><X size={20}/></button>
                        <div className="flex items-center gap-3 mb-6 pb-4 border-b border-gray-200 dark:border-gray-800">
                            <div className="p-3 bg-green-100 dark:bg-green-900/20 rounded-full text-green-600 dark:text-green-500">
                                <Shield size={24}/>
                            </div>
                            <div>
                                <h3 className="text-xl font-bold text-gray-900 dark:text-white">Funds Safety & Recovery Guide</h3>
                                <p className="text-xs text-gray-500">How Account Abstraction protects your assets.</p>
                            </div>
                        </div>
                        <div className="space-y-6">
                            <div className="flex gap-4">
                                <div className="mt-1"><RefreshCw className="text-blue-500" size={20}/></div>
                                <div>
                                    <h4 className="text-sm font-bold text-gray-900 dark:text-white">Scenario 1: I switched devices or cleared my browser cache.</h4>
                                    <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                                        <strong>You lose nothing.</strong> Your Smart Account is mathematically derived from your main wallet (Metamask/Phantom). 
                                        Simply connect the same wallet on the new device. The system will detect your existing Smart Account on the blockchain 
                                        and button will change to <span className="text-green-600 dark:text-green-400 font-bold">"RESTORE SESSION"</span>. 
                                        Clicking it re-syncs your bot without touching your funds.
                                    </p>
                                </div>
                            </div>
                            <div className="flex gap-4">
                                <div className="mt-1"><Server className="text-orange-500" size={20}/></div>
                                <div>
                                    <h4 className="text-sm font-bold text-gray-900 dark:text-white">Scenario 2: The Bot Server crashes or Database is wiped.</h4>
                                    <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                                        <strong>Your funds are safe on Polygon.</strong> We do not hold your funds in our database. 
                                        The database only stores a "Session Key" (a permission slip to trade). If the database is wiped, 
                                        you simply click <span className="text-green-600 dark:text-green-400 font-bold">"RESTORE SESSION"</span> 
                                        to generate a new key. Your USDC balance remains on-chain and instantly reappears.
                                    </p>
                                </div>
                            </div>
                            <div className="flex gap-4">
                                <div className="mt-1"><Lock className="text-purple-500" size={20}/></div>
                                <div>
                                    <h4 className="text-sm font-bold text-gray-900 dark:text-white">Scenario 3: I want to withdraw, but the bot is offline.</h4>
                                    <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                                        <strong>You are the Owner.</strong> The Smart Account belongs to you. You can trigger a "Trustless Withdrawal" 
                                        from the dashboard at any time. This bypasses our server and talks directly to the blockchain to move funds 
                                        back to your main wallet. We cannot stop you from withdrawing.
                                    </p>
                                </div>
                            </div>
                        </div>
                        <div className="mt-8 pt-4 border-t border-gray-200 dark:border-gray-800 text-center">
                            <button 
                                onClick={() => setShowSafetyGuide(false)}
                                className="px-6 py-2 bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 text-gray-900 dark:text-white text-sm font-bold rounded-lg transition-colors"
                            >
                                I Understand, Let's Go
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const HeroBackground = () => {
  return (
    <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
       <div className="absolute inset-0 bg-grid-slate-200/[0.04] bg-[bottom_1px_center] dark:bg-grid-slate-800/[0.05]" style={{ backgroundSize: '40px 40px', maskImage: 'linear-gradient(to bottom, transparent 5%, black 40%, black 70%, transparent 95%)' }}></div>
    </div>
  )
}

const Landing = ({ onConnect, theme, toggleTheme }: { onConnect: () => void, theme: string, toggleTheme: () => void }) => (
    <div className="min-h-screen bg-gray-50 dark:bg-[#050505] font-sans transition-colors duration-300 flex flex-col relative overflow-x-hidden">
        
        <HeroBackground />

        <div className="absolute top-0 left-0 w-full p-6 flex justify-between items-center z-50 max-w-7xl mx-auto left-0 right-0">
             <div className="opacity-0"></div> 
             <button 
                onClick={toggleTheme} 
                className="p-3 bg-white/80 dark:bg-white/5 rounded-full hover:scale-110 transition-all shadow-sm backdrop-blur-md text-gray-600 dark:text-white border border-gray-200 dark:border-white/10"
             >
                {theme === 'light' ? <Moon size={18}/> : <Sun size={18}/>}
             </button>
         </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6 z-10 w-full max-w-7xl mx-auto relative min-h-[100vh]">
            
            <div className="text-center flex flex-col items-center">
                <div className="mb-8 relative mt-7">
                    <div className="absolute inset-0 bg-blue-500 blur-2xl opacity-20 rounded-full"></div>
                    <div className="relative w-20 h-20 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center shadow-xl shadow-blue-500/20">
                        <Activity size={40} className="text-white" />
                    </div>
                </div>

                <div className="mb-6 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-100">
                    <span className="px-4 py-1.5 rounded-full bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/50 text-blue-600 dark:text-blue-400 text-[10px] font-bold uppercase tracking-widest">
                        Account Abstraction V2 Live
                    </span>
                </div>

                <h1 className="text-5xl md:text-7xl font-black tracking-tight text-gray-900 dark:text-white mb-6 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200">
                    BET <span className="text-blue-600">MIRROR</span>
                </h1>

                <p className="text-lg text-gray-500 dark:text-gray-400 font-medium max-w-lg mx-auto leading-relaxed animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
                    The institutional-grade prediction market terminal.<br/>
                    Non-Custodial. AI-Powered. 24/7 Cloud Execution.
                </p>

                <div className="mt-12 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-400 w-full max-w-xs">
                    <button 
                        onClick={onConnect} 
                        className="w-full py-4 bg-gray-900 dark:bg-white text-white dark:text-black font-bold text-sm uppercase tracking-wider rounded-lg shadow-2xl hover:shadow-blue-500/10 hover:-translate-y-0.5 transition-all duration-300 flex items-center justify-center gap-3"
                    >
                        <Wallet size={18} /> Connect Terminal
                    </button>
                </div>

                <div className="mt-12 flex gap-8 opacity-40 animate-in fade-in duration-1000 delay-500">
                    <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                        <Shield size={12}/> Secure
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                        <ZapIcon size={12}/> Fast
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                        <Globe size={12}/> Global
                    </div>
                </div>

                <div className="mt-32 flex flex-col items-center gap-6 animate-in fade-in duration-1000 delay-700">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-[0.3em] opacity-50">
                        SUPPORTED CHAINS
                    </p>
                    <div className="flex gap-12 opacity-30 grayscale hover:grayscale-0 hover:opacity-100 transition-all duration-500">
                        <img src="https://cryptologos.cc/logos/polygon-matic-logo.svg?v=026" alt="Polygon" className="h-5 w-auto" />
                        <img src="https://cryptologos.cc/logos/ethereum-eth-logo.svg?v=026" alt="Ethereum" className="h-5 w-auto" />
                        <img src="https://cdn.brandfetch.io/id6XsSOVVS/theme/dark/logo.svg?c=1bxid64Mup7aczewSAYMX&t=1757929765938" alt="Base" className="h-5 w-auto" />
                        <img src="https://cryptologos.cc/logos/arbitrum-arb-logo.svg?v=026" alt="Arbitrum" className="h-5 w-auto" />
                        <img src="https://cryptologos.cc/logos/solana-sol-logo.svg?v=026" alt="Solana" className="h-4 w-auto mt-0.5" />
                    </div>
                </div>
             </div>
            
            <div className="absolute bottom-12 left-1/2 -translate-x-1/2 animate-bounce opacity-20">
                <ChevronDown className="text-gray-400 w-6 h-6"/>
            </div>

        </div>

        <div className="w-full bg-gray-100 dark:bg-[#030303] border-t border-gray-200 dark:border-white/5 relative z-20">
            
            <div className="max-w-5xl mx-auto py-32 px-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
                    
                    <div className="p-10 rounded-3xl bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-white/10 shadow-lg hover:shadow-xl transition-all duration-300 group hover:-translate-y-1">
                        <div className="flex items-center gap-3 mb-8">
                            <span className="relative flex h-2.5 w-2.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
                            </span>
                            <span className="text-[10px] font-bold text-green-600 dark:text-green-400 uppercase tracking-wider">Live Integration</span>
                        </div>
                        <div className="flex items-center gap-5 mb-6">
                            {/* REPLACED BROKEN POLYMARKET LOGO WITH LOCAL POLYGON LOGO */}
                            <img src="https://cryptologos.cc/logos/polygon-matic-logo.svg?v=026" alt="Polymarket" className="w-14 h-14 rounded-full" referrerPolicy="no-referrer" />
                            <h3 className="text-3xl font-black text-gray-900 dark:text-white tracking-tight">Polymarket</h3>
                        </div>
                        <p className="text-base text-gray-500 dark:text-gray-400 font-medium leading-relaxed mb-6">
                            The most active market for blockchain wallets trading. Copy any top trader instantly.
                        </p>
                        <div className="inline-flex items-center gap-2 text-xs font-bold text-blue-600 dark:text-blue-500 uppercase tracking-wider group-hover:translate-x-1 transition-transform">
                            Start Copying <ArrowRightLeft size={12}/>
                        </div>
                    </div>

                    <div className="p-10 rounded-3xl bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/5 opacity-60 hover:opacity-100 transition-all duration-300 group">
                        <div className="flex items-center gap-3 mb-8">
                            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500"></span>
                            <span className="text-[10px] font-bold text-yellow-600 dark:text-yellow-500 uppercase tracking-wider">Coming Soon</span>
                        </div>
                        <div className="flex items-center gap-5 mb-6">
                             <div className="w-14 h-14 rounded-full bg-gray-200 dark:bg-gray-800 flex items-center justify-center font-bold text-gray-500 text-2xl">pb</div>
                            <h3 className="text-3xl font-black text-gray-900 dark:text-white tracking-tight">PredictBase</h3>
                        </div>
                        <p className="text-base text-gray-500 dark:text-gray-400 font-medium leading-relaxed">
                            Next-generation sports & crypto markets with high-frequency liquidity.
                        </p>
                    </div>

                </div>

                <div className="pt-24 flex justify-center">
                    <div className="inline-flex flex-col items-center gap-4 group cursor-pointer opacity-60 hover:opacity-100 transition-opacity">
                        <div className="p-4 rounded-full bg-white dark:bg-white/10 border border-gray-200 dark:border-white/10 text-gray-400 group-hover:text-blue-500 group-hover:border-blue-200 transition-all">
                            <MousePointerClick size={24} />
                        </div>
                        <p className="text-xs font-bold text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors uppercase tracking-widest">
                            Suggest a market integration
                        </p>
                    </div>
                </div>
            </div>

            <div className="w-full max-w-7xl mx-auto pb-32 px-6 border-t border-gray-200 dark:border-white/5 pt-32">
                <div className="text-center mb-24">
                    <span className="text-blue-600 dark:text-blue-500 text-xs font-bold uppercase tracking-widest">Architecture</span>
                    <h2 className="text-4xl md:text-5xl font-black text-gray-900 dark:text-white mt-4 tracking-tight">How It Works</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
                    <div className="p-10 bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-white/10 rounded-[2rem] hover:border-blue-500/30 transition-all shadow-sm group">
                        <div className="w-16 h-16 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-2xl flex items-center justify-center mb-8 group-hover:scale-110 transition-transform">
                            <Wallet size={32}/>
                        </div>
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">1. Connect & Deploy</h3>
                        <p className="text-gray-500 text-sm leading-relaxed">
                            Link your wallet. We instantly deploy a non-custodial <strong>Smart Account</strong> (ZeroDev Kernel) on Polygon. This is your dedicated trading vault.
                        </p>
                    </div>

                    <div className="p-10 bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-white/10 rounded-[2rem] hover:border-purple-500/30 transition-all shadow-sm group">
                        <div className="w-16 h-16 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 rounded-2xl flex items-center justify-center mb-8 group-hover:scale-110 transition-transform">
                            <Key size={32}/>
                        </div>
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">2. Total Control</h3>
                        <p className="text-gray-500 text-sm leading-relaxed">
                            You hold the "Owner Key". You can revoke our trading permissions or trigger a <strong>trustless withdrawal</strong> directly on the blockchain at any time.
                        </p>
                    </div>

                    <div className="p-10 bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-white/10 rounded-[2rem] hover:border-green-500/30 transition-all shadow-sm group">
                        <div className="w-16 h-16 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 rounded-2xl flex items-center justify-center mb-8 group-hover:scale-110 transition-transform">
                            <Server size={32}/>
                        </div>
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">3. Passive Alpha</h3>
                        <p className="text-gray-500 text-sm leading-relaxed">
                            Find the best trader in the Registry and hit Copy. Our Node.js engine monitors signals 24/7 so you can <strong>earn while you sleep</strong>.
                        </p>
                    </div>
                </div>
            </div>

            <footer className="border-t border-gray-200 dark:border-white/5 bg-white dark:bg-[#020202]">
                <div className="max-w-7xl mx-auto px-6 py-12 flex flex-col md:flex-row justify-between items-center gap-6">
                    <div className="flex items-center gap-2 opacity-50 hover:opacity-100 transition-opacity">
                        <Activity size={16} className="text-blue-600 dark:text-white"/>
                        <span className="text-xs font-bold text-gray-900 dark:text-white tracking-widest">BET MIRROR PRO</span>
                    </div>
                    
                    <div className="flex gap-6">
                        <a href="/pitchdeck.pdf" target="_blank" className="text-gray-500 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2 text-xs font-medium">
                            <FileText size={16}/> Pitch Deck
                        </a>
                        <a href="https://docs.betmirror.bet" target="_blank" className="text-gray-500 hover:text-blue-600 dark:hover:text-white transition-colors">
                            <BookOpen size={16}/>
                        </a>
                        <a href="https://github.com/vchat-meme-blip/betmirror" target="_blank" className="text-gray-500 hover:text-blue-600 dark:hover:text-white transition-colors">
                            <Github size={16}/>
                        </a>
                        <a href="https://x.com/bet_mirror" target="_blank" className="text-gray-500 hover:text-blue-600 dark:hover:text-white transition-colors">
                            <Twitter size={16}/>
                        </a>
                    </div>

                    <div className="text-[10px] text-gray-400 font-medium">
                        © 2025 PolyCafe Labs. All rights reserved.
                    </div>
                </div>
            </footer>

        </div>

    </div>
);

const App = () => {
  // --- STATE: Web3 & Session ---
  const [isConnected, setIsConnected] = useState(false);
  const [needsActivation, setNeedsActivation] = useState(false);
  const [userAddress, setUserAddress] = useState<string>('');
  const [chainId, setChainId] = useState<number>(137);
  
  const [proxyAddress, setProxyAddress] = useState<string>('');
  const [proxyType, setProxyType] = useState<'SMART_ACCOUNT'>('SMART_ACCOUNT'); // Strictly Smart Account
  
  // --- STATE: Balances ---
  const [mainWalletBal, setMainWalletBal] = useState<WalletBalances>({ native: '0.00', usdc: '0.00', usdcNative: '0.00', usdcBridged: '0.00' });
  const [proxyWalletBal, setProxyWalletBal] = useState<WalletBalances>({ native: '0.00', usdc: '0.00', usdcNative: '0.00', usdcBridged: '0.00' });

  // --- STATE: UI & Data ---
  const [activeTab, setActiveTab] = useState<'dashboard' | 'marketplace' | 'history' | 'vault' | 'bridge' | 'system' | 'help'>('dashboard');
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const [history, setHistory] = useState<TradeHistoryEntry[]>([]);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [registry, setRegistry] = useState<TraderProfile[]>([]);
  const [systemStats, setSystemStats] = useState<GlobalStatsResponse | null>(null);
  const [bridgeHistory, setBridgeHistory] = useState<BridgeTransactionRecord[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [systemView, setSystemView] = useState<'attribution' | 'global'>('attribution');
  // -- MOBILE MENU STATE --
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  
  // --- STATE: Forms & Actions ---
  const [isDepositing, setIsDepositing] = useState(false);
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false); // New Modal State
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState(false);
  const [withdrawalTxHash, setWithdrawalTxHash] = useState<string | null>(null); // New State for Success UI

  const [isActivating, setIsActivating] = useState(false);
  const [targetInput, setTargetInput] = useState('');
  const [newWalletInput, setNewWalletInput] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);
  const [isAddingWallet, setIsAddingWallet] = useState(false);
  const [showArchitecture, setShowArchitecture] = useState(false);
  const [selectedTrader, setSelectedTrader] = useState<TraderProfile | null>(null);
  
  // --- STATE: Bridging (Updated for Bidirectional Flow) ---
  const [bridgeMode, setBridgeMode] = useState<'IN' | 'OUT'>('IN');
  const [selectedSourceChain, setSelectedSourceChain] = useState<number>(8453); // Default Base for IN
  const [selectedDestChain, setSelectedDestChain] = useState<number>(137); // Default Polygon for IN
  const [bridgeToken, setBridgeToken] = useState<'NATIVE' | 'USDC' | 'USDC.e'>('NATIVE'); // Native, USDC, or Bridged USDC
  const [destToken, setDestToken] = useState<'USDC' | 'NATIVE'>('USDC'); // New state for destination preference
  const [bridgeAmount, setBridgeAmount] = useState('0.1');
  const [bridgeQuote, setBridgeQuote] = useState<any>(null);
  const [isBridging, setIsBridging] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<string>('');
  const [senderAddressDisplay, setSenderAddressDisplay] = useState<string>('');
  const [recipientAddress, setRecipientAddress] = useState<string>(''); // Editable recipient
  const [isSourceChainSelectOpen, setIsSourceChainSelectOpen] = useState(false);
  const [isDestChainSelectOpen, setIsDestChainSelectOpen] = useState(false);
  const [showBridgeGuide, setShowBridgeGuide] = useState(false);

  const [config, setConfig] = useState<AppConfig>({
    targets: [],
    rpcUrl: 'https://little-thrilling-layer.matic.quiknode.pro/378fe82ae3cb5d38e4ac79c202990ad508e1c4c6',
    geminiApiKey: '',
    multiplier: 1.0,
    riskProfile: 'balanced',
    autoTp: 20,
    enableNotifications: false,
    userPhoneNumber: '',
    enableAutoCashout: false,
    maxRetentionAmount: 50,
    coldWalletAddress: '',
    enableSounds: true
  });

  // --- REFS for Debouncing ---
  const quoteDebounceTimer = useRef<any>(null);

  // Helper to update state AND local storage simultaneously
  const updateConfig = (newConfig: AppConfig) => {
      setConfig(newConfig);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig));
  };

  // --- LOAD LOCAL CONFIG & THEME ---
  useEffect(() => {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
          try {
              const parsed = JSON.parse(saved);
              setConfig(prev => ({ ...prev, ...parsed }));
          } catch (e) {
              console.error("Failed to load local config", e);
          }
      }

      // Theme Loader
      const savedTheme = localStorage.getItem('theme') as 'light' | 'dark';
      if (savedTheme) {
          setTheme(savedTheme);
      }
  }, []);

  useEffect(() => {
      if(userAddress) {
          lifiService.setUserId(userAddress);
          lifiService.fetchHistory().then(setBridgeHistory);
          setSenderAddressDisplay(userAddress); // Default to connected address
          
          // Initialize recipient based on mode if empty
          if (!recipientAddress) {
             if (bridgeMode === 'IN') setRecipientAddress(proxyAddress || userAddress); // Prefer proxy for deposit
             else setRecipientAddress(userAddress); // Withdraw to main
          }
      }
  }, [userAddress, proxyAddress, bridgeMode]);

  // Show Bridge Guide on first visit if balances are low
  useEffect(() => {
     if (activeTab === 'bridge' && parseFloat(proxyWalletBal.native) < 0.01 && parseFloat(proxyWalletBal.usdc) < 5) {
         // Check if user has dismissed it before
         if (!localStorage.getItem('bridge_guide_dismissed')) {
             setShowBridgeGuide(true);
         }
     }
  }, [activeTab, proxyWalletBal]);

  // --- AUTO-UPDATE BRIDGE QUOTE LOGIC ---
  // Trigger quote update when these dependencies change, with debounce
  useEffect(() => {
      if (activeTab === 'bridge' && recipientAddress && bridgeAmount && parseFloat(bridgeAmount) > 0) {
          // Clear existing timer
          if (quoteDebounceTimer.current) clearTimeout(quoteDebounceTimer.current);
          
          // Clear previous quote immediately to indicate loading/stale
          setBridgeQuote(null);

          // Set new timer (800ms debounce)
          quoteDebounceTimer.current = setTimeout(() => {
              handleGetBridgeQuote();
          }, 800);
      } else {
          setBridgeQuote(null);
      }
      
      return () => {
          if(quoteDebounceTimer.current) clearTimeout(quoteDebounceTimer.current);
      };
  }, [bridgeAmount, selectedSourceChain, selectedDestChain, bridgeToken, destToken, recipientAddress, activeTab]);

    // --- SMART NETWORK SWITCHING ---
  // 1. Auto-switch to Polygon when leaving Bridge Page or accessing critical features
  useEffect(() => {
    if (isConnected && activeTab !== 'bridge' && chainId !== 137) {
         // Silent switch attempt for better UX
         web3Service.switchToChain(137).catch(console.error);
    }
  }, [activeTab, isConnected, chainId]);

  // 2. Auto-switch to Polygon when Bridge Mode is OUT (Source is Polygon)
  useEffect(() => {
    if (isConnected && activeTab === 'bridge' && bridgeMode === 'OUT' && chainId !== 137) {
         web3Service.switchToChain(137).catch(console.error);
    }
  }, [bridgeMode, activeTab, isConnected, chainId]);

  // Apply Theme Class
  useEffect(() => {
      const root = document.documentElement;
      if (theme === 'dark') {
          root.classList.add('dark');
      } else {
          root.classList.remove('dark');
      }
      localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
      setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  // Helper
  const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text);
      alert("Copied to clipboard!");
  };

  // --- POLL DATA ---
  useEffect(() => {
    if (!isConnected || !userAddress || needsActivation) return;
    
    // Poll Server State
    const interval = setInterval(async () => {
        try {
            const res = await axios.get(`/api/bot/status/${userAddress}`);
            setIsRunning(res.data.isRunning);
            
            // Check for new logs/trades to play sound
            if (res.data.history && res.data.history.length > history.length && config.enableSounds) {
                playSound('trade');
            }

            if (res.data.logs) setLogs(res.data.logs); // Now fetches from DB
            if (res.data.history) setHistory(res.data.history);
            if (res.data.stats) setStats(res.data.stats);

            // Sync Config from Server ONLY IF RUNNING (Source of Truth)
            // If stopped, local state is king (allows editing without overwrite)
            if (res.data.isRunning && res.data.config) {
                 const serverConfig = res.data.config;
                 setConfig(prev => ({
                     ...prev,
                     targets: serverConfig.userAddresses || [],
                     rpcUrl: serverConfig.rpcUrl,
                     geminiApiKey: serverConfig.geminiApiKey || prev.geminiApiKey,
                     multiplier: serverConfig.multiplier,
                     riskProfile: serverConfig.riskProfile,
                     autoTp: serverConfig.autoTp,
                     enableNotifications: serverConfig.enableNotifications,
                     userPhoneNumber: serverConfig.userPhoneNumber,
                     enableAutoCashout: serverConfig.autoCashout?.enabled,
                     maxRetentionAmount: serverConfig.autoCashout?.maxAmount,
                     coldWalletAddress: serverConfig.autoCashout?.destinationAddress
                 }));
            }

            if (activeTab === 'system') {
                const sysRes = await axios.get('/api/stats/global');
                setSystemStats(sysRes.data);
            }
        } catch (e) {
            // Silent fail on poll
        }
    }, 2000);
    
    // Poll Balances (Every 10s)
    const balanceInterval = setInterval(fetchBalances, 10000);
    fetchBalances(); // Initial

    return () => {
        clearInterval(interval);
        clearInterval(balanceInterval);
    };
  }, [isConnected, userAddress, proxyAddress, needsActivation, activeTab, history.length, config.enableSounds]);

  useEffect(() => {
      if(isConnected && !needsActivation) fetchRegistry();
  }, [isConnected, needsActivation]);

  // --- HELPER: Fetch Balances ---
  const fetchBalances = async () => {
      if (!userAddress || !(window as any).ethereum) return;
      try {
          const provider = new BrowserProvider((window as any).ethereum);
          const network = await provider.getNetwork();
          const currentChain = Number(network.chainId);
          setChainId(currentChain);

          // 1. Main Wallet (Native)
          // Always use injected provider for main wallet
          const balMain = await provider.getBalance(userAddress);
          let mainUsdcNative = '0.00';
          let mainUsdcBridged = '0.00';
          
          // 2. Main Wallet (USDC)
          if (currentChain === 137) {
              // Polygon: Check both Native and Bridged
              try {
                const usdcNativeContract = new Contract(USDC_POLYGON, USDC_ABI, provider);
                mainUsdcNative = formatUnits(await usdcNativeContract.balanceOf(userAddress), 6);
              } catch(e) {}
              
              try {
                const usdcBridgedContract = new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, provider);
                mainUsdcBridged = formatUnits(await usdcBridgedContract.balanceOf(userAddress), 6);
              } catch(e) {}
          } else {
              // ... (Other chains logic) ...
               const USDC_ADDRS: Record<number, string> = {
                  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
                  42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
                  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                  56: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
              };
              if (USDC_ADDRS[currentChain]) {
                  try {
                      const c = new Contract(USDC_ADDRS[currentChain], USDC_ABI, provider);
                      mainUsdcNative = formatUnits(await c.balanceOf(userAddress), 6);
                  } catch (e) {}
              }
          }

          setMainWalletBal({ 
              native: parseFloat(formatUnits(balMain, 18)).toFixed(4), 
              usdc: mainUsdcNative,
              usdcNative: mainUsdcNative,
              usdcBridged: mainUsdcBridged
          });
          
          // 3. Proxy Wallet Balances
          if (proxyAddress) {
              // SMART PROVIDER SWITCHING:
              // If user is on Polygon (137), use their injected provider (fast/reliable).
              // If not, use the fallback public RPC.
              let readProvider: Provider;
              // Prefer custom RPC if set, otherwise use BrowserProvider if on Polygon, otherwise Fallback Public
              if (config.rpcUrl && config.rpcUrl.startsWith('http')) {
                  readProvider = new JsonRpcProvider(config.rpcUrl);
              } else if (currentChain === 137) {
                   readProvider = new BrowserProvider((window as any).ethereum);
              } else {
                   readProvider = new JsonRpcProvider('https://little-thrilling-layer.matic.quiknode.pro/378fe82ae3cb5d38e4ac79c202990ad508e1c4c6');
              }
              
              // Helper to safely fetch balance without crashing all
              const safeBalance = async (call: () => Promise<bigint>): Promise<bigint> => {
                  try { return await call(); } catch(e) { return BigInt(0); }
              };

              const [polyBal, usdcBridgedBal, usdcNativeBal] = await Promise.all([
                  safeBalance(() => readProvider.getBalance(proxyAddress)),
                  safeBalance(() => new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, readProvider).balanceOf(proxyAddress)),
                  safeBalance(() => new Contract(USDC_POLYGON, USDC_ABI, readProvider).balanceOf(proxyAddress))
              ]);
              
              setProxyWalletBal({
                  native: formatUnits(polyBal, 18).slice(0,6),
                  usdc: parseFloat(formatUnits(usdcBridgedBal, 6)).toFixed(2),
                  usdcNative: parseFloat(formatUnits(usdcNativeBal, 6)).toFixed(2),
                  usdcBridged: parseFloat(formatUnits(usdcBridgedBal, 6)).toFixed(2)
              });
          }
      } catch (e) {
          console.warn("Balance fetch error:", e);
      }
  };

  const fetchRegistry = async () => {
      try {
          const res = await axios.get('/api/registry');
          setRegistry(res.data);
      } catch (e) {}
  };

  const saveConfig = () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      alert("Configuration Saved Locally");
  };

  const clearLogs = () => setLogs([]);

  // --- HANDLERS: Auth ---
  const handleConnect = async () => {
      try {
          // Connects and auto-switches to Polygon if needed
          const addr = await web3Service.connect();
          
          setUserAddress(addr);
          setConfig(prev => ({...prev, coldWalletAddress: prev.coldWalletAddress || addr })); 
          
          lifiService.setUserId(addr);

          // Check Status on Server
          const res = await axios.post('/api/wallet/status', { userId: addr });
          
          if (res.data.status === 'NEEDS_ACTIVATION') {
              setNeedsActivation(true);
              setIsConnected(true);
          } else {
              setProxyAddress(res.data.address);
              setProxyType('SMART_ACCOUNT');
              setNeedsActivation(false);
              setIsConnected(true);
          }
      } catch (e: any) {
          alert(e.message || "Failed to connect. Please ensure you have a wallet installed.");
      }
  };

  // --- HANDLERS: Smart Account Activation ---
  const handleActivateSmartAccount = async () => {
     setIsActivating(true);
     try {
         // CRITICAL FIX: Ensure chain is Polygon before interaction
         const walletClient = await web3Service.getViemWalletClient(137);
         
         // Instantiate ZeroDev service locally
         const zeroDevService = new ZeroDevService(process.env.ZERODEV_RPC || 'https://rpc.zerodev.app/api/v2/bundler/PROJECT_ID');

         // 1. Create Session Key Client Side
         const session = await zeroDevService.createSessionKeyForServer(walletClient, userAddress);
         
         // 2. Register on Server
         const res = await axios.post('/api/wallet/activate', { 
             userId: userAddress, 
             serializedSessionKey: session.serializedSessionKey,
             smartAccountAddress: session.smartAccountAddress
         });

         setProxyAddress(res.data.address);
         setProxyType('SMART_ACCOUNT');
         setNeedsActivation(false);
         
         // Show enhanced guidance for the lazy activation
         alert("✅ Smart Account Created!\n\nImportant: Your bot will fully initialize on-chain after you make your first deposit.");

     } catch (e: any) {
         console.error(e);
         // Nicer error handling for chain mismatch or user rejection
         if(e.message?.includes('Chain') || e.message?.includes('Provider') || e.message?.includes('network')) {
             alert("⚠️ Network Mismatch\n\nPlease open your wallet and manually switch the network to Polygon Mainnet (Chain ID 137) before trying again.");
         } else {
             // Show actual server error
             alert("Activation failed: " + (e.response?.data?.error || e.message));
         }
     } finally {
         setIsActivating(false);
     }
  };

  // --- HANDLERS: Money & Bridge ---
  // DEPRECATED: Inline input handler
  // const handleDepositClick = async () => { ... };

  // NEW: Open Deposit Modal
  const openDepositModal = () => {
      // Ensure we are on Polygon to see accurate balances for deposit
      // (Non-blocking check)
      if (chainId !== 137) {
         web3Service.switchToChain(137).catch(console.error);
      }
      fetchBalances(); // Refresh balances
      setIsDepositModalOpen(true);
  };
  
  const handleDeposit = async (amount: string, tokenType: 'USDC.e' | 'USDC' | 'POL') => {
      if (!proxyAddress) return;
      
      setIsDepositing(true);
      try {
          let txHash = '';
          
          if (tokenType === 'POL') {
             txHash = await web3Service.depositNative(proxyAddress, amount);
          } else {
             // Determine Token Address based on selection
             const tokenAddr = tokenType === 'USDC.e' ? USDC_BRIDGED_POLYGON : USDC_POLYGON;
             txHash = await web3Service.depositErc20(proxyAddress, amount, tokenAddr);
          }

          alert("✅ Deposit Sent! Funds will arrive in your Smart Vault shortly.");
          setIsDepositModalOpen(false);
          
          // Record for Stats
          try {
             await axios.post('/api/deposit/record', { userId: userAddress, amount: parseFloat(amount), txHash });
          } catch(ignore){}
          
      } catch (e: any) {
          console.error(e);
          if (e.message.includes('insufficient') || e.message.includes('balance')) {
              alert("Deposit Failed: Insufficient funds.");
          } else {
              alert(`Deposit Failed: ${e.message}`);
          }
      } finally {
          setIsDepositing(false);
      }
  };

  // --- UPDATED: Bridge Handlers ---

  // Helper to get display balance for Source Card
  const getSourceBalance = () => {
      // Solana Special Case
      if (selectedSourceChain === 1151111081099710) {
          return "Check Phantom"; 
      }

      // If Chain Mismatch (e.g. selected Base but connected to Polygon)
      if (chainId !== selectedSourceChain) {
          return "Switch Chain";
      }

      // Mapping
      if (bridgeToken === 'NATIVE') return mainWalletBal.native;
      if (bridgeToken === 'USDC') return mainWalletBal.usdcNative;
      if (bridgeToken === 'USDC.e') return mainWalletBal.usdcBridged;
      
      return '0.00';
  };

  const handleSwapDirection = () => {
      if (bridgeMode === 'IN') {
          setBridgeMode('OUT');
          // Swap chains
          const oldSource = selectedSourceChain;
          setSelectedSourceChain(137); // Source is now Polygon
          setSelectedDestChain(oldSource === 137 ? 8453 : oldSource); // Dest is old source (or Base default)
          
          // Swap Tokens logic
          // If user selected NATIVE (POL) out, we keep it native. 
          // If they wanted USDC in, we likely want USDC out.
          setBridgeToken(destToken === 'NATIVE' ? 'NATIVE' : 'USDC.e');

          // Update Recipient
          setRecipientAddress(userAddress); // Default to main wallet on other chain
      } else {
          setBridgeMode('IN');
          const oldDest = selectedDestChain;
          setSelectedSourceChain(oldDest === 137 ? 8453 : oldDest); // Source is old dest
          setSelectedDestChain(137); // Dest is now Polygon
          
          // If sending Native (POL) out, they likely want Native (ETH) back on source
          // If sending USDC.e out, they likely want USDC in.
          setDestToken(bridgeToken === 'NATIVE' ? 'NATIVE' : 'USDC');
          
          // Default to Proxy Address for deposit, fallback to main wallet if not set
          setRecipientAddress(proxyAddress || userAddress);
      }
  };

  const handleGetBridgeQuote = async () => {
      if (!bridgeAmount || !recipientAddress) return;
      setBridgeQuote(null);
      try {
          let senderAddress = userAddress;
          
          // FIX: Special Handling for Solana
          if (selectedSourceChain === 1151111081099710) {
              try {
                  const solAddress = await web3Service.getSolanaAddress();
                  if(!solAddress) throw new Error("Could not retrieve Solana address. Please unlock your Phantom/Backpack wallet.");
                  senderAddress = solAddress;
                  setSenderAddressDisplay(solAddress);
              } catch (solError: any) {
                  alert("To bridge from Solana, please ensure you have a Solana wallet (Phantom/Backpack) installed and unlocked.");
                  return;
              }
          } else {
              // For EVM chains, we use the connected 0x address
              setSenderAddressDisplay(userAddress);
          }

          const fromToken = lifiService.getTokenAddress(selectedSourceChain, bridgeToken as any);
          
          let decimals = 18;
          if (bridgeToken.includes('USDC')) decimals = 6;
          if (bridgeToken === 'NATIVE' && selectedSourceChain === 1151111081099710) decimals = 9; 

          const rawAmount = (Number(bridgeAmount) * Math.pow(10, decimals)).toString();

          // Determine Dest Token Address based on Dest Chain
          // If going to Polygon (IN), check user preference for Native POL or Bridged USDC.e
          let toTokenAddress;
          if (selectedDestChain === 137) {
              if (destToken === 'NATIVE') {
                  toTokenAddress = '0x0000000000000000000000000000000000000000'; // POL
              } else {
                  toTokenAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e on Polygon
              }
          } else {
              // If going OUT, we want USDC on target chain unless specified otherwise (future enhancement)
              toTokenAddress = lifiService.getTokenAddress(selectedDestChain, 'USDC'); 
          }
          
          const routes = await lifiService.getRoute({
              fromChainId: selectedSourceChain,
              fromTokenAddress: fromToken, 
              fromAmount: rawAmount, 
              fromAddress: senderAddress, 
              toChainId: selectedDestChain,
              toTokenAddress: toTokenAddress,
              toAddress: recipientAddress
          });
          
          if(routes && routes.length > 0) {
              setBridgeQuote(routes[0]);
          } else {
              // Silent error or UI feedback?
          }
      } catch (e: any) {
          alert("Failed to get quote: " + e.message);
      }
  };

  const handleExecuteBridge = async () => {
      if (!bridgeQuote) return;
      setIsBridging(true);
      setBridgeStatus('Initiating Bridge...');
      try {
          await lifiService.executeBridge(bridgeQuote, (status, step) => {
              console.log(status, step);
              setBridgeStatus(status);
          });
          
          if (config.enableSounds) playSound('cashout'); // Sound on bridge success
          
          alert("✅ Bridging Complete! Funds are on the way.");
          setBridgeQuote(null);
          lifiService.fetchHistory().then(setBridgeHistory);
      } catch (e: any) {
          console.error(e);
          let msg = e.message || "Unknown Error";
          if (msg.includes("403") || msg.includes("simulation")) {
              msg = "Transaction failed simulation. \n\nPOSSIBLE CAUSES:\n1. Insufficient Gas/Rent.\n2. Slippage too low.\n3. Network congestion.";
          }
          alert("Bridge Failed: " + msg);
      } finally {
          setIsBridging(false);
          setBridgeStatus('');
      }
  };

    // --- UPDATED: Withdrawal Modal Handler ---
  const openWithdrawModal = async () => {
      setWithdrawalTxHash(null); // Reset state
      
      // FORCE NETWORK CHECK: Must be on Polygon to withdraw from Smart Account
      if (chainId !== 137) {
          try {
              await web3Service.switchToChain(137);
          } catch (e) {
              alert("Please switch to Polygon Mainnet to withdraw funds.");
              return; 
          }
      }
      
      setIsWithdrawModalOpen(true);
      
      // FORCE REFRESH: Update balances immediately with new provider context
      setTimeout(() => {
          fetchBalances();
      }, 500);
  };

  const handleWithdraw = async (tokenType: 'USDC' | 'USDC.e' | 'POL') => {
      if(!confirm(`Are you sure you want to withdraw ALL ${tokenType}?`)) return;
      setIsWithdrawing(true);

      try {
         // Auto-switch to Polygon required for managing the Kernel account
         const walletClient = await web3Service.getViemWalletClient(137);
         
         // Create Dynamic ZeroDev Service (using config/env if available)
         const zeroDev = new ZeroDevService(process.env.ZERODEV_RPC || 'https://rpc.zerodev.app/api/v2/bundler/PROJECT_ID');
         
         // --- CRITICAL FIX: Fetch LIVE BALANCE to ensure 100% accuracy ---
         const provider = new BrowserProvider((window as any).ethereum);
         let withdrawAmount = BigInt(0);
         let tokenAddress = USDC_POLYGON; // Default to something valid

         if (tokenType === 'USDC.e') {
             tokenAddress = USDC_BRIDGED_POLYGON;
             const contract = new Contract(tokenAddress, USDC_ABI, provider);
             withdrawAmount = await contract.balanceOf(proxyAddress); 
         } else if (tokenType === 'USDC') {
             tokenAddress = USDC_POLYGON; 
             const contract = new Contract(tokenAddress, USDC_ABI, provider);
             withdrawAmount = await contract.balanceOf(proxyAddress);
         } else if (tokenType === 'POL') {
             tokenAddress = '0x0000000000000000000000000000000000000000'; 
             withdrawAmount = await provider.getBalance(proxyAddress); 
         }
         
         if (withdrawAmount <= BigInt(0)) {
             alert("Balance is 0. Nothing to withdraw.");
             setIsWithdrawing(false);
             return;
         }

         // No alert needed, the wallet popup is self-explanatory
         
         const txHash = await zeroDev.withdrawFunds(
             walletClient,
             proxyAddress,
             userAddress,
             withdrawAmount,
             tokenAddress
         );
         
         if (config.enableSounds) playSound('cashout');
         
         // SHOW SUCCESS STATE IN MODAL instead of closing
         setWithdrawalTxHash(txHash);

      } catch (e: any) {
         console.error(e);
         alert("Withdrawal Failed: " + e.message);
      }
      setIsWithdrawing(false);
  };

  // --- HANDLERS: Bot ---
  const handleStart = async () => {
      if (config.targets.length === 0) {
          alert("Please add at least one Target Wallet in the Vault tab.");
          setActiveTab('vault');
          return;
      }
      
      if (config.enableSounds) playSound('start');

      const payload = {
          userId: userAddress,
          userAddresses: config.targets,
          rpcUrl: config.rpcUrl,
          geminiApiKey: config.geminiApiKey,
          multiplier: config.multiplier,
          riskProfile: config.riskProfile,
          autoTp: config.autoTp,
          notifications: {
              enabled: config.enableNotifications,
              phoneNumber: config.userPhoneNumber
          },
          autoCashout: {
              enabled: config.enableAutoCashout,
              maxRetentionAmount: config.maxRetentionAmount,
              destinationAddress: config.coldWalletAddress || userAddress
          }
      };

      try {
          await axios.post('/api/bot/start', payload);
          setIsRunning(true);
          setActiveTab('dashboard');
      } catch (e: any) {
          alert(`Start Failed: ${e.response?.data?.error || e.message}`);
      }
  };

  const handleStop = async () => {
      if (config.enableSounds) playSound('stop');
      try {
          await axios.post('/api/bot/stop', { userId: userAddress });
          setIsRunning(false);
      } catch (e) { console.error(e); }
  };

  const handleRevoke = async () => {
      if(!confirm("REVOKE TRADING?\nThis will clear the trading session on the server.")) return;
      try {
          await axios.post('/api/bot/revoke', { userId: userAddress });
          alert("Session Revoked. Bot stopped.");
      } catch (e: any) {
          alert(`Revoke Failed: ${e.response?.data?.error}`);
      }
  };

  const addTarget = () => {
      if (!targetInput.startsWith('0x')) return alert("Invalid Address");
      if (!config.targets.includes(targetInput)) {
          updateConfig({ ...config, targets: [...config.targets, targetInput] });
      }
      setTargetInput('');
  };

  const removeTarget = (t: string) => {
      updateConfig({ ...config, targets: config.targets.filter(x => x !== t) });
  };
  
  const copyFromMarketplace = (address: string) => {
      if (!config.targets.includes(address)) {
          updateConfig({ ...config, targets: [...config.targets, address] });
          alert(`Added ${address.slice(0,6)}... to Vault Targets.`);
      } else {
          alert("Already copying this wallet.");
      }
  };

  const addMarketplaceWallet = async () => {
      if(!newWalletInput.startsWith('0x')) return alert("Invalid Address");
      setIsAddingWallet(true);
      try {
          await axios.post('/api/registry', { address: newWalletInput, listedBy: userAddress });
          alert("Wallet Listed! You will earn 1% fees.");
          setNewWalletInput('');
          fetchRegistry();
      } catch (e: any) {
          alert(e.response?.data?.error || "Failed to list");
      } finally {
          setIsAddingWallet(false);
      }
  };

  // --- VIEW: LANDING ---
  if (!isConnected) {
      return <Landing onConnect={handleConnect} theme={theme} toggleTheme={toggleTheme} />;
  }

  // --- VIEW: ACTIVATION (Account Abstraction) ---
  if (needsActivation) {
      return (
          <ActivationView 
              needsActivation={needsActivation}
              handleActivate={handleActivateSmartAccount}
              isActivating={isActivating}
              chainId={chainId}
              userAddress={userAddress}
              theme={theme}
              toggleTheme={toggleTheme}
          />
      );
  }

  // --- VIEW: MAIN APP ---
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-terminal-bg text-gray-900 dark:text-gray-300 font-sans selection:bg-blue-500/30 selection:text-white flex flex-col transition-colors duration-200">
      
      {/* ... (Header) ... */}
      <header className="h-16 border-b border-gray-200 dark:border-terminal-border bg-white/80 dark:bg-terminal-card/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-full flex items-center justify-between">
            {/* Logo & Branding */}
            <div className="flex items-center gap-3">
                <button 
                    onClick={() => setActiveTab('dashboard')}
                    className="w-8 h-8 rounded bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition-colors"
                >
                    <Activity className="text-white" size={18} />
                </button>
                <div>
                    <h1 className="font-bold text-gray-900 dark:text-white tracking-tight leading-none">
                        <span className="text-blue-600">BET</span>
                        <span className="relative inline-block">
                            MIRROR
                            <span className="absolute left-0 top-full w-full text-center [transform:rotateX(180deg)] scale-y-0.5 origin-top opacity-50 [background:linear-gradient(to top, rgba(0,0,0,0.8), transparent)] bg-clip-text text-transparent">
                                MIRROR
                            </span>
                        </span>
                    </h1>
                    <span className="text-[10px] text-gray-500 font-mono tracking-widest uppercase">TERMINAL</span>
                </div>
            </div>

            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center gap-1 bg-gray-100 dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-lg p-1">
                {[
                  { id: 'dashboard', icon: Activity },
                  { id: 'system', icon: Gauge },
                  { id: 'bridge', icon: Globe },
                  { id: 'marketplace', icon: Users },
                  { id: 'history', icon: History },
                  { id: 'vault', icon: Lock },
                  { id: 'help', icon: LifeBuoy }
                ].map((tab) => (
                    <button 
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id as any)}
                        className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-2 ${
                            activeTab === tab.id 
                            ? 'bg-white dark:bg-terminal-border text-blue-600 dark:text-white shadow-sm' 
                            : 'text-gray-500 hover:text-gray-900 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/5'
                        }`}
                    >
                        <tab.icon size={14} />
                        <span className="capitalize">{tab.id}</span>
                    </button>
                ))}
            </nav>

            {/* Right Actions */}
            <div className="flex items-center gap-2 sm:gap-4">
                 {/* Chain Indicator */}
                 <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-white/5 rounded-lg border border-gray-200 dark:border-white/10 text-xs font-medium">
                    {/* SMART BRIDGE INDICATOR */}
                    {(activeTab === 'bridge' && bridgeMode === 'IN' && selectedSourceChain === 1151111081099710) ? (
                        <>
                             <img src={CHAIN_ICONS[1151111081099710]} className="w-4 h-4 rounded-full" alt="Solana"/>
                             <div className="flex flex-col leading-none">
                                <span className="text-gray-700 dark:text-gray-300">Solana</span>
                                <span className="text-[8px] text-gray-500 font-mono">
                                    {senderAddressDisplay ? `${senderAddressDisplay.slice(0,4)}...` : 'Connect'}
                                </span>
                             </div>
                        </>
                    ) : (
                        chainId === 137 ? (
                            <>
                                <img src={CHAIN_ICONS[137]} className="w-4 h-4 rounded-full" alt="Polygon"/>
                                <span className="hidden sm:inline text-gray-700 dark:text-gray-300">Polygon</span>
                            </>
                        ) : (
                            <button onClick={() => web3Service.switchToChain(137)} className="flex items-center gap-2 text-yellow-600 dark:text-yellow-500 font-bold animate-pulse">
                                <AlertTriangle size={12}/> Wrong Network
                            </button>
                        )
                    )}
                 </div>

                 {/* Theme Toggle */}
                 <button onClick={toggleTheme} className="hidden sm:block p-2 rounded-full hover:bg-gray-200 dark:hover:bg-white/10 text-gray-600 dark:text-gray-400 transition-colors">
                     {theme === 'light' ? <Moon size={16}/> : <Sun size={16}/>}
                 </button>

                 {/* Status Indicator */}
                 <div className="hidden md:flex flex-col items-end mr-2">
                    <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full status-dot ${isRunning ? 'bg-green-500 text-green-500' : 'bg-gray-400 text-gray-400'}`}></div>
                        <span className="text-[10px] font-mono font-bold text-gray-500 dark:text-gray-400">{isRunning ? (parseFloat(proxyWalletBal.usdc) < 1 ? 'WAITING DEPOSIT' : 'ENGINE ONLINE') : 'STANDBY'}</span>
                    </div>
                 </div>

                 {/* Start/Stop Button */}
                 {isRunning ? (
                    <button onClick={handleStop} className="h-9 px-4 bg-red-50 dark:bg-terminal-danger/10 hover:bg-red-100 dark:hover:bg-terminal-danger/20 text-red-600 dark:text-terminal-danger border border-red-200 dark:border-terminal-danger/50 rounded flex items-center gap-2 text-xs font-bold transition-all">
                        <Square size={14} fill="currentColor" /> <span className="hidden sm:inline">STOP</span>
                    </button>
                ) : (
                    <button onClick={handleStart} className="h-9 px-4 bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-2 text-xs font-bold transition-all shadow-lg shadow-blue-500/30">
                        <Play size={14} fill="currentColor" /> <span className="hidden sm:inline">START</span>
                    </button>
                )}

                {/* Mobile Menu Toggle */}
                <div className="md:hidden">
                    <button 
                        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                        className="p-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg transition-colors"
                    >
                        {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
                    </button>
                </div>
            </div>
        </div>
        
        {/* Mobile Navigation Dropdown */}
        {isMobileMenuOpen && (
            <div className="absolute top-16 left-0 w-full bg-white dark:bg-terminal-card border-b border-gray-200 dark:border-terminal-border z-40 md:hidden animate-in slide-in-from-top-5 shadow-xl">
                <div className="p-4 grid grid-cols-2 gap-2">
                    {[
                      { id: 'dashboard', icon: Activity },
                      { id: 'system', icon: Gauge },
                      { id: 'bridge', icon: Globe },
                      { id: 'marketplace', icon: Users },
                      { id: 'history', icon: History },
                      { id: 'vault', icon: Lock },
                      { id: 'help', icon: LifeBuoy }
                    ].map((tab) => (
                        <button 
                            key={tab.id}
                            onClick={() => { setActiveTab(tab.id as any); setIsMobileMenuOpen(false); }}
                            className={`p-3 rounded-lg text-sm font-bold flex flex-col items-center gap-2 transition-all ${
                                activeTab === tab.id 
                                ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800' 
                                : 'bg-gray-50 dark:bg-white/5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10'
                            }`}
                        >
                            <tab.icon size={20} />
                            <span className="capitalize">{tab.id}</span>
                        </button>
                    ))}
                </div>
                <div className="p-4 border-t border-gray-200 dark:border-gray-800 flex justify-between items-center">
                    <span className="text-xs font-mono text-gray-500">v2.4.1-mobile</span>
                    <button onClick={toggleTheme} className="flex items-center gap-2 text-xs font-bold text-gray-600 dark:text-gray-400">
                        {theme === 'light' ? <><Moon size={14}/> Dark Mode</> : <><Sun size={14}/> Light Mode</>}
                    </button>
                </div>
            </div>
        )}
      </header>

      {/* --- MAIN CONTENT --- */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 overflow-hidden">
        {activeTab === 'dashboard' && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6 h-full animate-in fade-in slide-in-from-bottom-4 duration-300">
                {/* Left Panel */}
                <div className="col-span-12 md:col-span-8 flex flex-col gap-6">
                    {/* Wallet Assets Matrix */}
                    <div className="glass-panel p-5 rounded-xl relative overflow-hidden">
                        <div className="absolute top-0 right-0 p-4 opacity-5 text-blue-600 dark:text-white">
                            <Wallet size={100} />
                        </div>
                        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                             <Coins size={14}/> Asset Overview
                        </h3>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 relative z-10">
                             {/* Connected Wallet */}
                             <div className="space-y-3">
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-[10px] text-white">W</div>
                                    <span className="text-sm font-bold text-gray-900 dark:text-white">Main Wallet</span>
                                    <button 
                                        onClick={() => copyToClipboard(userAddress)} 
                                        className="p-1 hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors text-gray-500"
                                    >
                                        <Copy size={12}/>
                                    </button>
                                    <Tooltip text="Your connected Browser Wallet (MetaMask, Phantom, etc). This wallet controls the Smart Account." />
                                    <span className="text-[10px] text-gray-500 bg-gray-200 dark:bg-gray-900 px-1.5 rounded">{chainId}</span>
                                </div>
                                <div className="p-3 bg-white dark:bg-black/40 rounded border border-gray-200 dark:border-gray-800 flex justify-between shadow-sm dark:shadow-none">
                                    <span className="text-xs text-gray-500 dark:text-gray-400">Native</span>
                                    <span className="text-sm font-mono text-gray-900 dark:text-white">{mainWalletBal.native}</span>
                                </div>
                                <div className="p-3 bg-white dark:bg-black/40 rounded border border-gray-200 dark:border-gray-800 flex justify-between shadow-sm dark:shadow-none">
                                    <span className="text-xs text-gray-500 dark:text-gray-400">USDC</span>
                                    <span className="text-sm font-mono text-gray-900 dark:text-white">{mainWalletBal.usdc}</span>
                                </div>
                             </div>

                             {/* Proxy Wallet */}
                             <div className="space-y-3">
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] text-white bg-green-600">P</div>
                                    <span className="text-sm font-bold text-gray-900 dark:text-white">Smart Trading Vault</span>
                                    <button 
                                        onClick={() => copyToClipboard(proxyAddress)} 
                                        className="p-1 hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors text-gray-500"
                                    >
                                        <Copy size={12}/>
                                    </button>
                                    <Tooltip text="This is your automated trading vault on Polygon. It holds the funds used by the bot to execute trades." />
                                    <span className="text-[10px] text-gray-500 bg-gray-200 dark:bg-gray-900 px-1.5 rounded">Polygon</span>
                                </div>
                                <div className="p-3 bg-white dark:bg-black/40 rounded border border-gray-200 dark:border-gray-800 flex justify-between shadow-sm dark:shadow-none">
                                    <span className="text-xs text-gray-500 dark:text-gray-400">POL (Gas)</span>
                                    <span className="text-sm font-mono text-gray-900 dark:text-white">{proxyWalletBal.native}</span>
                                </div>
                                <div className="p-3 bg-white dark:bg-black/40 rounded border border-gray-200 dark:border-gray-800 flex justify-between shadow-sm dark:shadow-none">
                                    <div className="flex flex-col">
                                        <span className="text-xs text-gray-500 dark:text-gray-400">USDC.e (Active)</span>
                                        <span className="text-[8px] text-green-600 dark:text-green-400 font-bold">TRADING FUNDS</span>
                                    </div>
                                    <span className="text-sm font-mono text-gray-900 dark:text-white font-bold">{proxyWalletBal.usdc}</span>
                                </div>
                             </div>
                        </div>

                        {/* Action Bar */}
                        <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-800 flex flex-col sm:flex-row gap-3">
                            <button 
                                onClick={openDepositModal}
                                className="flex-1 py-3 bg-blue-600 dark:bg-terminal-accent hover:bg-blue-700 dark:hover:bg-blue-600 text-white font-bold rounded-lg transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2"
                            >
                                <ArrowDownCircle size={18}/> DEPOSIT FUNDS
                                <span className="text-[10px] opacity-80 font-normal">To Smart Vault</span>
                            </button>
                            <button 
                                onClick={openWithdrawModal} 
                                className="flex-1 py-3 bg-white dark:bg-white/5 hover:bg-gray-50 dark:hover:bg-white/10 border border-red-200 dark:border-terminal-danger/30 text-red-600 dark:text-terminal-danger font-bold rounded-lg transition-all flex items-center justify-center gap-2"
                            >
                                <ArrowUpCircle size={18}/> WITHDRAW
                                <span className="text-[10px] opacity-80 font-normal">To Main Wallet</span>
                            </button>
                        </div>
                    </div>

                    {/* Console */}
                    <div className="flex-1 glass-panel rounded-xl overflow-hidden flex flex-col min-h-[300px]">
                        <div className="px-4 py-2 border-b border-gray-200 dark:border-terminal-border bg-white/50 dark:bg-terminal-card/80 flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <Terminal size={14} className="text-gray-400" />
                                <span className="text-xs font-mono font-bold text-gray-500 dark:text-gray-400">LIVE_LOGS</span>
                            </div>
                            <button onClick={clearLogs} className="text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                                <Trash2 size={12} />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1 bg-white dark:bg-[#050505]">
                             {logs.length === 0 && (
                                <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-700 gap-2 opacity-50">
                                    <Terminal size={32} />
                                    <span>System Ready. Waiting for signals...</span>
                                </div>
                             )}
                             {logs.map((log) => (
                                <div key={log.id} className="flex gap-3 hover:bg-gray-50 dark:hover:bg-white/5 p-0.5 rounded animate-in fade-in duration-200">
                                    <span className="text-gray-400 dark:text-gray-600 shrink-0 select-none">[{log.time}]</span>
                                    <span className={`break-all ${
                                        log.type === 'error' ? 'text-red-600 dark:text-terminal-danger' : 
                                        log.type === 'warn' ? 'text-yellow-600 dark:text-terminal-warn' : 
                                        log.type === 'success' ? 'text-green-600 dark:text-terminal-success' : 'text-gray-800 dark:text-blue-200'
                                    }`}>
                                        {log.message}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Right Panel */}
                <div className="col-span-12 md:col-span-4 flex flex-col gap-6">
                    {/* Performance Widget */}
                    <div className="glass-panel p-5 rounded-xl">
                        <div className="flex justify-between items-start mb-2">
                            <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Performance</h3>
                            <TrendingUp size={20} className="text-green-500 dark:text-terminal-success"/>
                        </div>
                        <div className="grid grid-cols-2 gap-4 mt-4">
                            <div>
                                <div className="text-[10px] text-gray-500">Total PnL</div>
                                <div className={`text-xl font-mono font-bold ${stats?.totalPnl && stats.totalPnl >= 0 ? 'text-green-600 dark:text-terminal-success' : 'text-red-600 dark:text-terminal-danger'}`}>
                                    {stats?.totalPnl ? `$${stats.totalPnl.toFixed(2)}` : '$0.00'}
                                </div>
                            </div>
                            <div>
                                <div className="text-[10px] text-gray-500">Volume</div>
                                <div className="text-xl font-mono font-bold text-gray-900 dark:text-white">${stats?.totalVolume?.toFixed(0) || '0'}</div>
                            </div>
                        </div>
                    </div>
                    {/* Strategy Preview */}
                    <div className="glass-panel p-5 rounded-xl space-y-4">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2"><Settings size={16} className="text-blue-600 dark:text-terminal-accent"/> Active Strategy</h3>
                            <button onClick={() => setActiveTab('vault')} className="text-[10px] text-blue-600 dark:text-terminal-accent hover:underline">EDIT</button>
                        </div>
                        <div className="space-y-2">
                             <div className="flex justify-between text-xs p-2 bg-gray-50 dark:bg-white/5 rounded border border-gray-200 dark:border-white/5">
                                 <span className="text-gray-500 dark:text-gray-400">Mode</span>
                                 <span className="font-mono text-blue-600 dark:text-terminal-accent uppercase">{config.riskProfile}</span>
                             </div>
                             <div className="flex justify-between text-xs p-2 bg-gray-50 dark:bg-white/5 rounded border border-gray-200 dark:border-white/5">
                                 <span className="text-gray-500 dark:text-gray-400">Multiplier</span>
                                 <span className="font-mono text-gray-900 dark:text-white">x{config.multiplier}</span>
                             </div>
                             <div className="flex justify-between text-xs p-2 bg-gray-50 dark:bg-white/5 rounded border border-gray-200 dark:border-white/5">
                                 <span className="text-gray-500 dark:text-gray-400">Targets</span>
                                 <span className="font-mono text-gray-900 dark:text-white">{config.targets.length}</span>
                             </div>
                        </div>
                    </div>
                    {/* Recent Trades */}
                    <div className="glass-panel p-5 rounded-xl space-y-4 flex-1">
                        <h3 className="text-sm font-bold text-gray-900 dark:text-white">Recent Trades</h3>
                        <div className="space-y-2">
                                {history.slice(0, 5).map(trade => (
                                    <div key={trade.id} className="text-xs flex items-center justify-between p-2 bg-gray-50 dark:bg-black/40 rounded border border-gray-200 dark:border-white/5">
                                        <div className="flex items-center gap-2">
                                            <span className={`w-1.5 h-1.5 rounded-full ${trade.side === 'BUY' ? 'bg-green-50 dark:bg-terminal-success' : 'bg-red-50 dark:bg-terminal-danger'}`}></span>
                                            <span className="font-mono text-gray-700 dark:text-gray-300">{trade.side}</span>
                                        </div>
                                        <span className="text-gray-500 text-[10px] max-w-[80px] truncate">{trade.outcome}</span>
                                        <span className="font-mono text-gray-900 dark:text-white">${trade.size.toFixed(2)}</span>
                                    </div>
                                ))}
                                {history.length === 0 && <div className="text-center text-gray-500 dark:text-gray-600 text-xs py-4 italic">No trades yet</div>}
                        </div>
                    </div>
                </div>
            </div>
        )}
        
        {/* BRIDGE (Refactored) */}
        {activeTab === 'bridge' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
                {/* Bridge Guide Modal */}
                {showBridgeGuide && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in">
                        <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl max-w-md w-full p-6 relative shadow-2xl">
                            <button onClick={() => { setShowBridgeGuide(false); localStorage.setItem('bridge_guide_dismissed', 'true'); }} className="absolute top-4 right-4 text-gray-500 hover:text-black dark:hover:text-white"><X/></button>
                            
                            <div className="flex flex-col items-center text-center gap-4 mb-4">
                                <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center text-blue-600 dark:text-blue-400">
                                    <Fuel size={32}/>
                                </div>
                                <h3 className="text-xl font-bold text-gray-900 dark:text-white">First Time Setup</h3>
                            </div>

                            <div className="space-y-4 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                                <p>
                                    To start your bot, you need two things on the Polygon network:
                                </p>
                                <ul className="list-disc pl-5 space-y-2">
                                    <li><strong>USDC.e (Bridged):</strong> To place trades. This is the collateral used by Polymarket.</li>
                                    <li><strong>POL (Matic):</strong> To pay for gas fees (even with account abstraction, some base gas is needed for activation).</li>
                                </ul>
                                <div className="bg-yellow-50 dark:bg-yellow-900/20 p-3 rounded-lg border border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200 text-xs font-bold">
                                    💡 Tip: Bridge at least $2 of POL first, then bridge your USDC.
                                </div>
                            </div>

                            <button 
                                onClick={() => { setShowBridgeGuide(false); localStorage.setItem('bridge_guide_dismissed', 'true'); }}
                                className="mt-6 w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-lg transition-all"
                            >
                                Got it
                            </button>
                        </div>
                    </div>
                )}

                {/* Bridge Form */}
                <div className="md:col-span-2 glass-panel p-8 rounded-xl border border-gray-200 dark:border-terminal-border">
                    <div className="flex items-center justify-between mb-8">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-blue-100 dark:bg-blue-900/20 rounded-lg text-blue-600 dark:text-blue-400">
                                <Globe size={20}/>
                            </div>
                            <div>
                                <h2 className="text-xl font-bold text-gray-900 dark:text-white">Cross-Chain Bridge</h2>
                                <p className="text-xs text-gray-500">{bridgeMode === 'IN' ? 'External → Polygon Smart Vault' : 'Polygon Main Wallet → External'}</p>
                            </div>
                        </div>
                        
                        <div className="flex bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                            <button 
                                onClick={() => bridgeMode !== 'IN' && handleSwapDirection()}
                                className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${bridgeMode === 'IN' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                            >
                                Bridge In
                            </button>
                            <button 
                                onClick={() => bridgeMode !== 'OUT' && handleSwapDirection()}
                                className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${bridgeMode === 'OUT' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                            >
                                Bridge Out
                            </button>
                        </div>
                    </div>
                    
                    <div className="relative flex flex-col gap-2">
                        
                        {/* FROM CARD */}
                        <div className="p-4 bg-white dark:bg-black/40 rounded-xl border border-gray-200 dark:border-terminal-border shadow-sm dark:shadow-none transition-all hover:border-blue-300 dark:hover:border-blue-700">
                            <div className="flex justify-between items-center mb-2">
                                <label className="text-xs text-gray-500 uppercase font-bold">From Network</label>
                                <span className="text-[10px] text-gray-400 flex items-center gap-1">
                                    <Wallet2 size={10}/> 
                                    Bal: {getSourceBalance()}
                                </span>
                            </div>
                            
                            <div className="flex gap-4 items-center">
                                {/* Chain Selector */}
                                <div className="relative min-w-[140px]">
                                    <button 
                                        onClick={() => setIsSourceChainSelectOpen(!isSourceChainSelectOpen)}
                                        className="w-full flex items-center justify-between bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white text-sm rounded-lg px-3 py-2.5 transition-colors"
                                        disabled={bridgeMode === 'OUT'} // Locked to Polygon for Out
                                    >
                                        <div className="flex items-center gap-2">
                                            <img src={CHAIN_ICONS[selectedSourceChain]} alt="" className="w-5 h-5 rounded-full"/>
                                            <span className="font-bold truncate max-w-[80px]">{CHAIN_NAMES[selectedSourceChain]}</span>
                                        </div>
                                        {bridgeMode === 'IN' && <ChevronDown size={14} className={`text-gray-400 transition-transform ${isSourceChainSelectOpen ? 'rotate-180' : ''}`}/>}
                                    </button>
                                    
                                    {isSourceChainSelectOpen && bridgeMode === 'IN' && (
                                        <div className="absolute top-full left-0 w-full mt-1 bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-lg shadow-xl z-20 overflow-hidden animate-in fade-in slide-in-from-top-2">
                                            {[8453, 56, 42161, 1, 1151111081099710].map(cId => (
                                                <button 
                                                    key={cId}
                                                    onClick={() => { setSelectedSourceChain(cId); setIsSourceChainSelectOpen(false); }}
                                                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors text-sm text-gray-900 dark:text-white text-left"
                                                >
                                                    <img src={CHAIN_ICONS[cId]} alt="" className="w-5 h-5 rounded-full"/>
                                                    <span>{CHAIN_NAMES[cId]}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* Amount Input */}
                                <div className="flex-1 relative">
                                    <input 
                                        type="text" 
                                        inputMode="decimal"
                                        autoComplete="off"
                                        pattern="^[0-9]*[.,]?[0-9]*$"
                                        className="w-full bg-transparent text-2xl font-mono font-bold text-gray-900 dark:text-white outline-none text-right placeholder:text-gray-300 dark:placeholder:text-gray-700"
                                        placeholder="0.00"
                                        value={bridgeAmount}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            // Regex: Allow positive integers or decimals only (no negatives, no extra dots)
                                            if (val === '' || /^\d*\.?\d*$/.test(val)) {
                                                setBridgeAmount(val);
                                            }
                                        }}
                                    />
                                    <div className="absolute -bottom-5 right-0 flex gap-2">
                                            <button 
                                            onClick={() => {
                                                const bal = getSourceBalance();
                                                // Only set if numeric and safe
                                                if (bal && !isNaN(parseFloat(bal))) {
                                                    setBridgeAmount(bal);
                                                }
                                            }}
                                            className="text-[10px] text-blue-600 dark:text-blue-400 font-bold hover:underline"
                                            >
                                            MAX
                                            </button>
                                    </div>
                                </div>
                            </div>
                            
                            {/* Token Selector Pill */}
                            <div className="flex justify-end mt-4">
                                <div className="flex bg-gray-100 dark:bg-white/5 p-1 rounded-lg">
                                    {selectedSourceChain === 137 ? (
                                        // Polygon Source Options
                                        <>
                                            <button onClick={() => setBridgeToken('USDC')} className={`px-3 py-1 text-[10px] font-bold rounded ${bridgeToken === 'USDC' ? 'bg-white dark:bg-gray-600 shadow-sm text-blue-600 dark:text-white' : 'text-gray-500'}`}>USDC (Native)</button>
                                            <button onClick={() => setBridgeToken('USDC.e')} className={`px-3 py-1 text-[10px] font-bold rounded ${bridgeToken === 'USDC.e' ? 'bg-white dark:bg-gray-600 shadow-sm text-green-600 dark:text-white' : 'text-gray-500'}`}>USDC.e</button>
                                            <button onClick={() => setBridgeToken('NATIVE')} className={`px-3 py-1 text-[10px] font-bold rounded ${bridgeToken === 'NATIVE' ? 'bg-white dark:bg-gray-600 shadow-sm text-purple-600 dark:text-white' : 'text-gray-500'}`}>POL</button>
                                        </>
                                    ) : (
                                        // External Source Options
                                        <>
                                            <button onClick={() => setBridgeToken('USDC')} className={`px-3 py-1 text-[10px] font-bold rounded ${bridgeToken === 'USDC' ? 'bg-white dark:bg-gray-600 shadow-sm text-blue-600 dark:text-white' : 'text-gray-500'}`}>USDC</button>
                                            <button onClick={() => setBridgeToken('NATIVE')} className={`px-3 py-1 text-[10px] font-bold rounded ${bridgeToken === 'NATIVE' ? 'bg-white dark:bg-gray-600 shadow-sm' : 'text-gray-500'}`}>{selectedSourceChain === 1151111081099710 ? 'SOL' : 'ETH'}</button>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Swap Direction Button */}
                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10">
                            <button 
                                onClick={handleSwapDirection}
                                className="p-2 bg-gray-100 dark:bg-gray-800 border-4 border-white dark:border-[#0a0a0a] rounded-full text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 hover:rotate-180 transition-all shadow-sm"
                            >
                                <ArrowUpDown size={18}/>
                            </button>
                        </div>

                        {/* TO CARD */}
                        <div className="p-4 bg-gray-50 dark:bg-black/40 rounded-xl border border-gray-200 dark:border-terminal-border shadow-sm dark:shadow-none transition-all hover:border-blue-300 dark:hover:border-blue-700">
                            <label className="text-xs text-gray-500 uppercase font-bold mb-2 block">To Network</label>
                            <div className="flex gap-4 items-center">
                                {/* Chain Selector */}
                                <div className="relative min-w-[140px]">
                                    <button 
                                        onClick={() => setIsDestChainSelectOpen(!isDestChainSelectOpen)}
                                        className="w-full flex items-center justify-between bg-white dark:bg-white/5 hover:bg-gray-50 dark:hover:bg-white/10 border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white text-sm rounded-lg px-3 py-2.5 transition-colors"
                                        disabled={bridgeMode === 'IN'} // Locked to Polygon for IN
                                    >
                                        <div className="flex items-center gap-2">
                                            <img src={CHAIN_ICONS[selectedDestChain]} alt="" className="w-5 h-5 rounded-full"/>
                                            <span className="font-bold truncate max-w-[80px]">{CHAIN_NAMES[selectedDestChain]}</span>
                                        </div>
                                        {bridgeMode === 'OUT' && <ChevronDown size={14} className={`text-gray-400 transition-transform ${isDestChainSelectOpen ? 'rotate-180' : ''}`}/>}
                                    </button>
                                    
                                    {isDestChainSelectOpen && bridgeMode === 'OUT' && (
                                        <div className="absolute top-full left-0 w-full mt-1 bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-lg shadow-xl z-20 overflow-hidden animate-in fade-in slide-in-from-top-2">
                                            {[8453, 56, 42161, 1, 1151111081099710].map(cId => (
                                                <button 
                                                    key={cId}
                                                    onClick={() => { setSelectedDestChain(cId); setIsDestChainSelectOpen(false); }}
                                                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors text-sm text-gray-900 dark:text-white text-left"
                                                >
                                                    <img src={CHAIN_ICONS[cId]} alt="" className="w-5 h-5 rounded-full"/>
                                                    <span>{CHAIN_NAMES[cId]}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* Recipient Input / Selector */}
                                <div className="flex-1">
                                    {bridgeMode === 'IN' ? (
                                        <div className="relative">
                                            {/* Dropdown for Deposit Target: Smart Wallet vs Main Wallet */}
                                            <div className="relative">
                                                <select
                                                    value={recipientAddress}
                                                    onChange={(e) => setRecipientAddress(e.target.value)}
                                                    className="w-full appearance-none bg-transparent border-b border-gray-300 dark:border-gray-700 py-2 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-blue-500 transition-colors pr-8 cursor-pointer"
                                                >
                                                    <option value={proxyAddress}>Smart Vault (Bot) - {proxyAddress ? `${proxyAddress.slice(0,6)}...` : 'Activate First'}</option>
                                                    <option value={userAddress}>Main Wallet (You) - {userAddress.slice(0,6)}...</option>
                                                </select>
                                                <ChevronDown size={14} className="absolute right-0 top-3 text-gray-400 pointer-events-none"/>
                                            </div>
                                            <div className="text-[10px] text-gray-500 mt-1">
                                                Destination Wallet
                                            </div>
                                        </div>
                                    ) : (
                                        /* Existing Input for Withdraw */
                                        <div className="relative">
                                            <div className="relative">
                                                <input 
                                                    type="text" 
                                                    className="w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-2 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-blue-500 transition-colors pr-8"
                                                    placeholder="Recipient Address"
                                                    value={recipientAddress}
                                                    onChange={(e) => setRecipientAddress(e.target.value)}
                                                />
                                                <button 
                                                    onClick={async () => { const text = await navigator.clipboard.readText(); setRecipientAddress(text); }}
                                                    className="absolute right-0 top-2 text-gray-400 hover:text-blue-500"
                                                    title="Paste"
                                                >
                                                    <Clipboard size={14}/>
                                                </button>
                                            </div>
                                            <div className="text-[10px] text-gray-500 mt-1">
                                                Receive Address
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Destination Token Toggle (Only for IN mode when receiving on Polygon) */}
                            {bridgeMode === 'IN' && selectedDestChain === 137 && (
                                <div className="flex justify-end mt-4">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] text-gray-500 font-bold uppercase">Receive:</span>
                                        <div className="flex bg-gray-200 dark:bg-white/5 p-1 rounded-lg">
                                            <button 
                                                onClick={() => setDestToken('USDC')} 
                                                className={`px-3 py-1 text-[10px] font-bold rounded transition-all ${destToken === 'USDC' ? 'bg-white dark:bg-gray-600 shadow-sm text-blue-600 dark:text-white' : 'text-gray-500'}`}
                                            >
                                                USDC.e (Trade)
                                            </button>
                                            <button 
                                                onClick={() => setDestToken('NATIVE')} 
                                                className={`px-3 py-1 text-[10px] font-bold rounded transition-all ${destToken === 'NATIVE' ? 'bg-white dark:bg-gray-600 shadow-sm text-purple-600 dark:text-white' : 'text-gray-500'}`}
                                            >
                                                POL (Gas)
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    
                    <div className="mt-8">
                        {!bridgeQuote ? (
                            <button onClick={handleGetBridgeQuote} className="w-full py-4 bg-blue-600 dark:bg-terminal-accent hover:bg-blue-700 dark:hover:bg-blue-600 text-white font-bold rounded-xl transition-all shadow-lg hover:shadow-blue-500/25 hover:-translate-y-0.5">
                                Review Quote
                            </button>
                        ) : (
                            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                                {/* Detailed Quote Card */}
                                <div className="p-4 bg-white dark:bg-black/20 border border-blue-200 dark:border-blue-500/30 rounded-xl text-sm space-y-3 shadow-sm relative overflow-hidden">
                                    <div className="absolute top-0 left-0 w-1 h-full bg-blue-500"></div>
                                    <div className="flex justify-between items-center border-b border-gray-100 dark:border-white/5 pb-2">
                                        <span className="font-bold text-gray-900 dark:text-white">Quote Summary</span>
                                        <span className="text-[10px] bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 px-2 py-0.5 rounded font-bold">BEST RATE</span>
                                    </div>
                                    
                                    <div className="grid grid-cols-2 gap-4 pt-1">
                                        <div>
                                            <span className="text-[10px] text-gray-500 uppercase block font-bold">Estimated Return</span>
                                            <span className="font-mono font-bold text-gray-900 dark:text-white text-lg">~{parseFloat(bridgeQuote.toAmountUSD).toFixed(2)} USD</span>
                                        </div>
                                        <div>
                                            <span className="text-[10px] text-gray-500 uppercase block font-bold">Time</span>
                                            <span className="font-mono font-bold text-gray-900 dark:text-white flex items-center gap-1"><Timer size={12}/> ~2 Mins</span>
                                        </div>
                                        <div>
                                            <span className="text-[10px] text-gray-500 uppercase block font-bold">Network Fee</span>
                                            <span className="font-mono font-bold text-gray-700 dark:text-gray-300 flex items-center gap-1"><Fuel size={12}/> ${parseFloat(bridgeQuote.gasCostUSD || '0').toFixed(2)}</span>
                                        </div>
                                        <div>
                                            <span className="text-[10px] text-gray-500 uppercase block font-bold">Platform Fee (0.5%)</span>
                                            <span className="font-mono font-bold text-gray-700 dark:text-gray-300">${(parseFloat(bridgeQuote.fromAmountUSD) * 0.005).toFixed(2)}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Action Button or Stepper */}
                                {isBridging ? (
                                    <BridgeStepper status={bridgeStatus} />
                                ) : (
                                    <button onClick={handleExecuteBridge} className="w-full py-4 bg-green-600 dark:bg-terminal-success hover:bg-green-700 dark:hover:bg-green-600 text-white font-bold rounded-xl transition-all flex justify-center gap-2 shadow-lg hover:shadow-green-500/25 hover:-translate-y-0.5">
                                        <Zap size={18}/> CONFIRM TRANSACTION
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* History Panel */}
                <div className="glass-panel p-6 rounded-xl border border-gray-200 dark:border-terminal-border flex flex-col h-[600px]">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2"><History size={14}/> Bridge History</h3>
                        <span className="text-[10px] text-gray-500">{bridgeHistory.length} Txns</span>
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700">
                        {bridgeHistory.length === 0 && (
                            <div className="flex flex-col items-center justify-center h-40 text-gray-400 dark:text-gray-600">
                                <ArrowRightLeft size={32} className="mb-2 opacity-50"/>
                                <p className="text-xs italic">No history available.</p>
                            </div>
                        )}
                        {bridgeHistory.map(rec => (
                            <div key={rec.id} className="p-3 bg-white dark:bg-white/5 rounded border border-gray-200 dark:border-white/5 text-xs hover:border-blue-500/30 transition-colors group">
                                <div className="flex justify-between mb-2">
                                    <span className="text-gray-500 dark:text-gray-400 text-[10px]">{new Date(rec.timestamp).toLocaleDateString()} {new Date(rec.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                                    <span className={`font-bold text-[10px] px-1.5 py-0.5 rounded ${
                                        rec.status === 'COMPLETED' ? 'bg-green-100 dark:bg-green-900/20 text-green-600 dark:text-green-500' : 
                                        rec.status === 'FAILED' ? 'bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-500' : 
                                        'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-500'
                                    }`}>
                                        {rec.status}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between text-gray-900 dark:text-white mb-2 font-medium">
                                    <span className="flex items-center gap-1">{rec.fromChain}</span> 
                                    <ArrowRightLeft size={10} className="text-gray-400"/> 
                                    <span className="flex items-center gap-1">{rec.toChain}</span>
                                </div>
                                <div className="flex justify-between items-end">
                                    <div className="text-gray-600 dark:text-gray-400 font-mono">
                                        ${parseFloat(rec.amountIn).toFixed(2)} &rarr; <span className="text-gray-900 dark:text-white font-bold">${parseFloat(rec.amountOut).toFixed(2)}</span>
                                    </div>
                                    {rec.txHash && (
                                        <a href={`https://polygonscan.com/tx/${rec.txHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600 dark:hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <ExternalLink size={12}/>
                                        </a>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        )}
        
        {/* SYSTEM PAGE (Revamped) */}
        {activeTab === 'system' && systemStats && (
            <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
                
                {/* Header */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl"><Gauge size={32} className="text-blue-600 dark:text-blue-500"/></div>
                        <div>
                            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">System Command</h2>
                            <p className="text-gray-500">Global Aggregated Data & Platform Metrics</p>
                        </div>
                    </div>
                    <div className="bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-500/30 px-4 py-2 rounded-lg flex items-center gap-3 w-full sm:w-auto">
                        <Trophy size={20} className="text-yellow-600 dark:text-yellow-500"/>
                        <div>
                            <div className="text-[10px] font-bold text-yellow-600 dark:text-yellow-500 uppercase">Global Rank</div>
                            <div className="text-lg font-black text-gray-900 dark:text-white">#{systemStats.builder.current?.rank || '-'}</div>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    
                    {/* Left: Internal Metrics (Grid) */}
                    <div className="glass-panel p-6 rounded-xl border border-gray-200 dark:border-terminal-border space-y-6">
                        <h3 className="text-sm font-bold text-gray-500 uppercase tracking-widest border-b border-gray-200 dark:border-gray-800 pb-2 flex items-center gap-2">
                            <Server size={14}/> Internal Platform Metrics
                        </h3>
                        <div className="grid grid-cols-2 gap-6">
                                {/* Card 1: Signal Volume */}
                                <div>
                                <div className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                                    Signal Volume <Tooltip text="Total volume of whale/signal trades detected by the monitoring engine. (Source Volume)" />
                                </div>
                                <div className="text-2xl font-black text-gray-900 dark:text-white font-mono">
                                    ${systemStats.internal.signalVolume.toLocaleString()}
                                </div>
                                <div className="text-[10px] text-gray-400">{systemStats.internal.totalTrades} signals tracked</div>
                                </div>

                                {/* Card 2: Platform Execution Volume (NEW) */}
                                <div>
                                <div className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                                    Bot Execution Vol <Tooltip text="Real USDC volume executed by user bots on the platform." />
                                </div>
                                <div className="text-2xl font-black text-blue-600 dark:text-blue-400 font-mono">
                                    ${systemStats.internal.executedVolume.toLocaleString()}
                                </div>
                                <div className="text-[10px] text-gray-400">On-Chain Volume</div>
                                </div>

                                {/* Card 3: Revenue */}
                                <div>
                                <div className="text-xs text-gray-500 mb-1">Protocol Revenue</div>
                                <div className="text-2xl font-black text-green-600 dark:text-green-500 font-mono">
                                    ${systemStats.internal.totalRevenue.toFixed(2)}
                                </div>
                                <div className="text-[10px] text-gray-400">1% Fee Share</div>
                                </div>

                                {/* Card 4: Active Bots */}
                                <div>
                                <div className="text-xs text-gray-500 mb-1">Active Runners</div>
                                <div className="text-2xl font-black text-gray-900 dark:text-white font-mono">
                                    {systemStats.internal.activeBots} <span className="text-sm text-gray-400 font-normal">/ {systemStats.internal.totalUsers}</span>
                                </div>
                                <div className="text-[10px] text-gray-400">Online now</div>
                                </div>
                        </div>
                    </div>

                    {/* Right: Verified On-Chain Data (Switchable) */}
                    <div className="glass-panel p-6 rounded-xl border border-blue-200 dark:border-blue-500/30 bg-blue-50/50 dark:bg-blue-900/10 space-y-6 flex flex-col justify-between flex-1">
                        
                        <div className="flex justify-between items-center border-b border-blue-200 dark:border-blue-800 pb-2">
                            <div className="flex gap-4">
                                <button 
                                    onClick={() => setSystemView('attribution')}
                                    className={`text-xs font-bold uppercase tracking-widest pb-1 -mb-3 border-b-2 transition-all ${systemView === 'attribution' ? 'border-blue-600 dark:border-blue-400 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
                                >
                                    Builder Attribution
                                </button>
                                <button 
                                    onClick={() => setSystemView('global')}
                                    className={`text-xs font-bold uppercase tracking-widest pb-1 -mb-3 border-b-2 transition-all ${systemView === 'global' ? 'border-blue-600 dark:border-blue-400 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
                                >
                                    Global Ecosystem
                                </button>
                            </div>
                            <span className="text-[10px] bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded font-mono">
                                {systemView === 'attribution' ? `ID: ${systemStats.builder.builderId}` : 'Polymarket API'}
                            </span>
                        </div>
                        
                        {systemView === 'attribution' ? (
                            <div className="space-y-6 flex-1 flex flex-col justify-between animate-in fade-in">
                                <div className="grid grid-cols-2 gap-6">
                                    <div>
                                        <div className="text-xs text-blue-500/80 mb-1 flex items-center gap-1">
                                            My Attributed Volume (All Time) <Tooltip text={`Actual on-chain volume executed by bots carrying the '${systemStats.builder.builderId}' Builder Header.`} />
                                        </div>
                                        <div className="text-3xl font-black text-gray-900 dark:text-white font-mono">
                                            ${(systemStats.builder.current?.volume || 0).toLocaleString()}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-blue-500/80 mb-1">Active Users (All Time)</div>
                                        <div className="text-3xl font-black text-gray-900 dark:text-white font-mono">
                                            {systemStats.builder.current?.activeUsers || 0}
                                        </div>
                                    </div>
                                </div>

                                {/* Leaderboard Chart Visualization */}
                                <div className="flex-1 flex flex-col">
                                        <div className="text-[10px] text-gray-500 mb-2 font-bold uppercase">Global Builder Leaderboard (Top 50)</div>
                                        <div className="flex items-end gap-1 h-40 border-b border-gray-200 dark:border-gray-800 pb-1 overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700">
                                            {systemStats.builder.history.map((b, i) => {
                                                const maxVol = systemStats.builder.history[0]?.volume || 1;
                                                const height = (b.volume / maxVol) * 100;
                                                const isMe = b.builder.toLowerCase() === systemStats.builder.builderId.toLowerCase();

                                                return (
                                                    <div key={i} className="group relative flex flex-col items-center justify-end h-full min-w-[6px] flex-1 hover:min-w-[12px] transition-all duration-300">
                                                        <div 
                                                            className={`w-full rounded-t-sm transition-all ${isMe ? 'bg-yellow-500' : 'bg-blue-300/50 dark:bg-blue-600/50 group-hover:bg-blue-600 dark:group-hover:bg-blue-400'}`}
                                                            style={{ height: `${Math.max(height, 2)}%` }}
                                                        ></div>
                                                        
                                                        {/* Hover Tooltip */}
                                                        <div className="opacity-0 group-hover:opacity-100 absolute bottom-full mb-2 bg-black dark:bg-white text-white dark:text-black text-[10px] p-2 rounded shadow-xl z-50 pointer-events-none whitespace-nowrap flex flex-col gap-1 items-center border border-gray-700">
                                                            <div className="flex items-center gap-2 border-b border-gray-700 pb-1 mb-1 w-full justify-center">
                                                                <span className="font-bold">#{b.rank || i+1}</span>
                                                                {b.builderLogo && <img src={b.builderLogo} className="w-4 h-4 rounded-full"/>}
                                                                <span className="font-bold">{b.builder}</span>
                                                            </div>
                                                            <div className="text-xs font-mono font-bold">${b.volume.toLocaleString()}</div>
                                                            <div className="text-[8px] opacity-70">{b.activeUsers} Users</div>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-6 flex-1 flex flex-col justify-center animate-in fade-in">
                                <div className="text-center space-y-2">
                                        <div className="inline-block p-4 bg-blue-100 dark:bg-blue-900/30 rounded-full mb-2">
                                            <Globe size={48} className="text-blue-600 dark:text-blue-400"/>
                                        </div>
                                        <div className="text-xs text-gray-500 uppercase tracking-widest">Polymarket Total Builder Volume</div>
                                        <div className="text-4xl font-black text-gray-900 dark:text-white font-mono">
                                            ${systemStats.builder.ecosystemVolume > 0 ? systemStats.builder.ecosystemVolume.toLocaleString() : 'Loading...'}
                                        </div>
                                        <p className="text-xs text-gray-400 max-w-xs mx-auto pt-4">
                                            This metric tracks the aggregated volume of the top 100 builders in the Polymarket ecosystem.
                                        </p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )}

        {/* WALLET (VAULT REBRAND) */}
        {activeTab === 'vault' && (
            <div className="max-w-5xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-300 pb-10">
                <div className="flex flex-col md:flex-row items-start md:items-center gap-4 mb-8 pb-8 border-b border-gray-200 dark:border-terminal-border">
                    <div className="flex items-center gap-4 w-full md:w-auto">
                        <div className="p-3 bg-blue-50 dark:bg-terminal-accent/10 rounded-xl">
                            <Wallet size={32} className="text-blue-600 dark:text-terminal-accent" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Smart Wallet Config</h2>
                            <p className="text-gray-500 text-sm">Manage keys, risk profiles, and automation.</p>
                        </div>
                    </div>
                    <div className="w-full md:w-auto flex flex-col md:flex-row gap-3 md:items-center md:ml-auto">
                        <div className="flex flex-wrap gap-2">
                            <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 text-[10px] text-gray-500 dark:text-gray-400 font-bold">ZeroDev</div>
                            <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 text-[10px] text-gray-500 dark:text-gray-400 font-bold">Gelato</div>
                            <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 text-[10px] text-gray-500 dark:text-gray-400 font-bold">Polygon</div>
                        </div>
                        <button 
                            onClick={() => setShowArchitecture(true)} 
                            className="text-xs text-blue-600 dark:text-blue-500 hover:text-blue-800 dark:hover:text-white underline text-left md:text-center"
                        >
                            Why is this Secure?
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
                    {/* Security Card */}
                    <div className="md:col-span-5 space-y-6">
                         <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-5 space-y-4 shadow-sm dark:shadow-none">
                             <div className="flex justify-between items-center">
                                 <div className="flex items-center gap-2">
                                     <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white bg-green-600"><Zap size={14}/></div>
                                     <div>
                                         <div className="text-sm font-bold text-gray-900 dark:text-white">Smart Bot</div>
                                         <div className="text-[10px] text-gray-500">Kernel v3.1</div>
                                     </div>
                                 </div>
                                 <div className="text-[10px] font-bold px-2 py-1 rounded border border-green-500 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-500/10">ACTIVE</div>
                             </div>
                             <div className="p-3 bg-gray-50 dark:bg-black/40 rounded border border-gray-200 dark:border-gray-800 space-y-2">
                                 <div className="flex justify-between">
                                     <span className="text-xs text-gray-500">Address</span>
                                     <span className="text-xs font-mono text-gray-900 dark:text-white break-all text-right ml-4">{proxyAddress}</span>
                                 </div>
                             </div>
                             <div className="flex justify-between items-center pt-2">
                                 <div className="text-[10px] text-gray-500">{stats?.tradesCount || 0} Total Trades</div>
                                 <button onClick={openWithdrawModal} className="px-3 py-1 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-500 text-xs font-bold rounded hover:bg-red-100 dark:hover:bg-red-900/40">Trustless Withdraw</button>
                             </div>
                         </div>
                         {/* API Keys */}
                         <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-5 space-y-3 shadow-sm dark:shadow-none">
                             <label className="text-xs text-gray-500 font-bold uppercase">Gemini API Key</label>
                             <div className="relative">
                                 <input 
                                     type={showSecrets ? "text" : "password"}
                                     className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded px-3 py-2 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-blue-500 dark:focus:border-terminal-accent"
                                     value={config.geminiApiKey}
                                     onChange={e => updateConfig({...config, geminiApiKey: e.target.value})}
                                 />
                                 <button onClick={() => setShowSecrets(!showSecrets)} className="absolute right-3 top-2 text-gray-500 hover:text-gray-900 dark:hover:text-white">
                                     {showSecrets ? <EyeOff size={14}/> : <Eye size={14}/>}
                                 </button>
                             </div>
                         </div>
                    </div>

                    {/* Automation Config */}
                    <div className="md:col-span-7 space-y-6">
                        <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-6 shadow-sm dark:shadow-none">
                            <label className="text-xs text-gray-500 font-bold uppercase mb-3 block">Target Wallets</label>
                            <div className="flex gap-2 mb-4">
                                <input 
                                    className="flex-1 bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded px-3 py-2 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-blue-500 dark:focus:border-terminal-accent"
                                    placeholder="0x..."
                                    value={targetInput}
                                    onChange={e => setTargetInput(e.target.value)}
                                />
                                <button onClick={addTarget} className="px-4 bg-blue-600 dark:bg-terminal-accent rounded text-white font-bold text-xs">ADD</button>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {config.targets.map(t => (
                                    <span key={t} className="px-3 py-1.5 bg-gray-100 dark:bg-white/5 rounded border border-gray-200 dark:border-white/10 text-xs text-gray-700 dark:text-gray-300 font-mono flex gap-2">
                                        {t.slice(0,6)}...{t.slice(-4)} 
                                        <button onClick={() => removeTarget(t)}><X size={12}/></button>
                                    </span>
                                ))}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                            <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-5 shadow-sm dark:shadow-none">
                                <div className="flex items-center justify-between mb-3">
                                    <label className="text-xs text-gray-500 font-bold uppercase">Risk Profile</label>
                                    <Tooltip text="Conservative: Low volatility. Balanced: Standard EV. Degen: High risk/reward." />
                                </div>
                                <div className="space-y-2">
                                    {['conservative', 'balanced', 'degen'].map(mode => (
                                        <button key={mode} onClick={() => updateConfig({...config, riskProfile: mode as any})} className={`w-full py-2 px-3 rounded text-xs font-bold uppercase border transition-all flex justify-between ${config.riskProfile === mode ? 'bg-blue-50 dark:bg-terminal-accent/10 border-blue-500 dark:border-terminal-accent text-blue-600 dark:text-terminal-accent' : 'border-gray-200 dark:border-gray-800 text-gray-500'}`}>
                                            {mode} {config.riskProfile === mode && <CheckCircle2 size={12}/>}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-5 space-y-5 shadow-sm dark:shadow-none">
                                <div>
                                    <label className="text-xs text-gray-500 font-bold uppercase mb-2 block flex justify-between">Multiplier <span className="text-gray-900 dark:text-white">x{config.multiplier}</span></label>
                                    <input type="number" step="0.1" className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded px-3 py-2 text-sm text-gray-900 dark:text-white font-mono" value={config.multiplier} onChange={e => updateConfig({...config, multiplier: Number(e.target.value)})}/>
                                </div>
                                <div>
                                    <label className="text-xs text-gray-500 font-bold uppercase mb-2 block flex justify-between">Auto TP <span className="text-green-600 dark:text-terminal-success">+{config.autoTp}%</span></label>
                                    <input type="range" min="5" max="100" className="w-full accent-green-600 dark:accent-terminal-success h-1 bg-gray-200 dark:bg-gray-800 rounded-lg appearance-none cursor-pointer" value={config.autoTp} onChange={e => updateConfig({...config, autoTp: Number(e.target.value)})}/>
                                </div>
                            </div>
                        </div>

                        {/* Full Automation Section Restored */}
                        <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-6 space-y-6 shadow-sm dark:shadow-none">
                             <h4 className="text-xs font-bold text-gray-900 dark:text-white uppercase tracking-wider mb-4 border-b border-gray-200 dark:border-gray-800 pb-2">Advanced Automation</h4>
                             
                             {/* Auto Cashout */}
                             <div className="flex items-start gap-4">
                                <div className="mt-1">
                                    <input 
                                        type="checkbox" 
                                        className="accent-green-500 w-4 h-4"
                                        checked={config.enableAutoCashout}
                                        onChange={e => updateConfig({...config, enableAutoCashout: e.target.checked})}
                                    />
                                </div>
                                <div className="flex-1 space-y-3">
                                    <div className="flex justify-between">
                                        <span className="text-sm font-bold text-gray-900 dark:text-white">Auto-Cashout Profits</span>
                                        {config.enableAutoCashout && <span className="text-[10px] text-green-600 dark:text-green-500 font-bold">ENABLED</span>}
                                    </div>
                                    {config.enableAutoCashout && (
                                        <div className="grid grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-2">
                                            <div>
                                                <label className="text-[10px] text-gray-500 uppercase font-bold block mb-1">Threshold ($)</label>
                                                <input 
                                                    type="number"
                                                    className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded px-2 py-1.5 text-xs text-gray-900 dark:text-white"
                                                    value={config.maxRetentionAmount}
                                                    onChange={e => updateConfig({...config, maxRetentionAmount: Number(e.target.value)})}
                                                />
                                            </div>
                                            <div>
                                                <label className="text-[10px] text-gray-500 uppercase font-bold block mb-1">Dest. Address</label>
                                                <input 
                                                    type="text"
                                                    className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded px-2 py-1.5 text-xs text-gray-900 dark:text-white"
                                                    placeholder="0x..."
                                                    value={config.coldWalletAddress}
                                                    onChange={e => updateConfig({...config, coldWalletAddress: e.target.value})}
                                                />
                                            </div>
                                        </div>
                                    )}
                                    <p className="text-[10px] text-gray-500">Automatically sweeps funds above the retention limit to your cold wallet.</p>
                                </div>
                             </div>

                             {/* Notifications */}
                             <div className="flex items-start gap-4 pt-4 border-t border-gray-200 dark:border-gray-800">
                                <div className="mt-1">
                                    <input 
                                        type="checkbox" 
                                        className="accent-blue-500 w-4 h-4"
                                        checked={config.enableNotifications}
                                        onChange={e => updateConfig({...config, enableNotifications: e.target.checked})}
                                    />
                                </div>
                                <div className="flex-1 space-y-3">
                                    <div className="flex justify-between">
                                        <span className="text-sm font-bold text-gray-900 dark:text-white">SMS Notifications</span>
                                        {config.enableNotifications && <span className="text-[10px] text-blue-600 dark:text-blue-500 font-bold">ENABLED</span>}
                                    </div>
                                    {config.enableNotifications && (
                                        <div className="animate-in fade-in slide-in-from-top-2">
                                            <label className="text-[10px] text-gray-500 uppercase font-bold block mb-1">Phone Number</label>
                                            <input 
                                                type="text"
                                                placeholder="+1234567890"
                                                className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded px-2 py-1.5 text-xs text-gray-900 dark:text-white"
                                                value={config.userPhoneNumber}
                                                onChange={e => updateConfig({...config, userPhoneNumber: e.target.value})}
                                            />
                                        </div>
                                    )}
                                </div>
                             </div>

                             {/* Sound Settings */}
                             <div className="flex items-start gap-4 pt-4 border-t border-gray-200 dark:border-gray-800">
                                <div className="mt-1">
                                    <button onClick={() => updateConfig({...config, enableSounds: !config.enableSounds})} className={`p-1 rounded-full transition-colors ${config.enableSounds ? 'bg-purple-100 dark:bg-purple-900/20 text-purple-600' : 'text-gray-400'}`}>
                                        {config.enableSounds ? <Volume2 size={16}/> : <VolumeX size={16}/>}
                                    </button>
                                </div>
                                <div className="flex-1">
                                    <div className="flex justify-between">
                                        <span className="text-sm font-bold text-gray-900 dark:text-white">Sound Effects</span>
                                        <span className="text-[10px] text-gray-500">{config.enableSounds ? 'ON' : 'OFF'}</span>
                                    </div>
                                    <p className="text-[10px] text-gray-500 mt-1">Play sounds on start, stop, and trade execution.</p>
                                </div>
                             </div>
                        </div>

                        <div className="flex justify-end">
                            <button onClick={saveConfig} className="px-8 py-3 bg-black dark:bg-white text-white dark:text-black font-bold rounded-lg shadow-lg hover:opacity-80 transition-all flex items-center gap-2"><Save size={16} /> SAVE CONFIG</button>
                        </div>
                    </div>
                </div>
                
                {/* Security Modal */}
                {showArchitecture && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
                        <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl max-w-2xl w-full p-8 relative shadow-2xl">
                            <button onClick={() => setShowArchitecture(false)} className="absolute top-4 right-4 text-gray-500 hover:text-black dark:hover:text-white"><X/></button>
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2"><Shield className="text-green-500"/> Security Architecture</h3>
                            <div className="space-y-6">
                                <div className="flex items-center justify-between gap-4 p-4 bg-gray-50 dark:bg-white/5 rounded-lg">
                                    <div className="text-center">
                                        <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-2"><Key className="text-white"/></div>
                                        <div className="text-sm font-bold text-gray-900 dark:text-white">Your Key</div>
                                        <div className="text-[10px] text-gray-500">Held by You</div>
                                    </div>
                                    <div className="flex-1 h-0.5 bg-green-500 relative"><div className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] text-green-500 font-bold bg-white dark:bg-black px-1">ADMIN CONTROL</div></div>
                                    <div className="text-center">
                                        <div className="w-12 h-12 bg-purple-600 rounded-full flex items-center justify-center mx-auto mb-2"><Zap className="text-white"/></div>
                                        <div className="text-sm font-bold text-gray-900 dark:text-white">Smart Account</div>
                                        <div className="text-[10px] text-gray-500">On Blockchain</div>
                                    </div>
                                    <div className="flex-1 h-0.5 bg-yellow-500 relative"><div className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] text-yellow-500 font-bold bg-white dark:bg-black px-1">SESSION KEY</div></div>
                                    <div className="text-center">
                                        <div className="w-12 h-12 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-2"><Server className="text-gray-400"/></div>
                                        <div className="text-sm font-bold text-gray-900 dark:text-white">Bot Server</div>
                                        <div className="text-[10px] text-gray-500">Trade Only</div>
                                    </div>
                                </div>
                                <ul className="space-y-2 text-sm text-gray-500 dark:text-gray-400 list-disc pl-5">
                                    <li>The server <strong>never</strong> sees your Private Key.</li>
                                    <li>The server holds a temporary <strong>Session Key</strong> that can ONLY trade.</li>
                                    <li>The Session Key <strong>cannot withdraw</strong> funds.</li>
                                    <li>You can revoke the Session Key on-chain at any time.</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        )}

        {/* MARKETPLACE (REGISTRY) */}
        {activeTab === 'marketplace' && (
             <div className="flex flex-col h-full gap-6 animate-in fade-in slide-in-from-right-4 duration-300">
                <div className="relative glass-panel border border-gray-200 dark:border-terminal-border rounded-xl p-8 overflow-hidden">
                    <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none"><Users size={200} /></div>
                    <div className="relative z-10 max-w-2xl">
                        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2 flex items-center gap-2">
                            Alpha Registry <span className="bg-blue-600 dark:bg-terminal-accent text-xs px-2 py-0.5 rounded text-white font-mono">GLOBAL</span>
                        </h2>
                        <p className="text-sm text-gray-500 max-w-xl mb-6">
                            Discover high-performing wallets. Copy them to earn profit. <br/>
                            <strong>Finder's Rewards:</strong> List any top trader you discover. If others copy them, <span className="text-gray-900 dark:text-white font-bold">YOU earn the 1% fee</span>.
                        </p>
                        <div className="flex gap-2 bg-gray-100 dark:bg-black/50 p-2 rounded-lg border border-gray-200 dark:border-gray-800 max-w-lg">
                            <div className="flex-1 flex items-center px-3">
                                <Smartphone size={16} className="text-gray-500 mr-2"/>
                                <input 
                                    type="text" 
                                    placeholder="0xWalletAddress..." 
                                    className="bg-transparent border-none outline-none text-sm text-gray-900 dark:text-white w-full placeholder:text-gray-500 font-mono"
                                    value={newWalletInput}
                                    onChange={e => setNewWalletInput(e.target.value)}
                                />
                            </div>
                            <button 
                                onClick={addMarketplaceWallet} 
                                disabled={isAddingWallet}
                                className="px-4 py-2 bg-blue-600 dark:bg-terminal-accent hover:bg-blue-500 dark:hover:bg-blue-600 text-white text-xs font-bold rounded flex items-center gap-2 transition-all disabled:opacity-50"
                            >
                                {isAddingWallet ? <RefreshCw size={14} className="animate-spin"/> : <PlusCircle size={14}/>} LIST
                            </button>
                        </div>
                    </div>
                </div>

                <div className="glass-panel border border-gray-200 dark:border-terminal-border rounded-xl overflow-hidden flex-1">
                    <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center bg-gray-50 dark:bg-white/5">
                        <h3 className="font-bold text-gray-900 dark:text-white text-sm flex items-center gap-2"><Server size={14}/> Top Traders</h3>
                        <button onClick={fetchRegistry} className="text-xs text-blue-600 dark:text-terminal-accent flex items-center gap-1 hover:underline"><RefreshCw size={12}/> Refresh</button>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-gray-100 dark:bg-black text-gray-500 text-[10px] uppercase font-bold tracking-wider">
                                <tr>
                                    <th className="p-4 pl-6">Identity</th>
                                    <th className="p-4 text-center">Win Rate</th>
                                    <th className="p-4 text-center">Total PnL</th>
                                    <th className="p-4 text-center">Copies</th>
                                    <th className="p-4 text-right pr-6">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 dark:divide-gray-800 font-mono text-xs">
                                {registry.map((trader) => (
                                    <tr 
                                        key={trader.address} 
                                        onClick={() => setSelectedTrader(trader)}
                                        className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors group cursor-pointer"
                                    >
                                        <td className="p-4 pl-6">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-300 to-gray-200 dark:from-gray-800 dark:to-gray-700 flex items-center justify-center text-xs font-bold text-gray-700 dark:text-white border border-gray-200 dark:border-gray-700">
                                                    {trader.address.slice(2,4)}
                                                </div>
                                                <div>
                                                    <div className="text-gray-900 dark:text-white font-bold flex items-center gap-1">
                                                        {trader.ens || `${trader.address.slice(0,6)}...${trader.address.slice(-4)}`}
                                                        {trader.isVerified && <CheckCircle2 size={12} className="text-green-500"/>}
                                                        {/* OFFICIAL BADGE UPDATE */}
                                                        {((trader as any).isSystem || (trader as any).tags?.includes('OFFICIAL')) && (
                                                            <span className="ml-1 text-[8px] bg-blue-600 text-white px-1.5 py-0.5 rounded uppercase tracking-wider flex items-center gap-0.5">
                                                                <BadgeCheck size={8}/> OFFICIAL
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="p-4 text-center text-green-600 dark:text-green-400 font-bold">{trader.winRate}%</td>
                                        <td className="p-4 text-center text-blue-600 dark:text-blue-400 font-bold">${trader.totalPnl.toLocaleString()}</td>
                                        <td className="p-4 text-center text-gray-500">{trader.copyCount || 0}</td>
                                        <td className="p-4 text-right pr-6" onClick={(e) => e.stopPropagation()}>
                                            {config.targets.includes(trader.address) ? (
                                                <span className="text-green-600 dark:text-green-500 font-bold text-[10px] px-3 py-1 bg-green-50 dark:bg-green-900/20 rounded border border-green-200 dark:border-green-900/30">ACTIVE</span>
                                            ) : (
                                                <button 
                                                    onClick={() => copyFromMarketplace(trader.address)}
                                                    className="text-blue-600 dark:text-blue-500 hover:text-blue-800 dark:hover:text-white font-bold text-[10px] px-3 py-1 bg-blue-50 dark:bg-blue-900/10 hover:bg-blue-100 dark:hover:bg-blue-600 rounded border border-blue-200 dark:border-blue-900/30 transition-all"
                                                >
                                                    COPY
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
                
                {/* --- Render Details Modal --- */}
                {selectedTrader && (
                    <TraderDetailsModal 
                        trader={selectedTrader} 
                        onClose={() => setSelectedTrader(null)}
                    />
                )}
            </div>
        )}

        {/* HISTORY TAB */}
        {activeTab === 'history' && (
             <div className="glass-panel border border-gray-200 dark:border-terminal-border rounded-xl overflow-hidden h-full animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
                    <h3 className="font-bold text-gray-900 dark:text-white flex items-center gap-2"><History size={16} className="text-gray-500"/> Trade Log</h3>
                    <span className="text-xs text-gray-500 font-mono">{history.length} Entries</span>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                        <thead className="bg-gray-100 dark:bg-black text-gray-500 uppercase font-bold tracking-wider">
                            <tr>
                                <th className="p-4 pl-6">Time</th>
                                <th className="p-4">Market</th>
                                <th className="p-4">Side</th>
                                <th className="p-4">Size</th>
                                <th className="p-4">Price</th>
                                <th className="p-4">AI Reasoning</th>
                                <th className="p-4 text-right pr-6">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-gray-800 font-mono">
                            {history.map((tx) => (
                                <tr key={tx.id} className={`hover:bg-gray-50 dark:hover:bg-white/5 transition-colors ${tx.status === 'SKIPPED' ? 'opacity-50 grayscale' : ''}`}>
                                    <td className="p-4 pl-6 text-gray-500">{new Date(tx.timestamp).toLocaleTimeString()}</td>
                                    <td className="p-4 text-gray-900 dark:text-white max-w-[200px] truncate" title={tx.marketId}>{tx.marketId}</td>
                                    <td className="p-4">
                                        <span className={`px-2 py-0.5 rounded font-bold ${tx.side === 'BUY' ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-500' : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-500'}`}>
                                            {tx.side} {tx.outcome}
                                        </span>
                                    </td>
                                    <td className="p-4 text-gray-900 dark:text-white">${tx.size.toFixed(2)}</td>
                                    <td className="p-4 text-gray-500">{tx.price.toFixed(2)}</td>
                                    <td className="p-4 text-gray-500 max-w-[300px] truncate" title={tx.aiReasoning}>
                                        {tx.riskScore ? <span className="text-purple-500 mr-2">[{tx.riskScore}/10]</span> : ''}
                                        {tx.aiReasoning || '-'}
                                    </td>
                                    <td className="p-4 text-right pr-6">
                                        <span className={`font-bold px-2 py-1 rounded text-[10px] ${
                                            tx.status === 'CLOSED' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-500' : 
                                            tx.status === 'SKIPPED' ? 'bg-gray-200 dark:bg-gray-800 text-gray-500' : 
                                            'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-500'
                                        }`}>
                                            {tx.status}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {history.length === 0 && <div className="p-12 text-center text-gray-600 text-sm">No history available yet. Start the bot to generate data.</div>}
                </div>
            </div>
        )}

        {/* HELP PAGE */}
        {activeTab === 'help' && (
            <div className="max-w-5xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-300 pb-20">
                
                {/* Header */}
                <div className="text-center space-y-4 pt-4">
                    <h2 className="text-4xl font-black text-gray-900 dark:text-white tracking-tight flex items-center justify-center gap-3">
                        <BookOpen className="text-blue-600" size={32}/> 
                        <span>Command Center Guide</span>
                    </h2>
                    <p className="text-gray-500 dark:text-gray-400 text-lg max-w-2xl mx-auto">
                        Master the terminal. From onboarding to institutional-grade execution mechanics.
                    </p>
                </div>

                {/* 1. ONBOARDING FLOW */}
                <div className="glass-panel p-8 rounded-2xl border border-gray-200 dark:border-terminal-border relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-6 opacity-5"><Rocket size={150}/></div>
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-8 flex items-center gap-2 relative z-10">
                        <Zap className="text-yellow-500" size={24}/> Setup Workflow
                    </h3>
                    
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-6 relative z-10">
                        {[
                            { icon: ArrowDownCircle, title: "1. Fund", desc: "Deposit USDC via Polygon or Bridge from Sol/Base.", color: "text-blue-500" },
                            { icon: Users, title: "2. Copy", desc: "Select high-win-rate whales from the Registry.", color: "text-purple-500" },
                            { icon: Settings, title: "3. Configure", desc: "Set multipliers, risk profile, and auto-cashout.", color: "text-gray-500" },
                            { icon: Play, title: "4. Launch", desc: "Start the engine. Runs 24/7 on the cloud.", color: "text-green-500" }
                        ].map((step, idx) => (
                            <div key={idx} className="relative p-6 bg-white dark:bg-black/20 rounded-xl border border-gray-200 dark:border-white/10 group hover:border-blue-500/30 transition-all">
                                <div className="absolute -top-3 -left-3 w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center font-bold text-gray-500 text-sm">
                                    {idx + 1}
                                </div>
                                <step.icon size={32} className={`mb-4 ${step.color}`}/>
                                <h4 className="font-bold text-gray-900 dark:text-white mb-2">{step.title}</h4>
                                <p className="text-xs text-gray-500 leading-relaxed">{step.desc}</p>
                            </div>
                        ))}
                    </div>
                </div>

                {/* 2. FUNDING DETAILS (Restored) */}
                <div className="glass-panel p-8 rounded-2xl border border-gray-200 dark:border-terminal-border relative overflow-hidden group">
                    <div className="absolute -right-10 -top-10 opacity-5 group-hover:opacity-10 transition-opacity"><Globe size={200}/></div>
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2 relative z-10">
                        <DollarSign className="text-green-500" size={24}/> Funding Your Bot
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 relative z-10">
                        <div>
                            <h4 className="font-bold text-gray-900 dark:text-white flex items-center gap-2 mb-2">
                                <ArrowRightCircle size={16} className="text-blue-500"/> Direct Deposit
                            </h4>
                            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                                Your Smart Account lives on the <strong>Polygon</strong> blockchain. If you already have USDC on Polygon, simply send it to the address shown in your Dashboard.
                            </p>
                        </div>
                        <div>
                            <h4 className="font-bold text-gray-900 dark:text-white flex items-center gap-2 mb-2">
                                <ArrowRightLeft size={16} className="text-orange-500"/> Cross-Chain Bridge
                            </h4>
                            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                                Funds on Solana, Base, or Ethereum? Use the <strong>Bridge Tab</strong>. Our Li.Fi integration will swap your SOL/ETH to USDC and bridge it to Polygon in a single transaction.
                            </p>
                        </div>
                    </div>
                </div>

                {/* 3. CLOB & ARCHITECTURE (New Tech Specs) */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="glass-panel p-8 rounded-2xl border border-gray-200 dark:border-terminal-border bg-blue-50/50 dark:bg-blue-900/5">
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2">
                            <Server className="text-blue-600" size={24}/> The CLOB Engine
                        </h3>
                        <div className="space-y-6 text-sm text-gray-600 dark:text-gray-400">
                            <p className="leading-relaxed">
                                Bet Mirror is a <strong>Direct Market Access (DMA)</strong> terminal. We do not use side-pools. Every trade you execute is routed directly to the <strong>Polymarket Central Limit Order Book (CLOB)</strong>**.
                            </p>
                            <div className="space-y-3">
                                <div className="flex gap-3">
                                    <CheckCircle2 size={18} className="text-green-500 shrink-0"/>
                                    <div>
                                        <strong className="text-gray-900 dark:text-white">Builder Attribution</strong>
                                        <p className="text-xs mt-1">We inject cryptographic headers into every order, identifying your trades as part of the "Bet Mirror" institutional volume. This qualifies for the Polymarket Builder Program.</p>
                                    </div>
                                </div>
                                <div className="flex gap-3">
                                    <CheckCircle2 size={18} className="text-green-500 shrink-0"/>
                                    <div>
                                        <strong className="text-gray-900 dark:text-white">Atomic Settlement</strong>
                                        <p className="text-xs mt-1">Trades settle instantly on-chain via the CTF Exchange contract.</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="glass-panel p-8 rounded-2xl border border-gray-200 dark:border-terminal-border">
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2">
                            <Shield className="text-purple-600" size={24}/> Architecture Comparison
                        </h3>
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs text-left">
                                <thead>
                                    <tr className="border-b border-gray-200 dark:border-gray-800">
                                        <th className="pb-2 font-bold text-gray-500 uppercase">Feature</th>
                                        <th className="pb-2 font-bold text-gray-500 uppercase">Polymarket Native</th>
                                        <th className="pb-2 font-bold text-blue-600 dark:text-blue-400 uppercase">Bet Mirror Pro</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                                    <tr>
                                        <td className="py-3 font-medium text-gray-900 dark:text-white">Smart Account</td>
                                        <td className="py-3 text-gray-500">Gnosis Safe</td>
                                        <td className="py-3 text-gray-500 font-bold">ZeroDev Kernel v3.1</td>
                                    </tr>
                                    <tr>
                                        <td className="py-3 font-medium text-gray-900 dark:text-white">Signing</td>
                                        <td className="py-3 text-gray-500">Manual (Metamask)</td>
                                        <td className="py-3 text-gray-500 font-bold">Auto (Session Keys)</td>
                                    </tr>
                                    <tr>
                                        <td className="py-3 font-medium text-gray-900 dark:text-white">Gas Fee</td>
                                        <td className="py-3 text-gray-500">Relayer</td>
                                        <td className="py-3 text-gray-500 font-bold">ERC-4337 Paymaster</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                {/* 4. SECURITY & RECOVERY (Restored Deep Dives) */}
                <div className="glass-panel p-8 rounded-2xl border border-gray-200 dark:border-terminal-border">
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2">
                        <Lock className="text-orange-500" size={24}/> Non-Custodial Security & Recovery
                    </h3>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                        <div className="p-5 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/5">
                            <h4 className="font-bold text-gray-900 dark:text-white mb-2 text-sm flex items-center gap-2">
                                <Key size={16} className="text-blue-500"/> 1. The Owner Key (You)
                            </h4>
                            <p className="text-xs text-gray-500 leading-relaxed">
                                Held in your browser wallet. Has <strong>Root Admin</strong> access. Because the Smart Account is on Polygon, 
                                you must switch to the Polygon network to sign "Admin" transactions (like withdrawals), even if your main funds are on Solana.
                            </p>
                        </div>
                        <div className="p-5 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/5">
                            <h4 className="font-bold text-gray-900 dark:text-white mb-2 text-sm flex items-center gap-2">
                                <Server size={16} className="text-orange-500"/> 2. The Session Key (Us)
                            </h4>
                            <p className="text-xs text-gray-500 leading-relaxed">
                                The server holds a limited "Session Key". The Smart Contract is programmed to <strong>REJECT</strong> any withdrawal attempt signed by this key. 
                                It is only allowed to call `createOrder` on Polymarket.
                            </p>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-8 border-t border-gray-200 dark:border-gray-800">
                        <div>
                            <h4 className="font-bold text-gray-900 dark:text-white mb-3 text-sm flex items-center gap-2">
                                <Fuel size={16} className="text-purple-500"/> Gas Abstraction (Paymaster)
                            </h4>
                            <p className="text-xs text-gray-500 leading-relaxed">
                                Normally, you need <strong>MATIC</strong> (POL) to pay for fees on Polygon. This is annoying. 
                                We use a "Paymaster" service. When you trade, the Paymaster pays the MATIC for you. 
                                In exchange, the Smart Account takes a tiny amount of USDC to reimburse it. 
                                <strong>Result: You never need to buy MATIC.</strong>
                            </p>
                        </div>
                        <div>
                            <h4 className="font-bold text-gray-900 dark:text-white mb-3 text-sm flex items-center gap-2">
                                <RefreshCw size={16} className="text-red-500"/> Emergency Recovery
                            </h4>
                            <p className="text-xs text-gray-500 leading-relaxed">
                                <strong>"What if the website disappears?"</strong><br/>
                                Your funds live on the Blockchain, not our servers. Your address is deterministic. 
                                You can interact with it directly via any ERC-4337 explorer (like <a href="https://jiffyscan.xyz/" target="_blank" className="text-blue-500 hover:underline">Jiffyscan</a>) or the ZeroDev recovery portal. 
                                As long as you have your MetaMask seed phrase, your funds are safe.
                            </p>
                        </div>
                    </div>
                </div>

                {/* 5. ECONOMICS (Restored) */}
                <div className="glass-panel p-6 rounded-xl border border-gray-200 dark:border-terminal-border bg-green-50/50 dark:bg-green-900/5 flex items-start gap-4">
                    <div className="p-3 bg-green-100 dark:bg-green-900/20 rounded-full text-green-600 dark:text-green-500 shrink-0">
                        <Coins size={24}/>
                    </div>
                    <div>
                        <h4 className="font-bold text-gray-900 dark:text-white mb-1">How does the 1% Fee work?</h4>
                        <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                            When you copy a profitable trade, 1% of the <em>net profit</em> is sent to the <strong>Lister</strong> (the user who discovered and added that wallet to the registry).
                            <br/>
                            You can earn passive income simply by finding and listing high-win-rate whales for others to copy.
                        </p>
                    </div>
                </div>

            </div>
        )}

      </main>
      
      <FeedbackWidget userId={userAddress} />
      
      {/* Landing View Helper */}
      {!isConnected && <Landing onConnect={handleConnect} theme={theme} toggleTheme={toggleTheme} />}
      
      {/* Deposit Modal */}
      <DepositModal
        isOpen={isDepositModalOpen}
        onClose={() => setIsDepositModalOpen(false)}
        balances={mainWalletBal}
        onDeposit={handleDeposit}
        isDepositing={isDepositing}
        onBridgeRedirect={() => { setIsDepositModalOpen(false); setActiveTab('bridge'); }}
      />

      {/* Withdrawal Modal */}
      <WithdrawalModal 
        isOpen={isWithdrawModalOpen}
        onClose={() => { setIsWithdrawModalOpen(false); setWithdrawalTxHash(null); }}
        balances={proxyWalletBal}
        onWithdraw={handleWithdraw}
        isWithdrawing={isWithdrawing}
        successTx={withdrawalTxHash}
      />

    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
