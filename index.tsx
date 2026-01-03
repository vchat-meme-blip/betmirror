
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'react-toastify';
import axios from 'axios';
import { getMarketWebSocketService } from './src/services/market-ws.service';
import './src/index.css';
import { 
Shield, Play, Square, Activity, Settings, Wallet, Key, Link,
Terminal, Trash2, Eye, EyeOff, Save, Lock, Users, RefreshCw, Server, Sparkles, DollarSign,
TrendingUp, History, Copy, ExternalLink, AlertTriangle, Smartphone, Coins, PlusCircle, X,
CheckCircle2, ArrowDownCircle, ArrowUpCircle, Brain, AlertCircle, Trophy, Globe, Zap, LogOut,
Info, HelpCircle, ChevronRight, Rocket, Gauge, MessageSquare, Star, ArrowRightLeft, LifeBuoy,
Sun, Moon, Loader2, Timer, Fuel, Check, BarChart3, ChevronDown, MousePointerClick,
Zap as ZapIcon, FileText, Twitter, Github, LockKeyhole, BadgeCheck, Search, BookOpen, ArrowRightCircle,
Volume2, VolumeX, Menu, ArrowUpDown, Clipboard, Wallet2, ArrowDown, Sliders, Bell, ShieldAlert,
Wrench, Fingerprint, ShieldCheck, Clock, Scale, Landmark
} from 'lucide-react';
import { web3Service, USDC_POLYGON, USDC_BRIDGED_POLYGON, USDC_ABI } from './src/services/web3.service';
import { lifiService, BridgeTransactionRecord } from './src/services/lifi-bridge.service';
import { TradeHistoryEntry, ActivePosition } from './src/domain/trade.types';
import { TraderProfile, CashoutRecord, BuilderVolumeData } from './src/domain/alpha.types';
import { UserStats } from './src/domain/user.types';
import { ArbitrageOpportunity } from './src/adapters/interfaces';
import { Contract, BrowserProvider, JsonRpcProvider, formatUnits } from 'ethers';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Area, AreaChart } from 'recharts';

// Format numbers to compact form (1K, 1M, 1B, etc.)
const formatCompactNumber = (num: number): string => {
  if (num < 1000) return num.toString();
  if (num < 1000000) return (num / 1000).toFixed(1) + 'K';
  if (num < 1000000000) return (num / 1000000).toFixed(1) + 'M';
  return (num / 1000000000).toFixed(1) + 'B';
};

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

// --- Performance Chart Component ---
const PerformanceChart = ({ userId, selectedRange }: { 
    userId: string;
    selectedRange: '1W' | '30D' | 'ALL';
}) => {
    const [portfolioData, setPortfolioData] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchPortfolioData = async () => {
            if (!userId) return;
            
            try {
                setLoading(true);
                const response = await axios.get(`/api/portfolio/snapshots/${userId}?period=${selectedRange}`);
                const data = response.data;
                // Ensure we always set an array
                setPortfolioData(Array.isArray(data) ? data : []);
            } catch (error: any) {
                console.error('Failed to fetch portfolio data:', error);
                setPortfolioData([]);
            } finally {
                setLoading(false);
            }
        };

        fetchPortfolioData();
    }, [userId, selectedRange]);

    if (loading) {
        return (
            <div className="h-32 flex items-center justify-center text-gray-400 dark:text-gray-600">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-500 mx-auto mb-2"></div>
                    <p className="text-xs">Loading...</p>
                </div>
            </div>
        );
    }

    if (portfolioData.length === 0) {
        return (
            <div className="h-32 flex items-center justify-center text-gray-400 dark:text-gray-600">
                <div className="text-center">
                    <TrendingUp size={24} className="opacity-50" />
                    <p className="text-xs mt-2">No performance data yet</p>
                </div>
            </div>
        );
    }

    // Transform data for chart
    const chartData = Array.isArray(portfolioData) && portfolioData.length > 0 ? portfolioData.map(snapshot => ({
        timestamp: new Date(snapshot.timestamp).getTime(),
        date: new Date(snapshot.timestamp).toLocaleDateString(),
        portfolioValue: snapshot.totalValue,
        cash: snapshot.cashBalance,
        positionsValue: snapshot.positionsValue,
        pnl: snapshot.totalPnL,
        pnlPercent: snapshot.totalPnLPercent,
        trades: snapshot.positionsCount
    })) : [];

    return (
        <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 10 }}>
                    <defs>
                        <linearGradient id="colorPortfolio" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/>
                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.1}/>
                        </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.1} />
                    <XAxis 
                        dataKey="date" 
                        tick={{ fontSize: 10, fill: '#6b7280' }}
                        axisLine={{ stroke: '#374151', opacity: 0.2 }}
                    />
                    <YAxis 
                        tick={{ fontSize: 10, fill: '#6b7280' }}
                        axisLine={{ stroke: '#374151', opacity: 0.2 }}
                        tickFormatter={(value) => `$${value}`}
                    />
                    <RechartsTooltip 
                        contentStyle={{ 
                            backgroundColor: '#1f2937', 
                            border: '1px solid #374151',
                            borderRadius: '8px',
                            fontSize: '12px'
                        }}
                        labelStyle={{ color: '#f3f4f6' }}
                        formatter={(value: number | undefined, name: string | undefined) => [
                            `$${(value || 0).toFixed(2)}`, 
                            name === 'portfolioValue' ? 'Portfolio' : 
                            name === 'pnl' ? 'P&L' : 
                            name === 'cash' ? 'Cash' : 
                            name === 'positionsValue' ? 'Positions' : value
                        ]}
                        labelFormatter={(label: string) => `Date: ${label}`}
                    />
                    <Area 
                        type="monotone" 
                        dataKey="portfolioValue" 
                        stroke="#3b82f6"
                        fill="url(#colorPortfolio)"
                        strokeWidth={2}
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
};

/**
 * Money Market Feed - Displays available money market opportunities
 * for providing liquidity and earning yield through market making
 */
const MoneyMarketFeed = ({ opportunities, onExecute, isAutoArb }: { 
    opportunities: ArbitrageOpportunity[], 
    onExecute: (opp: ArbitrageOpportunity) => void, 
    isAutoArb: boolean 
}) => {
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {opportunities.length === 0 ? (
                <div className="col-span-full py-20 text-center text-gray-500 italic bg-white/5 rounded-3xl border border-dashed border-white/10">
                    <Landmark size={48} className="mx-auto mb-4 opacity-20"/>
                    <p className="text-sm uppercase tracking-widest font-bold">Scanning Money Markets...</p>
                    <p className="text-xs mt-2 opacity-50">Yield opportunities will appear when spreads are favorable.</p>
                </div>
            ) : (
                opportunities.map((opp) => {
                    const spreadCents = (opp.spread * 100).toFixed(1);
                    const rewardEligible = opp.rewardsMaxSpread && opp.spread <= opp.rewardsMaxSpread;
                    const marketLink = opp.marketSlug ? `https://polymarket.com/market/${opp.marketSlug}` : null;

                    return (
                        <div key={opp.tokenId} className="glass-panel p-6 rounded-3xl border border-emerald-500/20 hover:border-emerald-500/50 transition-all group relative overflow-hidden flex flex-col">
                            {isAutoArb && (
                                <div className="absolute top-0 right-0 px-3 py-1 bg-blue-500 text-white text-[8px] font-black uppercase tracking-tighter rounded-bl-xl z-20">
                                    Autonomous MM Active
                                </div>
                            )}
                            
                            <div className="flex justify-between items-start mb-4">
                                <div className="flex gap-3 items-center">
                                    {opp.image ? (
                                        <img src={opp.image} alt="" className="w-12 h-12 rounded-xl object-cover border border-white/10" />
                                    ) : (
                                        <div className="p-3 bg-blue-500/10 rounded-xl text-blue-500">
                                            <Landmark size={24}/>
                                        </div>
                                    )}
                                </div>
                                <div className="text-right">
                                    <div className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em]">Target ROI</div>
                                    <div className="text-2xl font-black text-blue-500">+{opp.spreadPct.toFixed(2)}%</div>
                                </div>
                            </div>

                            <h4 className="font-bold text-gray-900 dark:text-white text-sm line-clamp-2 mb-6 h-10 leading-tight flex-grow">{opp.question}</h4>
                            
                            <div className="grid grid-cols-2 gap-2 mb-4">
                                <div className="p-2 bg-black/20 rounded-xl border border-white/5">
                                    <div className="text-[8px] text-gray-500 font-bold uppercase tracking-widest">Total Volume</div>
                                    <div className="text-xs font-mono font-bold text-white">${formatCompactNumber(opp.volume || 0)}</div>
                                </div>
                                <div className="p-2 bg-black/20 rounded-xl border border-white/5">
                                    <div className="text-[8px] text-gray-500 font-bold uppercase tracking-widest">Deep Liquidity</div>
                                    <div className="text-xs font-mono font-bold text-white">${formatCompactNumber(opp.liquidity || 0)}</div>
                                </div>
                            </div>

                            <div className="space-y-4 bg-black/20 p-4 rounded-2xl mb-6 border border-white/5">
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-gray-500 uppercase font-black tracking-widest">Bid-Ask Spread</span>
                                    <span className="font-mono text-blue-400 font-bold">{spreadCents}¢</span>
                                </div>
                                <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden flex">
                                    <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 shadow-[0_0_10px_#3b82f6]" style={{ width: `${Math.min(100, opp.spreadPct * 10)}%` }}></div>
                                </div>
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-gray-500 uppercase font-black tracking-widest">Midpoint</span>
                                    <span className="font-mono text-white font-bold">${opp.midpoint.toFixed(3)}</span>
                                </div>
                            </div>

                            {rewardEligible && (
                                <div className="mb-4 p-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-[9px] font-black text-yellow-600 text-center uppercase tracking-widest">
                                    💰 Reward Eligible (Spread ≤ {opp.rewardsMaxSpread}%)
                                </div>
                            )}

                            <div className="flex flex-col gap-2">
                                <button 
                                    onClick={() => onExecute(opp)} 
                                    className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white font-black rounded-xl text-xs transition-all shadow-lg shadow-blue-600/20 flex items-center justify-center gap-2 group-hover:-translate-y-1"
                                >
                                    <ZapIcon size={16}/> DEPLOY MM STRATEGY
                                </button>
                                {marketLink && (
                                    <a 
                                        href={marketLink} 
                                        target="_blank" 
                                        rel="noreferrer"
                                        className="w-full py-2 bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 font-bold rounded-xl text-[10px] text-center uppercase tracking-widest transition-all flex items-center justify-center gap-1"
                                    >
                                        Inspect on Polymarket <ExternalLink size={10}/>
                                    </a>
                                )}
                            </div>
                        </div>
                    );
                })
            )}
        </div>
    );
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
minLiquidityFilter: 'HIGH' | 'MEDIUM' | 'LOW';
autoTp: number;
enableNotifications: boolean;
userPhoneNumber: string;
enableAutoCashout: boolean;
maxRetentionAmount: number;
maxTradeAmount: number; 
coldWalletAddress: string;
enableSounds: boolean; 
enableAutoArb: boolean;
}

interface WalletBalances {
    native: string;
    usdc: string;
    usdcBridged?: string; 
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

// --- Enhanced Sound Manager ---
const playSound = (type: 'start' | 'stop' | 'trade' | 'cashout' | 'error' | 'success') => {
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
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-terminal-border rounded text-[10px] text-gray-600 dark:text-gray-300 shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 leading-relaxed">
            {text}
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white dark:bg-gray-900 border-b border-r border-gray-200 dark:border-gray-700 rotate-45"></div>
        </div>
    </div>
);

const HelpGuideModal = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/90 backdrop-blur-md p-4 animate-in fade-in duration-300">
            <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-3xl w-full max-w-3xl max-h-[85vh] overflow-y-auto relative shadow-2xl">
                <button onClick={onClose} className="absolute top-6 right-6 p-2 bg-gray-100 dark:bg-white/5 rounded-full hover:bg-gray-200 dark:hover:bg-white/10 transition-colors">
                    <X size={20} className="text-gray-500 dark:text-gray-400" />
                </button>
                
                <div className="p-8 md:p-12">
                    <div className="flex items-center gap-4 mb-8">
                        <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-lg">
                            <Activity size={24} />
                        </div>
                        <div>
                            <h2 className="text-2xl font-black text-gray-900 dark:text-white uppercase tracking-tight">Institutional Protocols</h2>
                            <p className="text-sm text-gray-500 uppercase tracking-widest font-bold">Standard Operating Procedure v4.0</p>
                        </div>
                    </div>

                    <div className="grid gap-8">
                        <section className="space-y-3">
                            <h3 className="text-xs font-bold text-blue-600 dark:text-blue-400 uppercase tracking-[0.2em] flex items-center gap-2">
                                <Zap size={14} /> 01. The Core Concept
                            </h3>
                            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                                Bet Mirror Pro is a cloud-based execution terminal. Unlike browser-based scripts, your bot maintains a persistent connection to the Polymarket CLOB via a <span className="text-gray-900 dark:text-white font-bold">Gnosis Safe Smart Vault</span>. This allows for 24/7 automated mirroring even when your devices are offline.
                            </p>
                        </section>

                        <section className="space-y-3">
                            <h3 className="text-xs font-bold text-purple-600 dark:text-purple-400 uppercase tracking-[0.2em] flex items-center gap-2">
                                <Zap size={14} /> 02. Gasless Revolution
                            </h3>
                            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                                As an authorized <span className="text-gray-900 dark:text-white font-bold">Polymarket Builder</span>, we route all trades through the official Relayer. Gas fees (POL/Matic) are abstracted away. 100% of your deposit goes toward position sizing, maximizing capital efficiency.
                            </p>
                        </section>

                        <section className="p-6 bg-yellow-50 dark:bg-yellow-900/10 rounded-2xl border border-yellow-200 dark:border-yellow-900/30 space-y-4">
                            <h3 className="text-xs font-bold text-yellow-800 dark:text-yellow-500 uppercase tracking-[0.2em] flex items-center gap-2">
                                <AlertCircle size={14} /> 03. Unbreakable Exchange Rules
                            </h3>
                            <div className="grid sm:grid-cols-2 gap-4">
                                <div className="space-y-1">
                                    <p className="text-[11px] font-black uppercase text-yellow-900 dark:text-yellow-400">$1.00 Floor Rule</p>
                                    <p className="text-xs text-yellow-800/80 dark:text-yellow-600">The exchange rejects any order worth less than $1.00. Small whale signals are automatically "Floor Boosted" to $1.00.</p>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-[11px] font-black uppercase text-yellow-900 dark:text-yellow-400">5-Share Minimum</p>
                                    <p className="text-xs text-yellow-800/80 dark:text-yellow-600">Every position must contain at least 5 shares. The bot will scale your entry size to meet this exchange requirement.</p>
                                </div>
                                <div className="space-y-1 col-span-full">
                                    <p className="text-[11px] font-black uppercase text-yellow-900 dark:text-yellow-400">The "Stuck" Sell condition</p>
                                    <p className="text-xs text-yellow-800/80 dark:text-yellow-600">If your position value drops below $1.00, you cannot sell until the price recovers. This is a limit of the Polymarket CLOB.</p>
                                </div>
                            </div>
                        </section>

                        <section className="space-y-3">
                            <h3 className="text-xs font-bold text-green-600 dark:text-green-400 uppercase tracking-[0.2em] flex items-center gap-2">
                                <TrendingUp size={14} /> 04. Proven Methodologies
                            </h3>
                            <div className="grid sm:grid-cols-2 gap-4">
                                <div className="p-4 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-100 dark:border-white/5">
                                    <p className="font-bold text-gray-900 dark:text-white text-xs mb-1">The 70% Sniper</p>
                                    <p className="text-[10px] text-gray-500">Targets traders with high accuracy. Set a 1.0x multiplier and 10% Auto Take-Profit to compound gains faster than the whale.</p>
                                </div>
                                <div className="p-4 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-100 dark:border-white/5">
                                    <p className="font-bold text-gray-900 dark:text-white text-xs mb-1">Whale Shadowing</p>
                                    <p className="text-[10px] text-gray-500">Copy high-volume leaders at 0.1x to 0.5x. You are providing liquidity and catching momentum waves early.</p>
                                </div>
                            </div>
                        </section>
                    </div>

                    <button 
                        onClick={onClose}
                        className="mt-12 w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-2xl text-xs transition-all shadow-lg shadow-blue-600/20 flex items-center justify-center gap-2 uppercase tracking-widest"
                    >
                        I Understand the Protocols
                    </button>
                </div>
            </div>
        </div>
    );
};

const DepositModal = ({
    isOpen,
    onClose,
    balances,
    onDeposit,
    isDepositing,
    onBridgeRedirect,
    targetAddress 
}: {
    isOpen: boolean;
    onClose: () => void;
    balances: WalletBalances;
    onDeposit: (amount: string, tokenType: 'USDC.e' | 'USDC' | 'POL') => void;
    isDepositing: boolean;
    onBridgeRedirect: () => void;
    targetAddress: string;
}) => {
    const [amount, setAmount] = useState('');
    const [assetTab, setAssetTab] = useState<'USDC' | 'POL'>('USDC');
    const [selectedUsdcType, setSelectedUsdcType] = useState<'USDC.e' | 'USDC'>('USDC.e');

    useEffect(() => {
        if (isOpen) {
            const bridgedBal = parseFloat(balances.usdcBridged || '0');
            const nativeBal = parseFloat(balances.usdcNative || '0');
            if (nativeBal > bridgedBal && nativeBal > 0) {
                setSelectedUsdcType('USDC'); 
            } else {
                setSelectedUsdcType('USDC.e'); 
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
    const isLowBalance = activeBalanceNum < 0.05;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-2xl w-full max-w-md p-6 shadow-2xl relative">
                <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-gray-900 dark:hover:text-white"><X/></button>

                <div className="text-center mb-6">
                    <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/20 rounded-full flex items-center justify-center mx-auto mb-3 text-blue-600 dark:text-blue-500">
                        <ArrowDown size={24}/>
                    </div>
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white">Deposit Funds</h3>
                    <p className="text-xs text-gray-500 mt-1">Main Wallet (You) <span className="mx-1">→</span> Safe Wallet (Vault)</p>
                    <div className="mt-2 text-[10px] bg-blue-50 dark:bg-blue-900/10 px-2 py-1 rounded inline-block text-blue-500">
                        Target: {targetAddress ? `${targetAddress.slice(0,6)}...${targetAddress.slice(-4)}` : '...'}
                    </div>
                </div>

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
                            className={`p-3 rounded-xl border cursor-pointer transition-all ${selectedUsdcType === 'USDC' ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-500 dark:border-blue-500 ring-1 ring-green-500' : 'bg-gray-50 dark:bg-black/20 border-gray-200 dark:border-gray-800 hover:border-gray-300'}`}
                        >
                            <div className="text-[10px] text-gray-500 font-bold uppercase mb-1">Native (Circle)</div>
                            <div className="text-sm font-mono font-bold text-gray-900 dark:text-white flex justify-between items-center">
                                USDC 
                                <span className="text-blue-600 dark:text-blue-400 text-xs">${balances.usdcNative || '0.00'}</span>
                            </div>
                        </div>
                    </div>
                )}

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
    signerBalances, 
    onWithdraw, 
    isWithdrawing,
    successTx 
}: { 
    isOpen: boolean; 
    onClose: () => void; 
    balances: WalletBalances; 
    signerBalances: WalletBalances;
    onWithdraw: (tokenType: 'USDC' | 'USDC.e' | 'POL', isRescue?: boolean, targetSafe?: string) => void;
    isWithdrawing: boolean;
    successTx?: string | null;
}) => {
    const [isRescueMode, setIsRescueMode] = useState(false);
    const [customSafeAddress, setCustomSafeAddress] = useState('');

    if (!isOpen) return null;

    const hasStuckFunds = parseFloat(signerBalances.usdcBridged || '0') > 0.5;

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
                            Your funds are on the way. The server has executed the transfer from the Safe.
                        </p>
                        
                        <div className="p-3 bg-gray-50 dark:bg-black/40 rounded-xl border border-gray-200 dark:border-gray-800 text-[10px] font-mono text-gray-600 dark:text-gray-400 break-all mx-2">
                            <div className="flex items-center justify-center gap-2 mb-1 opacity-70 uppercase font-bold tracking-widest">Transaction Hash</div>
                            {successTx}
                        </div>
                        
                        <div className="pt-4 flex flex-col gap-3">
                            <a 
                                href={`https://polygonscan.com/tx/${successTx}`} 
                                target="_blank" 
                                rel="noreferrer" 
                                className="w-full py-3 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 text-blue-600 dark:text-blue-400 font-bold rounded-xl transition-all flex items-center justify-center gap-2 text-sm"
                            >
                                View on PolygonScan <ExternalLink size={16}/>
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
                        <div className="text-center mb-4">
                            <div className="w-12 h-12 bg-red-100 dark:bg-red-900/20 rounded-full flex items-center justify-center mx-auto mb-3 text-red-600 dark:text-red-500">
                                <LogOut size={24}/>
                            </div>
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white">Withdraw Funds</h3>
                            <p className="text-xs text-gray-500 mt-1">Move funds from Safe Wallet to Main Wallet.</p>
                        </div>
                        
                        <div className="flex justify-center mb-6">
                            <button 
                                onClick={() => setIsRescueMode(!isRescueMode)}
                                className="text-[10px] text-gray-400 hover:text-blue-500 flex items-center gap-1 underline"
                            >
                                <Wrench size={10}/> {isRescueMode ? "Hide Advanced Tools" : "Lost access to an old Safe?"}
                            </button>
                        </div>

                        {isRescueMode && (
                            <div className="mb-6 p-4 bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-gray-700 rounded-xl animate-in slide-in-from-top-2">
                                <label className="text-[10px] font-bold text-gray-500 uppercase mb-2 block">
                                    Target Safe Address (Rescue)
                                </label>
                                <input 
                                    type="text" 
                                    placeholder="0x..." 
                                    value={customSafeAddress}
                                    onChange={(e) => setCustomSafeAddress(e.target.value)}
                                    className="w-full bg-white dark:bg-black/20 border border-gray-200 dark:border-gray-700 rounded-lg p-2 text-xs font-mono text-gray-900 dark:text-white mb-2"
                                />
                                <button 
                                    onClick={() => onWithdraw('USDC.e', false, customSafeAddress)}
                                    disabled={!customSafeAddress || isWithdrawing}
                                    className="w-full py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg"
                                >
                                    ATTEMPT RECOVERY FROM OLD SAFE
                                </button>
                                <p className="text-[10px] text-gray-500 mt-2 italic">
                                    *Only works if your current Signer key is the owner of the target Safe.
                                </p>
                            </div>
                        )}

                        {!isRescueMode && (
                            <div className="space-y-3">
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
                                
                                {hasStuckFunds && (
                                    <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800/50 rounded-xl animate-pulse">
                                        <div className="flex items-start gap-3">
                                            <ShieldAlert size={20} className="text-yellow-600 dark:text-yellow-500 mt-0.5" />
                                            <div className="flex-1">
                                                <h4 className="text-sm font-bold text-yellow-800 dark:text-yellow-200">Funds Stuck in Signer?</h4>
                                                <p className="text-xs text-yellow-700 dark:text-yellow-400 mt-1 leading-relaxed">
                                                    We detected <strong>${signerBalances.usdcBridged}</strong> in your activation wallet (Signer).
                                                </p>
                                                <button 
                                                    onClick={() => onWithdraw('USDC.e', true)}
                                                    disabled={isWithdrawing}
                                                    className="mt-2 w-full py-2 bg-yellow-200 dark:bg-yellow-800 hover:bg-yellow-300 dark:hover:bg-yellow-700 text-yellow-900 text-yellow-100 text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-2"
                                                >
                                                    RESCUE FROM SIGNER
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <div className="glass-panel p-8 rounded-xl border border-gray-200 dark:border-white/10 text-center">
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
                                            WITHDRAW
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                        
                        {isWithdrawing && (
                            <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 flex items-center gap-3">
                                <Loader2 className="animate-spin text-blue-600" size={20}/>
                                <span className="text-xs text-blue-800 dark:text-blue-200 font-bold">Processing Withdrawal via Relayer...</span>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

const OrderManagementModal = ({ 
    isOpen, 
    onClose, 
    position, 
    orders,
    onCancelOrder,
    onRedeemWinnings
}: { 
    isOpen: boolean; 
    onClose: () => void; 
    position: ActivePosition | null;
    orders: any[];
 
    onCancelOrder: (orderId: string) => void;
    onRedeemWinnings: (position: ActivePosition) => void;
}) => {
    const [marketResolution, setMarketResolution] = useState<{
        resolved: boolean;
        winningOutcome?: string;
        userWon?: boolean;
        loading: boolean;
        settling?: boolean;
    }>({ resolved: false, loading: true });
    
    const wsService = useRef<ReturnType<typeof getMarketWebSocketService>>();
    const wsCleanup = useRef<() => void>();

    useEffect(() => {
        if (!isOpen || !position) {
            setMarketResolution({ resolved: false, loading: false });
            return;
        }

        const checkResolution = async () => {
            try {
                setMarketResolution({ resolved: false, loading: true });
                
                const response = await axios.get(`/api/market/${position.marketId}`);
                const market = response.data;
                
                if (market) {
                    const isResolved = market.closed === true || 
                                    market.archived === true || 
                                    market.status === 'resolved' ||
                                    (market.tokens && market.tokens.some((t: any) => t.winner === true));
                    
                    let userWon = false;
                    let settling = false;
                    let winningOutcome: string | null = null;

                    if (isResolved && market.tokens && Array.isArray(market.tokens)) {
                        const winningToken = market.tokens.find((t: any) => t.winner === true);
                        
                        if (winningToken?.outcome) {
                            const winOut = winningToken.outcome.toUpperCase();
                            const userOut = position.outcome.toUpperCase();
                            winningOutcome = winningToken.outcome;
                            userWon = (winOut === userOut || winOut.includes(userOut));
                        } else {
                            const allLosers = market.tokens.every((t: any) => t.winner === false);
                            if (allLosers) {
                                winningOutcome = 'VOID';
                                settling = true;
                            } else {
                                settling = true;
                            }
                        }
                    }

                    setMarketResolution({ 
                        resolved: isResolved, 
                        winningOutcome: winningOutcome || undefined, 
                        userWon, 
                        loading: false,
                        settling
                    });
                } else {
                    setMarketResolution({ resolved: false, loading: false });
                }
            } catch (e: any) {
                if (String(e).includes("404")) {
                    setMarketResolution({ resolved: true, loading: false, settling: true });
                } else {
                    setMarketResolution({ resolved: false, loading: false });
                }
            }
        };

        checkResolution();
    }, [isOpen, position]);

    if (!isOpen || !position) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col relative shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="p-6 border-b border-gray-200 dark:border-gray-800 flex justify-between items-start bg-gray-50 dark:bg-black/20">
                    <div className="flex gap-4">
                        <div className="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/20 flex items-center justify-center">
                            <Activity size={20} className="text-blue-600 dark:text-blue-400"/>
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-gray-900 dark:text-white">Order Management</h2>
                            <p className="text-sm text-gray-500 mt-1">
                                {position.question || `Market: ${position.marketId}`}
                            </p>
                            <div className="flex items-center gap-2 mt-2">
                                <span className={`px-2 py-1 text-xs font-bold rounded ${position.outcome === 'YES' ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400' : 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400'}`}>
                                    {position.outcome}
                                </span>
                                <span className="text-xs text-gray-500">
                                    {position.shares.toFixed(2)} shares @ ${position.entryPrice.toFixed(2)}
                                </span>
                            </div>
                        </div>
                    </div>
                    <button 
                        onClick={onClose}
                        className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                    >
                        <X size={20}/>
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Open Orders Section */}
                    <div>
                        <h3 className="font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                            <Activity size={16} className="text-blue-500"/>
                            Open Orders ({orders.length})
                        </h3>
                        {orders.length > 0 ? (
                            <div className="space-y-3">
                                {orders.map((order) => (
                                    <div key={order.orderID} className="bg-gray-50 dark:bg-white/5 rounded-lg p-4 border border-gray-200 dark:border-white/10">
                                        <div className="flex justify-between items-start">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <span className={`px-2 py-1 text-xs font-bold rounded ${order.side === 'BUY' ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400' : 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400'}`}>
                                                        {order.side}
                                                    </span>
                                                    <span className="text-xs text-gray-500">
                                                        ID: {order.orderID.slice(0, 10)}...
                                                    </span>
                                                </div>
                                                <div className="grid grid-cols-2 gap-4 text-sm">
                                                    <div>
                                                        <span className="text-gray-500">Price:</span>
                                                        <span className="ml-2 font-mono font-bold">${order.price.toFixed(2)}</span>
                                                    </div>
                                                    <div>
                                                        <span className="text-gray-500">Size:</span>
                                                        <span className="ml-2 font-mono font-bold">{order.size}</span>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="ml-4">
                                                <button 
                                                    onClick={() => onCancelOrder(order.orderID)}
                                                    className="px-3 py-2 bg-red-50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 text-sm font-bold rounded-lg border border-red-200 dark:border-red-900/30 transition-colors"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-center py-8 text-gray-400 dark:text-gray-600">
                                <div className="w-16 h-16 bg-gray-100 dark:bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
                                    <Activity size={24} className="opacity-50"/>
                                    <p className="text-sm">No open orders</p>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Market Resolution Section */}
                    <div className="border-t border-gray-200 dark:border-white/10 pt-6">
                        <h4 className="font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                            <Trophy size={16} className="text-yellow-500"/>
                            Market Resolution
                        </h4>
                        
                        {marketResolution.loading ? (
                            <div className="flex items-center justify-center py-6 text-gray-400">
                                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-500 mr-3"></div>
                                <span className="text-sm">Checking market resolution...</span>
                            </div>
                        ) : marketResolution.resolved ? (
                            <div className={`rounded-lg p-4 border ${
                                marketResolution.userWon 
                                    ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-900/30' 
                                    : marketResolution.settling 
                                        ? 'bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-900/30'
                                        : 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-900/30'
                            }`}>
                                <div className="flex items-start gap-3">
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                                        marketResolution.userWon 
                                            ? 'bg-green-500 text-white' 
                                            : marketResolution.settling
                                                ? 'bg-blue-500 text-white'
                                                : 'bg-red-500 text-white'
                                    }`}>
                                        {marketResolution.userWon ? <Trophy size={16}/> : marketResolution.settling ? <Clock size={16}/> : <X size={16}/>}
                                    </div>
                                    <div className="flex-1">
                                        <h5 className={`font-bold text-sm mb-2 ${
                                            marketResolution.userWon 
                                            ? 'text-green-800 dark:text-green-400' 
                                            : marketResolution.settling
                                                ? 'text-blue-800 dark:text-blue-400'
                                                : 'text-red-600 dark:text-red-400'
                                        }`}>
                                            {marketResolution.userWon 
                                                ? `You Won!` 
                                                : marketResolution.settling 
                                                    ? `Market Closed - Settling...`
                                                    : `Market Resolved - Lost`}
                                        </h5>
                                        <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
                                            <p>
                                                <span className="font-medium">Winning outcome:</span> {marketResolution.winningOutcome || (marketResolution.settling ? 'TBD' : 'None')}
                                            </p>
                                            <p>
                                                <span className="font-medium">Your position:</span> {position.outcome}
                                            </p>
                                            {marketResolution.settling && (
                                                <p className="text-blue-700 dark:text-blue-300 italic">
                                                    Polymarket is confirming results. Winner not yet declared.
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                
                                {marketResolution.userWon && (
                                    <button 
                                        onClick={() => onRedeemWinnings(position)}
                                        className="w-full mt-4 px-4 py-3 bg-green-500 hover:bg-green-600 text-white font-bold rounded-xl transition-colors flex items-center justify-center gap-2"
                                    >
                                        <Trophy size={16}/>
                                        Redeem Winnings
                                    </button>
                                )}
                            </div>
                        ) : (
                            <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-4 border border-gray-200 dark:border-white/10">
                                <div className="flex items-center gap-3 text-gray-600 dark:text-gray-400">
                                    <Clock size={16} className="text-gray-400"/>
                                    <div>
                                        <p className="text-sm font-medium">Market Still Active</p>
                                        <p className="text-xs mt-1">Trading is currently open.</p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

const TraderDetailsModal = ({ trader, onClose }: { trader: TraderProfile, onClose: () => void }) => {
    const [trades, setTrades] = useState<PolyTrade[]>([]);
    const [loading, setLoading] = useState(true);
    const [earnings, setEarnings] = useState<any>(null);
    const [userAddress, setUserAddress] = useState<string>('');

    useEffect(() => {
        const fetchData = async () => {
            try {
                const [tradesRes, earningsRes] = await Promise.all([
                    axios.get(`/api/proxy/trades/${trader.address}`),
                    axios.get(`/api/registry/${trader.address}/earnings`)
                ]);
                setTrades(tradesRes.data);
                setEarnings(earningsRes.data);
            } catch (e) {
                console.error("Failed to load trader details", e);
            } finally {
                setLoading(false);
            }
        };
        
        // Get current user address to check if they listed this wallet
        const currentUser = localStorage.getItem('userAddress') || '';
        setUserAddress(currentUser);
        fetchData();
    }, [trader.address]);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-2xl w-full max-w-4xl h-[90vh] sm:h-[80vh] flex flex-col relative shadow-2xl overflow-hidden">
                {/* Header - Mobile Optimized */}
                <div className="p-4 sm:p-6 border-b border-gray-200 dark:border-gray-800 flex justify-between items-start bg-gray-50 dark:bg-black/20">
                    <div className="flex gap-3 sm:gap-4 flex-1 min-w-0">
                        <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-xl sm:rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-lg sm:text-2xl font-bold text-white shadow-lg flex-shrink-0">
                            {trader.address.slice(2,4)}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                <h2 className="text-lg sm:text-2xl font-bold text-gray-900 dark:text-white truncate">
                                    {trader.ens || `${trader.address.slice(0,6)}...${trader.address.slice(-4)}`}
                                </h2>
                                {(trader as any).isSystem && <span className="bg-blue-600 text-white text-[8px] sm:text-[10px] px-2 py-0.5 rounded uppercase font-bold flex-shrink-0">OFFICIAL</span>}
                            </div>
                            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 mt-1 sm:mt-2 text-[10px] sm:text-xs text-gray-500 font-mono">
                                <span className="bg-white dark:bg-white/5 px-2 py-1 rounded border border-gray-200 dark:border-white/10 select-all truncate">{trader.address}</span>
                                <a href={`https://polymarket.com/profile/${trader.address}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-blue-500 hover:underline flex-shrink-0">
                                    <span className="hidden sm:inline">View on Polymarket</span>
                                    <span className="sm:hidden">Polymarket</span>
                                    <ExternalLink size={10}/>
                                </a>
                            </div>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 sm:p-2 hover:bg-gray-200 dark:hover:bg-white/10 rounded-full transition-colors flex-shrink-0">
                        <X size={16} className="sm:w-5 sm:h-5 text-gray-500"/>
                    </button>
                </div>
                
                {/* Stats Grid - Mobile Responsive */}
                <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-gray-200 dark:border-gray-800 divide-x divide-y sm:divide-x-0 sm:divide-y-0 divide-gray-200 dark:divide-gray-800 bg-white dark:bg-transparent">
                    <div className="p-3 sm:p-4 text-center">
                        <div className="text-[9px] sm:text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Win Rate</div>
                        <div className="text-lg sm:text-2xl font-bold text-green-600 dark:text-green-400">{trader.winRate}%</div>
                    </div>
                    <div className="p-3 sm:p-4 text-center">
                        <div className="text-[9px] sm:text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Est. PnL</div>
                        <div className={`text-lg sm:text-2xl font-bold ${trader.totalPnl >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-red-600'}`}>
                            ${trader.totalPnl.toLocaleString()}
                        </div>
                    </div>
                    <div className="p-3 sm:p-4 text-center">
                        <div className="text-[9px] sm:text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Activity (30d)</div>
                        <div className="text-lg sm:text-2xl font-bold text-gray-900 dark:text-white">{trader.tradesLast30d}</div>
                    </div>
                    <div className="p-3 sm:p-4 text-center">
                        <div className="text-[9px] sm:text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Copiers</div>
                        <div className="text-lg sm:text-2xl font-bold text-gray-900 dark:text-white">{trader.copyCount}</div>
                    </div>
                </div>
                
                {/* Earnings Section - Only show if user listed this wallet */}
                {earnings && trader.listedBy?.toLowerCase() === userAddress.toLowerCase() && (
                    <div className="border-b border-gray-200 dark:border-gray-800 bg-green-50 dark:bg-green-900/10">
                        <div className="px-4 sm:px-6 py-3">
                            <div className="flex items-center gap-2 mb-2">
                                <DollarSign size={14} className="text-green-600 dark:text-green-400"/>
                                <h3 className="font-bold text-green-700 dark:text-green-300 text-sm">Your Finder's Rewards</h3>
                            </div>
                            <div className="grid grid-cols-3 gap-3 text-center">
                                <div>
                                    <div className="text-lg sm:text-xl font-bold text-green-600 dark:text-green-400">${earnings.totalEarned.toFixed(2)}</div>
                                    <div className="text-[9px] text-green-600 dark:text-green-400 uppercase">Total Earned</div>
                                </div>
                                <div>
                                    <div className="text-lg sm:text-xl font-bold text-gray-700 dark:text-gray-300">{earnings.totalTrades}</div>
                                    <div className="text-[9px] text-gray-500 uppercase">Fee Events</div>
                                </div>
                                <div>
                                    <div className="text-lg sm:text-xl font-bold text-gray-700 dark:text-gray-300">{earnings.uniqueCopiers}</div>
                                    <div className="text-[9px] text-gray-500 uppercase">Unique Copiers</div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
                
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
        <div className="fixed bottom-3 right-3 sm:bottom-6 sm:right-6 z-50 flex flex-col items-end gap-4">
            {!isOpen && (
                <button 
                    onClick={() => setIsOpen(true)} 
                    className="w-8 h-8 sm:w-14 sm:h-14 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-lg shadow-blue-500/20 flex items-center justify-center transition-all hover:scale-110 active:scale-95 p-0"
                >
                    <MessageSquare size={14} className="sm:w-6 sm:h-6"/>
                </button>
            )}
            {isOpen && (
                <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-2xl p-4 sm:p-6 shadow-2xl w-[calc(100vw-2rem)] sm:w-80 max-w-sm animate-in slide-in-from-bottom-10 zoom-in-95 duration-300 relative overflow-hidden">
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
    const isError = status.toLowerCase().includes('failed');
    
    let activeStep = 0;
    if (status.includes('Approving') || status.includes('Allowance')) activeStep = 0;
    else if (status.includes('Swapping')) activeStep = 1;
    else if (status.includes('Bridging') || status.includes('Cross-Chain')) activeStep = 2;
    else if (status.includes('Complete') || status.includes('Success')) activeStep = 3;
    
    const steps = ['Approve', 'Swap', 'Bridge', 'Done'];

    return (
        <div className="w-full space-y-4 p-4 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/10">
            <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-widest">Status</span>
                <span className={`text-xs font-mono font-bold ${isError ? 'text-red-500' : 'text-blue-500'}`}>
                    {status || 'Initializing...'}
                </span>
            </div>
            
            <div className="relative flex justify-between items-center px-2">
                <div className="absolute left-0 top-[5px] w-full h-0.5 bg-gray-200 dark:bg-gray-700 z-0"></div>
                
                {steps.map((label, idx) => {
                    const isCompleted = idx < activeStep;
                    const isCurrent = idx === activeStep;
                    
                    return (
                        <div key={idx} className="relative z-10 flex flex-col items-center gap-2">
                            <div className={`w-3 h-3 rounded-full border-2 transition-all ${
                                isCompleted ? 'bg-green-500 border-green-500' :
                                isCurrent ? 'bg-blue-500 border-blue-500 animate-pulse' :
                                'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600'
                            }`} />
                            <span className={`text-[8px] font-bold uppercase tracking-wider ${
                                isCompleted || isCurrent ? 'text-gray-900 dark:text-white' : 'text-gray-400'
                            }`}>
                                {label}
                            </span>
                        </div>
                    );
                })}
            </div>
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
                        Polymarket Trading Live
                    </span>
                </div>

                <h1 className="text-5xl md:text-7xl font-black tracking-tight text-gray-900 dark:text-white mb-6 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200">
                    BET <span className="text-blue-600">MIRROR</span>
                </h1>

                <p className="text-lg text-gray-500 dark:text-gray-400 font-medium max-w-lg mx-auto leading-relaxed animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
                    Professional Copy-Trading Terminal.<br/>
                    Risk-Managed Execution. Lightning-Fast. 24/7 Cloud Automation.
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
                            <h3 className="text-3xl font-black text-gray-900 dark:text-white tracking-tight">Limitless</h3>
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
                            Link your wallet. We instantly deploy a dedicated Signer Wallet & an **Gnosis Safe** (Trading Wallet). Your Bot is also deployed using the Signer to execute trades with your Polymarket Trading Wallet
                        </p>
                    </div>

                    <div className="p-10 bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-white/10 rounded-[2rem] hover:border-purple-500/30 transition-all shadow-sm group">
                        <div className="w-16 h-16 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 rounded-2xl flex items-center justify-center mb-8 group-hover:scale-110 transition-transform">
                            <Key size={32}/>
                        </div>
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">2. Total Control</h3>
                        <p className="text-gray-500 text-sm leading-relaxed">
                            You control the flow. Deposit funds to trade, withdraw profits at any time. The bot only executes strategy, it cannot lock your assets.
                        </p>
                    </div>

                    <div className="p-10 bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-white/10 rounded-[2rem] hover:border-green-500/30 transition-all shadow-sm group">
                        <div className="w-16 h-16 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 rounded-2xl flex items-center justify-center mb-8 group-hover:scale-110 transition-transform">
                            <Server size={32}/>
                        </div>
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">3. Passive Alpha</h3>
                        <p className="text-gray-500 text-sm leading-relaxed">
                            Find the best trader in the Registry and hit Copy. Our Node.js engine monitors signals 24/7 so you can <strong>earn while you sleep</strong>. Dont shy away this Christmas.
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
                        <a href="/pitchdeck.pdf" target="_blank" className="text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors flex items-center gap-2 text-xs font-medium">
                            <FileText size={16}/> Pitch Deck
                        </a>
                        <a href="https://docs.betmirror.bet" target="_blank" className="text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                            <BookOpen size={16}/>
                        </a>
                        <a href="https://github.com/vchat-meme-blip/betmirror" target="_blank" className="text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                            <Github size={16}/>
                        </a>
                        <a href="https://x.com/bet_mirror" target="_blank" className="text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
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
    const [checking, setChecking] = useState(false);
    const [showSafetyGuide, setShowSafetyGuide] = useState(false);

    // In new architecture, we just prompt the user to initialize/restore.
    // We can optionally check server if they already have an address but just no session.
    useEffect(() => {
        const checkServer = async () => {
            setChecking(true);
            try {
                const res = await axios.post('/api/wallet/status', { userId: userAddress });
                if (res.data.status === 'ACTIVE' || res.data.address) {
                    setRecoveryMode(true);
                    // PRIORITIZE SAFE ADDRESS (Funds live there)
                    setComputedAddress(res.data.safeAddress || res.data.address);
                } else {
                    setRecoveryMode(false);
                }
            } catch(e) {
                console.error(e);
            } finally {
                setChecking(false);
            }
        };
        if(userAddress) checkServer();
    }, [userAddress]);

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
                    <div className={`p-4 rounded-xl border ${recoveryMode ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-500/30' : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-500/30'}`}>
                        {recoveryMode ? <RefreshCw size={32} className="text-green-600 dark:text-green-400" /> : <Zap size={32} className="text-blue-600 dark:text-blue-400" />}
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                            {recoveryMode ? 'Restore Connection' : 'Initialize Trading Wallet'}
                        </h2>
                        <p className="text-gray-500">
                            {recoveryMode ? 'Reconnect to your existing bot.' : 'Create your dedicated Trading Wallet.'}
                        </p>
                    </div>
                </div>
                {checking && (
                    <div className="flex items-center gap-2 text-xs text-blue-500 animate-pulse bg-blue-50 dark:bg-blue-900/10 p-3 rounded">
                        <Loader2 size={12} className="animate-spin"/> Checking account status...
                    </div>
                )}

                {computedAddress && (
                    <div className={`p-4 rounded-lg border animate-in fade-in zoom-in duration-300 ${recoveryMode ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-500/20' : 'bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/10'}`}>
                        <div className="flex justify-between items-center mb-2">
                            <span className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1 ${recoveryMode ? 'text-green-800 dark:text-green-400' : 'text-gray-500'}`}>
                                {recoveryMode ? <><CheckCircle2 size={12}/> Existing Wallet Found</> : "Your Future Trading Wallet"}
                            </span>
                            {recoveryMode && <span className="bg-green-200 dark:bg-green-800 text-green-800 dark:text-green-200 text-[10px] px-2 py-0.5 rounded font-mono font-bold">READY</span>}
                        </div>
                        <div className="flex justify-between text-sm items-center">
                            <span className="text-gray-600 dark:text-gray-300 font-mono text-xs bg-white dark:bg-black/20 px-2 py-1 rounded select-all truncate">{computedAddress}</span>
                        </div>
                    </div>
                )}
                <div className="space-y-4">
                    <div className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-lg border border-gray-200 dark:border-white/5">
                        <CheckCircle2 size={16} className="text-green-500 mt-1" />
                        <div>
                            <span className="text-sm font-bold text-gray-900 dark:text-white">Dedicated Gnosis Safe</span>
                            <p className="text-xs text-gray-500">The server manages a dedicated Safe for trading, ensuring compatibility with all markets.</p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-lg border border-gray-200 dark:border-white/5">
                        <CheckCircle2 size={16} className="text-green-500 mt-1" />
                        <div>
                            <span className="text-sm font-bold text-gray-900 dark:text-white">Risk-Managed Execution</span>
                            <p className="text-xs text-gray-500">Advanced position sizing and stop-loss mechanisms protect your capital.</p>
                        </div>
                    </div>
                </div>
                
                <button 
                    onClick={handleActivate}
                    disabled={isActivating || checking}
                    className={`w-full py-3 px-2 sm:py-4 text-white font-bold rounded-xl hover:opacity-90 transition-all flex items-center justify-center gap-2 sm:gap-3 shadow-lg text-sm sm:text-base ${
                        recoveryMode 
                        ? 'bg-gradient-to-r from-green-600 to-green-500 shadow-green-500/20' 
                        : 'bg-gradient-to-r from-blue-600 to-blue-500 shadow-blue-500/20'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                    {isActivating ? (
                        <RefreshCw className="animate-spin flex-shrink-0" size={18} />
                    ) : (
                        recoveryMode ? <RefreshCw className="flex-shrink-0" size={18}/> : <Rocket className="flex-shrink-0" size={18} />
                    )}
                    <span className="whitespace-nowrap overflow-hidden text-ellipsis">
                        {isActivating ? 'PROCESSING...' : (recoveryMode ? 'RESTORE CONNECTION' : 'CREATE TRADING WALLET')}
                    </span>
                </button>
                
            </div>
        </div>
    );
};

const App = () => {
// --- STATE: Web3 & Session ---
const [isConnected, setIsConnected] = useState(false);
const [needsActivation, setNeedsActivation] = useState(false);
const [userAddress, setUserAddress] = useState<string>('');
const [chainId, setChainId] = useState<number>(137);

const [proxyAddress, setProxyAddress] = useState<string>('');
// NEW: Track Signer Address separately for rescue missions
const [signerAddress, setSignerAddress] = useState<string>('');

// --- STATE: Balances ---
const [mainWalletBal, setMainWalletBal] = useState<WalletBalances>({ native: '0.00', usdc: '0.00', usdcNative: '0.00', usdcBridged: '0.00' });
// This is now SAFE balances
const [proxyWalletBal, setProxyWalletBal] = useState<WalletBalances>({ native: '0.00', usdc: '0.00', usdcNative: '0.00', usdcBridged: '0.00' });
// NEW: This is EOA balances (for rescue)
const [signerWalletBal, setSignerWalletBal] = useState<WalletBalances>({ native: '0.00', usdc: '0.00', usdcNative: '0.00', usdcBridged: '0.00' });

// --- STATE: UI & Data ---
const [activeTab, setActiveTab] = useState<'dashboard' | 'money-market' | 'marketplace' | 'history' | 'vault' | 'bridge' | 'system' | 'help'>('dashboard');
const [isRunning, setIsRunning] = useState(false);
const [logs, setLogs] = useState<Log[]>([]);
// RENAMED from history to tradeHistory to prevent collision with History component from lucide-react
const [tradeHistory, setTradeHistory] = useState<TradeHistoryEntry[]>([]);
const [activePositions, setActivePositions] = useState<ActivePosition[]>([]); 
const [moneyMarketOpps, setMoneyMarketOpps] = useState<ArbitrageOpportunity[]>([]);
const [stats, setStats] = useState<UserStats | null>(null);
const [registry, setRegistry] = useState<TraderProfile[]>([]);
const [systemStats, setSystemStats] = useState<GlobalStatsResponse | null>(null);
const [bridgeHistory, setBridgeHistory] = useState<BridgeTransactionRecord[]>([]);
const [theme, setTheme] = useState<'light' | 'dark'>('light');
const [performanceRange, setPerformanceRange] = useState<'1W' | '30D' | 'ALL'>('ALL');
const [isPolling, setIsPolling] = useState(false); // Money market service refresh
const [systemView, setSystemView] = useState<'attribution' | 'global'>('attribution');
// -- MOBILE MENU STATE --
const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
const [tradePanelTab, setTradePanelTab] = useState<'active' | 'history'>('active'); 
const [pollError, setPollError] = useState<boolean>(false); 
// --- STATE: Forms & Actions ---
const [isDepositing, setIsDepositing] = useState(false);
const [isDepositModalOpen, setIsDepositModalOpen] = useState(false); 
const [isWithdrawing, setIsWithdrawing] = useState(false);
const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState(false);
const [withdrawalTxHash, setWithdrawalTxHash] = useState<string | null>(null); 

const [isActivating, setIsActivating] = useState(false);
const [targetInput, setTargetInput] = useState('');
const [newWalletInput, setNewWalletInput] = useState('');
const [showSecrets, setShowSecrets] = useState(false);
const [isAddingWallet, setIsAddingWallet] = useState(false);
const [selectedTrader, setSelectedTrader] = useState<TraderProfile | null>(null);

// --- ORDER MANAGEMENT STATE ---
const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
const [selectedPosition, setSelectedPosition] = useState<ActivePosition | null>(null);
const [openOrders, setOpenOrders] = useState<any[]>([]);
const [exitingPositionId, setExitingPositionId] = useState<string | null>(null); // Track manual exit loading state
const [isSyncingPositions, setIsSyncingPositions] = useState(false); //  Sync positions state


// --- STATE: Bridging (Updated for Bidirectional Flow) ---
const [bridgeMode, setBridgeMode] = useState<'IN' | 'OUT'>('IN');
const [selectedSourceChain, setSelectedSourceChain] = useState<number>(8453); // Default Base for IN
const [selectedDestChain, setSelectedDestChain] = useState<number>(137); // Default Polygon for IN
const [bridgeToken, setBridgeToken] = useState<'NATIVE' | 'USDC' | 'USDC.e'>('NATIVE'); // Native, USDC, or Bridged USDC
const [destToken, setDestToken] = useState<'USDC' | 'NATIVE'>('USDC');
const [bridgeAmount, setBridgeAmount] = useState('0.1');
const [bridgeQuote, setBridgeQuote] = useState<any>(null);
const [isBridging, setIsBridging] = useState(false);
const [bridgeStatus, setBridgeStatus] = useState<string>('');
const [senderAddressDisplay, setSenderAddressDisplay] = useState<string>('');
const [recipientAddress, setRecipientAddress] = useState<string>(''); // Editable recipient
const [isSourceChainSelectOpen, setIsSourceChainSelectOpen] = useState(false);
const [isDestChainSelectOpen, setIsDestChainSelectOpen] = useState(false);
const [showBridgeGuide, setShowBridgeGuide] = useState(false);
const [showHelpGuide, setShowHelpGuide] = useState(false);

// --- STATE: Recovery & Sovereignty ---
const [recoveryOwnerAdded, setRecoveryOwnerAdded] = useState(false);
const [isAddingRecovery, setIsAddingRecovery] = useState(false);

// --- REFS for Audio Logic ---
const lastTradeIdRef = useRef<string | null>(null); 
const lastLogTimestampRef = useRef<number>(0); // Track last log timestamp for failed trades

const [config, setConfig] = useState<AppConfig>({
    targets: [],
    rpcUrl: 'https://polygon-rpc.com',
    geminiApiKey: '',
    multiplier: 1.0,
    riskProfile: 'balanced',
    minLiquidityFilter: 'LOW',
    autoTp: 20,
    enableAutoArb: false,
    enableNotifications: false,
    userPhoneNumber: '',
    enableAutoCashout: false,
    maxRetentionAmount: 0,
    maxTradeAmount: 100, 
    coldWalletAddress: '',
    enableSounds: true 
});

// --- REFS for Debouncing ---
const quoteDebounceTimer = useRef<any>(null);

// Helper to update state AND local storage simultaneously
const updateConfig = (updates: Partial<AppConfig>) => {
    setConfig(prevConfig => {
        const newConfig = { ...prevConfig, ...updates };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig));
        
        if (isRunning && userAddress) {
            const { 
                targets, multiplier, riskProfile, minLiquidityFilter, 
                autoTp, maxTradeAmount, enableAutoCashout, maxRetentionAmount,
                coldWalletAddress, enableNotifications, userPhoneNumber, enableAutoArb
            } = newConfig;
            
            // Fire and forget the server update
            axios.post('/api/bot/update', {
                userId: userAddress,
                targets,
                multiplier,
                riskProfile,
                minLiquidityFilter,
                autoTp,
                maxTradeAmount,
                enableAutoArb,
                autoCashout: {
                    enabled: enableAutoCashout,
                    maxAmount: maxRetentionAmount,
                    destinationAddress: coldWalletAddress || userAddress
                },
                notifications: {
                    enabled: enableNotifications,
                    phoneNumber: userPhoneNumber
                }
            }).catch(console.warn);
        }
        
        return newConfig;
    });
};

// --- LOAD LOCAL CONFIG & THEME ---
useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            // Ensure new RPC default if old one was the broken one or missing
            if (!parsed.rpcUrl || parsed.rpcUrl.includes('little-thrilling-layer')) {
                 parsed.rpcUrl = 'https://polygon-rpc.com';
            }
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
const fetchBotStatus = useCallback(async () => {
    if (!isConnected || !userAddress || needsActivation) return;
    try {
        const res = await axios.get(`/api/bot/status/${userAddress}`);
        setIsRunning(res.data.isRunning);
        setPollError(false); 
        
        if (res.data.logs) setLogs(res.data.logs); // Now fetches from DB
        if (res.data.history) setTradeHistory(res.data.history);
        if (res.data.stats) setStats(res.data.stats);
        if (res.data.mmOpportunities) setMoneyMarketOpps(res.data.mmOpportunities);
        // Sync Active Positions
        if (res.data.positions) setActivePositions(res.data.positions);

        // FIX: Track latest ID instead of length
        const latestHistory = res.data.history || [];
        if (latestHistory.length > 0) {
            const latestId = latestHistory[0].id;
            // Only play if initialized (not null) and different
            if (lastTradeIdRef.current !== null && lastTradeIdRef.current !== latestId && config.enableSounds) {
                playSound('trade');
            }
            lastTradeIdRef.current = latestId;
        }

        // ALSO check for failed trades in logs
        if (res.data.logs && config.enableSounds) {
            const latestLog = res.data.logs[0];
            if (latestLog) {
                const logTimestamp = new Date(latestLog.timestamp).getTime();
                // Play error sound for failed trades (check if message contains trade failure indicators)
                if (lastLogTimestampRef.current !== 0 && logTimestamp > lastLogTimestampRef.current) {
                    const message = latestLog.message.toLowerCase();
                    if (message.includes('insufficient_funds') || 
                        message.includes('insufficient_balance') || 
                        message.includes('insufficient_allowance') ||
                        message.includes('dust_boost_exceeds_balance') ||
                        message.includes('failed') && message.includes('trade')) {
                        playSound('error');
                    }
                }
                lastLogTimestampRef.current = logTimestamp;
            }
        }

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
                maxTradeAmount: serverConfig.maxTradeAmount || prev.maxTradeAmount, // ADDED
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
        setPollError(true); 
    }
}, [isConnected, userAddress, needsActivation, activeTab, tradeHistory.length, config.enableSounds]);

useEffect(() => {
    if (!isConnected || !userAddress || needsActivation) return;
    
    // Poll Server State
    const interval = setInterval(fetchBotStatus, 15000);
    
    // Poll Balances (Every 10s)
    const balanceInterval = setInterval(fetchBalances, 10000);
    fetchBalances(); // Initial
    fetchBotStatus(); // Initial

    return () => {
        clearInterval(interval);
        clearInterval(balanceInterval);
    };
}, [isConnected, userAddress, needsActivation, activeTab, fetchBotStatus]);

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
        // CRITICAL FIX: Always use a dedicated Polygon RPC provider for the proxy wallet check.
        // This isolates the proxy check from the user's browser wallet network state, preventing 
        // "wrong balance" issues when the user is on Ethereum Mainnet or Base.
        
        const polygonProvider = new JsonRpcProvider(process.env.RPC_URL || 'https://polygon-rpc.com');
        const safeBalance = async (call: () => Promise<any>): Promise<any> => {
            try { return await call(); } catch(e) { return 0n; }
        };

        // A. Safe Balance (Primary)
        if (proxyAddress && proxyAddress !== userAddress) {
            const polyBal = await safeBalance(() => polygonProvider.getBalance(proxyAddress));
            const usdcBridgedBal = await safeBalance(() => new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, polygonProvider).balanceOf(proxyAddress));
            const usdcNativeBal = await safeBalance(() => new Contract(USDC_POLYGON, USDC_ABI, polygonProvider).balanceOf(proxyAddress));
            
            setProxyWalletBal({
                native: parseFloat(formatUnits(polyBal, 18)).toFixed(4),
                usdc: parseFloat(formatUnits(usdcBridgedBal, 6)).toFixed(2),
                usdcNative: parseFloat(formatUnits(usdcNativeBal, 6)).toFixed(2),
                usdcBridged: parseFloat(formatUnits(usdcBridgedBal, 6)).toFixed(2)
            });
        }

        // B. Signer Balance (Rescue Check)
        if (signerAddress && signerAddress !== userAddress) {
            const polyBal = await safeBalance(() => polygonProvider.getBalance(signerAddress));
            const usdcBridgedBal = await safeBalance(() => new Contract(USDC_BRIDGED_POLYGON, USDC_ABI, polygonProvider).balanceOf(signerAddress));
            const usdcNativeBal = await safeBalance(() => new Contract(USDC_POLYGON, USDC_ABI, polygonProvider).balanceOf(signerAddress));
            
            setSignerWalletBal({
                native: parseFloat(formatUnits(polyBal, 18)).toFixed(4),
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
            // CRITICAL FIX: Prefer Safe Address (Funder) over EOA Signer address for display and balance checks
            setProxyAddress(res.data.safeAddress || res.data.address);
            setSignerAddress(res.data.address); // Track the EOA separately
            // Capture recovery status from backend
            setRecoveryOwnerAdded(res.data.recoveryOwnerAdded || false);
            setNeedsActivation(false);
            setIsConnected(true);
        }
    } catch (e: any) {
        alert(e.message || "Failed to connect. Please ensure you have a wallet installed.");
    }
};

// --- HANDLERS: Initialize Trading Wallet ---
const handleInitializeWallet = async () => {
    setIsActivating(true);
    try {
        // Call server to create EOA wallet
        const res = await axios.post('/api/wallet/activate', { 
            userId: userAddress
        });

        // Use safeAddress if returned, otherwise fallback to EOA address
        setProxyAddress(res.data.safeAddress || res.data.address);
        setSignerAddress(res.data.address);
        setRecoveryOwnerAdded(false); // New wallets don't have recovery by default
        setNeedsActivation(false);
        
        alert("✅ Trading Wallet Created!\n\nDeposit USDC.e (Trading) to start. Gas is paid by Relayer!");

    } catch (e: any) {
        console.error(e);
        alert("Activation failed: " + (e.response?.data?.error || e.message));
    } finally {
        setIsActivating(false);
    }
};

// --- HANDLERS: Add Recovery Owner ---
const handleAddRecoveryOwner = async () => {
    if (!confirm("Add Recovery Owner?\n\nThis will add your Main Wallet as new owner of the Gnosis Safe. You will be able to execute transactions directly on-chain if this website ever goes down.\n\nCost: ~0.05 POL (Paid by Signer/Bot)")) return;

    // Pre-check Signer Gas
    if (parseFloat(signerWalletBal.native) < 0.05) {
        alert("⚠️ Insufficient Gas in Signer Wallet.\n\nTo add an owner, the Signer (Bot) needs about 0.05 POL.\n\nPlease deposit a small amount of POL via the Bridge or Deposit modal.");
        return;
    }

    setIsAddingRecovery(true);
    try {
        const res = await axios.post('/api/wallet/add-recovery', { userId: userAddress });
        if (res.data.success) {
            setRecoveryOwnerAdded(true);
            if (config.enableSounds) playSound('success');
            alert("✅ SUCCESS: Your Main Wallet is now an owner of the Safe.\n\nYou have full custody and can recover funds manually via Gnosis Safe interface at any time.");
        } else {
             throw new Error("API returned failure");
        }
    } catch (e: any) {
        alert("Failed to add recovery owner: " + (e.response?.data?.error || e.message));
    } finally {
        setIsAddingRecovery(false);
    }
};

// --- HANDLERS: Money & Bridge ---
const openDepositModal = () => {
    // Ensure we are on Polygon to see accurate balances for deposit
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

        alert("✅ Deposit Sent! Funds will arrive in your Trading Wallet shortly.");
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
const getSourceBalance = () => {
    // Solana Special Case
    if (selectedSourceChain === 1151111081099710) {
        return "Check Phantom"; 
    }
    // If Chain Mismatch
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
        const oldSource = selectedSourceChain;
        setSelectedSourceChain(137); // Source is now Polygon
        setSelectedDestChain(oldSource === 137 ? 8453 : oldSource); 
        setBridgeToken(destToken === 'NATIVE' ? 'NATIVE' : 'USDC.e');
        setRecipientAddress(userAddress); 
    } else {
        setBridgeMode('IN');
        const oldDest = selectedDestChain;
        setSelectedSourceChain(oldDest === 137 ? 8453 : oldDest); // Source is old dest
        setSelectedDestChain(137); // Dest is now Polygon
        setDestToken(bridgeToken === 'NATIVE' ? 'NATIVE' : 'USDC');
        setRecipientAddress(proxyAddress || userAddress);
    }
};

const handleGetBridgeQuote = async () => {
    if (!bridgeAmount || !recipientAddress) return;
    setBridgeQuote(null);
    try {
        let senderAddress = userAddress;
        // Special Handling for Solana
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
            setSenderAddressDisplay(userAddress);
        }

        const fromToken = lifiService.getTokenAddress(selectedSourceChain, bridgeToken as any);
        let decimals = 18;
        if (bridgeToken.includes('USDC')) decimals = 6;
        if (bridgeToken === 'NATIVE' && selectedSourceChain === 1151111081099710) decimals = 9; 

        const rawAmount = (Number(bridgeAmount) * Math.pow(10, decimals)).toString();

        let toTokenAddress;
        if (selectedDestChain === 137) {
            if (destToken === 'NATIVE') {
                toTokenAddress = '0x0000000000000000000000000000000000000000'; // POL
            } else {
                toTokenAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e on Polygon
            }
        } else {
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
        
        if (config.enableSounds) playSound('cashout'); 
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
    setWithdrawalTxHash(null); 
    setIsWithdrawModalOpen(true);
    fetchBalances();
};

const handleWithdraw = async (tokenType: 'USDC' | 'USDC.e' | 'POL', isRescue: boolean = false, targetSafe?: string) => {
    if(!confirm(`Are you sure you want to withdraw ${targetSafe ? 'RESCUE' : (isRescue ? 'RESCUE' : 'ALL')} ${tokenType}?`)) return;
    setIsWithdrawing(true);

    try {
        const res = await axios.post('/api/wallet/withdraw', {
            userId: userAddress,
            tokenType: tokenType,
            toAddress: userAddress, // Send back to owner
            forceEoa: isRescue, // Force EOA withdrawal if rescue mode
            targetSafeAddress: targetSafe // Optional: Target specific Safe
        });
        
        if (res.data.success) {
            if (config.enableSounds) playSound('cashout');
            setWithdrawalTxHash(res.data.txHash);
        } else {
                throw new Error(res.data.error || 'Unknown error');
        }

    } catch (e: any) {
        console.error(e);
        alert("Withdrawal Failed: " + (e.response?.data?.error || e.message));
    }
    setIsWithdrawing(false);
};

const handleExecuteMM = async (opp: ArbitrageOpportunity) => {
    // This is a MANUAL override command sent to the server engine (Market Making)
    if (!confirm(`Manually Provide Liquidity?\n\nMarket: ${opp.question}\nSpread: ${(opp.spread * 100).toFixed(1)}¢`)) return;
    try {
        await axios.post('/api/bot/execute-arb', { userId: userAddress, marketId: opp.marketId });
        playSound('trade');
        alert("MM Strategy Dispatched to Server Engine");
    } catch (e) { alert("MM Trigger Failed"); }
};

// --- MANUAL EXIT HANDLER ---
const handleManualExit = async (position: ActivePosition) => {
    if(!confirm(`Are you sure you want to SELL/EXIT this position?\n\nMarket: ${position.marketId}\nOutcome: ${position.outcome}\n\nThis will trigger an immediate Market Sell order for your full position size.`)) return;
    
    setExitingPositionId(position.marketId + position.outcome);
    try {
        const res = await axios.post('/api/trade/exit', {
            userId: userAddress,
            marketId: position.marketId,
            outcome: position.outcome
        });

        if (res.data.success) {
            alert("✅ Sell Order Submitted!");
            // Optimistic UI update: Remove position immediately
            setActivePositions(prev => prev.filter(p => !(p.marketId === position.marketId && p.outcome === position.outcome)));
        } else {
            alert("Exit Failed: " + res.data.error);
        }
    } catch (e: any) {
        alert("Exit Error: " + (e.response?.data?.error || e.message));
    } finally {
        setExitingPositionId(null);
    }
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
        maxTradeAmount: config.maxTradeAmount, // ADDED
        notifications: {
            enabled: config.enableNotifications,
            phoneNumber: config.userPhoneNumber
        },
        autoCashout: {
            enabled: config.enableAutoCashout,
            maxAmount: config.maxRetentionAmount,
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

const handleSyncPositions = async () => {
    if (!userAddress) return;
    setIsSyncingPositions(true);
    try {
        // FIX: Send force: true to tell the bot to fetch from Chain/API, not just update local DB prices
        await axios.post('/api/trade/sync', { userId: userAddress, force: true });
        
        // Poll for update or re-fetch status
        // Give it a split second for the backend to process
        await new Promise(r => setTimeout(r, 1000));
        
        const res = await axios.get(`/api/bot/status/${userAddress}`);
        if (res.data.positions) setActivePositions(res.data.positions);
        
        if (config.enableSounds) playSound('success');
    } catch (e: any) {
        alert("Sync Failed: " + (e.response?.data?.error || e.message));
    } finally {
        setIsSyncingPositions(false);
    }
};

// --- ORDER MANAGEMENT HANDLERS ---
const handleOpenOrderModal = async (position: ActivePosition) => {
    setSelectedPosition(position);
    setIsOrderModalOpen(true);
    
    // Fetch open orders for this position
    try {
        const res = await axios.get(`/api/orders/open?userId=${userAddress}`);
        const positionOrders = res.data.orders?.filter((order: any) => 
            order.tokenId === position.tokenId
        ) || [];
        setOpenOrders(positionOrders);
    } catch (e: any) {
        console.error('Failed to fetch open orders:', e);
        setOpenOrders([]);
    }
};

const handleCloseOrderModal = () => {
    setIsOrderModalOpen(false);
    setSelectedPosition(null);
    setOpenOrders([]);
};

const handleCancelOrder = async (orderId: string) => {
    if (!confirm('Are you sure you want to cancel this order?')) return;
    
    try {
        const res = await axios.post('/api/orders/cancel', { 
            userId: userAddress,
            orderId 
        });
        if (res.data.success) {
            // Refresh open orders
            if (selectedPosition) {
                handleOpenOrderModal(selectedPosition);
            }
            alert('✅ Order cancelled successfully!');
        } else {
            alert('Failed to cancel order: ' + res.data.error);
        }
    } catch (e: any) {
        alert('Error cancelling order: ' + (e.response?.data?.error || e.message));
    }
};

const handleRedeemWinnings = async (position: ActivePosition) => {
    if (!confirm('Redeem your winnings from this resolved market?')) return;
    
    try {
        const res = await axios.post('/api/redeem', {
            userId: userAddress,
            marketId: position.marketId,
            outcome: position.outcome
        });
        
        if (res.data.success) {
            alert('🏆 Winnings redeemed successfully!');
            // Refresh positions
            handleSyncPositions();
        } else {
            alert('Failed to redeem: ' + res.data.error);
        }
    } catch (e: any) {
        alert('Error redeeming: ' + (e.response?.data?.error || e.message));
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
            handleActivate={handleInitializeWallet}
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
                { id: 'dashboard', icon: Activity, label: 'Dashboard' },
                { id: 'money-market', icon: Scale, label: 'M.Market' },
                { id: 'system', icon: Gauge, label: 'System' },
                { id: 'bridge', icon: Globe, label: 'Bridge' },
                { id: 'marketplace', icon: Users, label: 'Alpha' },
                { id: 'history', icon: History, label: 'History' },
                { id: 'vault', icon: Lock, label: 'Vault' },
                { id: 'help', icon: LifeBuoy, label: 'Help' }
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
                        <span className="capitalize">{tab.label || tab.id.replace('-', ' ')}</span>
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
                        <span className="text-[10px] font-mono font-bold text-gray-500 dark:text-gray-400">{isRunning ? (parseFloat(proxyWalletBal.usdc) < 0.1 ? 'WAITING DEPOSIT' : 'ENGINE ONLINE') : 'STANDBY'}</span>
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
                    { id: 'dashboard', icon: Activity, label: 'Dashboard' },
                    { id: 'system', icon: Gauge, label: 'System' },
                    { id: 'money-market', icon: Scale, label: 'Money Market' },
                    { id: 'bridge', icon: Globe, label: 'Bridge' },
                    { id: 'marketplace', icon: Users, label: 'Marketplace' },
                    { id: 'history', icon: History, label: 'History' },
                    { id: 'vault', icon: Lock, label: 'Vault' },
                    { id: 'help', icon: LifeBuoy, label: 'Help' }
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
                            <span className="capitalize">{tab.label || tab.id.replace('-', ' ')}</span>
                        </button>
                    ))}
                </div>
                <div className="p-4 border-t border-gray-200 dark:border-gray-800 flex justify-between items-center">
                    <span className="text-xs font-mono text-gray-500">v3.0.0-mobile</span>
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
                {pollError && (
                    <div className="col-span-12 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200 rounded-lg flex items-center gap-2 text-xs font-bold mb-4 animate-pulse">
                        <AlertTriangle size={14}/> Network issues, data may not be accurate.
                    </div>
                )}
                {/* Left Panel */}
                <div className="col-span-12 md:col-span-8 flex flex-col gap-6">
                    {/* REDESIGNED: Asset Overview Panel */}
                    <div className="glass-panel p-5 rounded-xl relative overflow-hidden flex flex-col gap-6">
                        <div className="absolute top-0 right-0 p-4 opacity-5 text-blue-600 dark:text-white">
                            <Wallet size={100} />
                        </div>
                        
                        <div className="flex justify-between items-center relative z-10">
                            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                                <Coins size={14}/> Asset Overview
                            </h3>
                            <button 
                                onClick={fetchBalances} 
                                className="text-[10px] text-blue-600 hover:text-blue-700 dark:text-blue-400 flex items-center gap-1 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded transition-colors"
                            >
                                <RefreshCw size={10}/> REFRESH
                            </button>
                        </div>

                        {/* NEW: Signer Controller Banner (Horizontal Layout) */}
                        <div className="relative z-10 bg-purple-500/5 dark:bg-purple-500/10 border border-purple-500/20 dark:border-purple-500/30 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-between gap-4 group hover:border-purple-500/40 transition-all">
                             <div className="flex items-center gap-3 w-full sm:w-auto">
                                 <div className="w-10 h-10 rounded-full bg-purple-600/20 dark:bg-purple-600/40 flex items-center justify-center text-purple-600 dark:text-purple-400">
                                     <Fingerprint size={20}/>
                                 </div>
                                 <div className="flex flex-col">
                                     <span className="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wider">Bot Signer (Controller)</span>
                                     <div className="flex items-center gap-2">
                                         <span className="text-xs font-mono text-gray-600 dark:text-gray-300 truncate max-w-[150px] sm:max-w-none">{signerAddress}</span>
                                         <button onClick={() => copyToClipboard(signerAddress)} className="p-1 hover:bg-purple-500/20 rounded transition-colors text-purple-600"><Copy size={12}/></button>
                                         <Tooltip text="Encrypted EOA key held by the server to sign trades for your Safe vault. Needs ~1 POL gas for rescue/recovery tasks." />
                                     </div>
                                 </div>
                             </div>
                             
                             <div className="flex items-center gap-6 w-full sm:w-auto px-4 py-2 bg-white/40 dark:bg-black/40 rounded-lg border border-purple-500/10">
                                 <div className="flex flex-col">
                                     <span className="text-[8px] text-gray-500 uppercase font-bold">Gas (POL)</span>
                                     <span className="text-xs font-mono font-bold text-gray-900 dark:text-white">{signerWalletBal.native}</span>
                                 </div>
                                 <div className="flex flex-col">
                                     <span className="text-[8px] text-gray-500 uppercase font-bold">No use for stables</span>
                                 </div>
                             </div>
                        </div>
                        
                        {/* 2-Column Grid for Main Wallets */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 relative z-10">
                            {/* Connected Wallet */}
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-[10px] text-white">W</div>
                                    <span className="text-sm font-bold text-gray-900 dark:text-white">Owner Wallet</span>
                                    <button 
                                        onClick={() => copyToClipboard(userAddress)} 
                                        className="p-1 hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors text-gray-500"
                                    >
                                        <Copy size={12}/>
                                    </button>
                                    <Tooltip text="Your connected Browser Wallet (MetaMask, Phantom, etc). This wallet is the owner of the Trading Wallet (Capital Vault)." />
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
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                        <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] text-white bg-green-600">P</div>
                                        <span className="text-sm font-bold text-gray-900 dark:text-white">Trading Wallet (Safe)</span>
                                        <button 
                                            onClick={() => copyToClipboard(proxyAddress)} 
                                            className="p-1 hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors text-gray-500"
                                        >
                                            <Copy size={12}/>
                                        </button>
                                        <Tooltip text="Polymarket Gnosis Safe trading wallet. Holds your capital (fund via deposit or bridge to trading wallet), executes your trades on the CLOB." />
                                    </div>
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
                                    <span className="text-sm font-mono text-gray-900 dark:text-white font-bold">{proxyWalletBal.usdcBridged}</span>
                                </div>
                            </div>
                        </div>

                        {/* Action Bar */}
                        <div className="mt-2 pt-4 border-t border-gray-200 dark:border-gray-800 flex flex-col sm:flex-row gap-3 relative z-10">
                            <button onClick={openDepositModal} className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2">
                                <ArrowDownCircle size={18}/> DEPOSIT FUNDS
                            </button>
                            <button onClick={openWithdrawModal} className="flex-1 py-3 bg-white dark:bg-white/5 hover:bg-gray-50 dark:hover:bg-white/10 border border-red-200 dark:border-terminal-danger/30 text-red-600 dark:text-terminal-danger font-bold rounded-lg transition-all flex items-center justify-center gap-2">
                                <ArrowUpCircle size={18}/> WITHDRAW
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
                        <div className="flex justify-between items-start mb-4">
                            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                                <TrendingUp size={20} className="text-green-500 dark:text-terminal-success"/> 
                                Performance
                            </h3>
                            <div className="flex items-center gap-1.5 px-2 py-1 bg-green-500/10 rounded-full border border-green-500/20">
                                <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse status-dot"></div>
                                <span className="text-[9px] font-bold text-green-600 dark:text-green-400 uppercase tracking-wider">Live Sync</span>
                            </div>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-4 mb-4">
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
                        
                        {/* Performance Chart */}
                        <div className="border-t border-gray-200 dark:border-white/5 pt-4">
                            <div className="flex justify-between items-center mb-2">
                                <div className="text-[10px] text-gray-500">Performance Overview</div>
                                <div className="flex gap-1">
                                    {(['1W', '30D', 'ALL'] as const).map(range => (
                                        <button
                                            key={range}
                                            onClick={() => setPerformanceRange(range)}
                                            className={`px-2 py-1 text-[9px] font-bold rounded transition-colors ${
                                                performanceRange === range 
                                                    ? 'bg-blue-500 text-white' 
                                                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                                            }`}
                                        >
                                            {range}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <PerformanceChart 
                                userId={userAddress}
                                selectedRange={performanceRange}
                            />
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
                    {/* Live Positions & History (Tabbed) */}
                        <div className="glass-panel p-5 rounded-xl space-y-4 flex-1 flex flex-col bg-white dark:bg-zinc-900/50 border border-gray-200 dark:border-zinc-800 shadow-sm min-h-[600px]">
                            {/* Tab Headers */}
                            <div className="flex items-center justify-between border-b border-gray-200 dark:border-white/5 pb-2">
                                <div className="flex items-center gap-4">
                                    <button 
                                        onClick={() => setTradePanelTab('active')}
                                        className={`text-xs font-bold px-3 py-1.5 rounded-lg transition-all ${tradePanelTab === 'active' ? 'bg-gray-900 dark:bg-white text-white dark:text-black shadow-md' : 'text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5'}`}
                                    >
                                        Active Positions 
                                        <span className="px-1.5 py-0.5 bg-gray-300 text-black/8 dark:bg-grey/10 rounded-full text-[10px] ml-1">{activePositions.length}</span>
                                    </button>
                                    <button 
                                        onClick={() => setTradePanelTab('history')}
                                        className={`text-sm font-bold pb-2 border-b-2 transition-colors ${tradePanelTab === 'history' ? 'border-blue-500 text-blue-500' : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-white'}`}
                                    >
                                        History
                                    </button>
                                </div>
                                
                                {tradePanelTab === 'active' && (
                                    <button 
                                        onClick={handleSyncPositions}
                                        disabled={isSyncingPositions}
                                        className={`p-2 rounded-full hover:bg-gray-100 dark:hover:bg-white/5 text-gray-400 hover:text-blue-500 transition-all ${isSyncingPositions ? 'animate-spin text-blue-500' : ''}`}
                                        title="Sync Positions"
                                    >
                                        <RefreshCw size={14}/>
                                    </button>
                                )}
                            </div>
                            
                            <div className="flex-1 overflow-y-auto custom-scrollbar">
                                {tradePanelTab === 'active' ? (
                                    /* ACTIVE POSITIONS TAB */
                                    <div className="space-y-3">
                                        {activePositions.length > 0 ? (
                                            activePositions.map((pos) => {
                                                const currentPrice = pos.currentPrice || pos.entryPrice;
                                                const value = pos.shares * currentPrice;
                                                // Correct PnL Calculation: Value - Cost Basis
                                                // Cost Basis = shares * entryPrice
                                                const costBasis = pos.shares * pos.entryPrice;
                                                const pnl = value - costBasis;
                                                const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
                                                const isProfitable = pnl >= 0;
                                                
                                                // Defensive ID Check
                                                const safeMarketId = pos.marketId || "UNKNOWN";
                                                const shortId = safeMarketId.length > 8 ? safeMarketId.slice(0, 8) : safeMarketId;
                                                
                                                // Determine market state styling and if redeemable
                                                const isResolved = pos.marketState === 'RESOLVED' || pos.marketState === 'CLOSED';
                                                const isRedeemable = isResolved;
                                                const marketStateColor = {
                                                    'ACTIVE': 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400',
                                                    'CLOSED': 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400',
                                                    'RESOLVED': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400',
                                                    'ARCHIVED': 'bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400'
                                                }[pos.marketState || 'ACTIVE'];

                                                return (
                                                    <div key={safeMarketId + pos.outcome} className={`text-xs p-3 bg-white dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/10 hover:border-blue-500/30 transition-all shadow-sm group ${isRedeemable ? 'ring-2 ring-yellow-400/50 ring-offset-2 ring-offset-white dark:ring-offset-black animate-pulse' : ''}`}>
                                                        {/* Card Header: Image & Title */}
                                                        <div className="flex gap-3 mb-3">
                                                            <div className="shrink-0 mt-1">
                                                                {pos.image ? (
                                                                    <img 
                                                                        src={pos.image} 
                                                                        alt="Market" 
                                                                        className="w-8 h-8 rounded-full object-cover bg-gray-200 dark:bg-gray-800"
                                                                        onError={(e) => (e.target as any).style.display = 'none'}
                                                                    />
                                                                ) : (
                                                                    <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-800 flex items-center justify-center text-gray-400">
                                                                        <Activity size={14}/>
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <a 
                                                                    href={pos.eventSlug && pos.marketSlug ? `https://polymarket.com/event/${pos.eventSlug}/${pos.marketSlug}` : `https://polymarket.com/market/${pos.marketId}`}
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    className="font-bold text-gray-900 dark:text-white line-clamp-2 leading-tight hover:text-blue-500 hover:underline transition-colors"
                                                                    title={pos.question || safeMarketId}
                                                                >
                                                                    {pos.question || safeMarketId}
                                                                </a>
                                                                <div className="text-[10px] text-gray-500 mt-1 flex items-center gap-2">
                                                                    <span className="font-mono">{shortId}...</span>
                                                                    {pos.endDate && <span>• Ends {new Date(pos.endDate).toLocaleDateString()}</span>}
                                                                    {pos.marketState && (
                                                                        <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded ${marketStateColor}`}>
                                                                            {pos.marketState}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Stats Grid */}
                                                        <div className="grid grid-cols-2 gap-2 bg-gray-50 dark:bg-black/20 p-2 rounded-lg mb-3">
                                                            <div>
                                                                <div className="text-[10px] text-gray-500 uppercase font-bold">Outcome</div>
                                                                <div className={`font-bold ${pos.outcome === 'YES' ? 'text-green-600' : 'text-red-600'}`}>{pos.outcome}</div>
                                                            </div>
                                                            <div className="text-right">
                                                                <div className="text-[10px] text-gray-500 uppercase font-bold">Value</div>
                                                                <div className="font-mono font-bold text-gray-900 dark:text-white">${value.toFixed(2)}</div>
                                                                <div className="text-[10px] text-gray-500">{pos.shares.toFixed(2)} Shares</div>
                                                            </div>
                                                            <div>
                                                                <div className="text-[10px] text-gray-500 uppercase font-bold">Entry</div>
                                                                <div className="font-mono text-gray-700 dark:text-gray-300">${pos.entryPrice.toFixed(2)}</div>
                                                            </div>
                                                            <div className="text-right">
                                                                <div className="text-[10px] text-gray-500 uppercase font-bold">Current</div>
                                                                <div className={`font-mono font-bold ${(pos.currentPrice || 0) > pos.entryPrice ? 'text-green-500' : 'text-red-500'}`}>
                                                                    ${(pos.currentPrice || pos.entryPrice).toFixed(2)}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Footer: PnL & Action */}
                                                        <div className="flex items-center justify-between pt-1">
                                                            <div className={`text-xs font-mono font-bold ${isProfitable ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                                                {isProfitable ? '+' : ''}{pnl.toFixed(2)} ({pnlPercent.toFixed(1)}%)
                                                            </div>
                                                            <div className="flex items-center gap-1">
                                                                {/* Show Redeem button for resolved markets */}
                                                                {isRedeemable ? (
                                                                    <button 
                                                                        onClick={() => handleOpenOrderModal(pos)}
                                                                        className="px-3 py-1.5 bg-yellow-500 hover:bg-yellow-600 text-white text-[10px] font-bold rounded border border-yellow-600 transition-colors flex items-center gap-1 animate-pulse"
                                                                        title="Redeem Winnings"
                                                                    >
                                                                        <Trophy size={10}/>
                                                                        REDEEM
                                                                    </button>
                                                                ) : (
                                                                    <>
                                                                        {/* Order Status Indicator */}
                                                                        <button 
                                                                            onClick={() => handleOpenOrderModal(pos)}
                                                                            className="px-2 py-1.5 bg-blue-50 dark:bg-blue-900/10 hover:bg-blue-100 dark:hover:bg-blue-900/20 text-blue-600 dark:text-blue-400 text-[10px] font-bold rounded border border-blue-200 dark:border-blue-900/30 transition-colors flex items-center gap-1"
                                                                            title="Manage Orders & Redeem"
                                                                        >
                                                                            <Activity size={10}/>
                                                                            ORDERS
                                                                        </button>
                                                                        <button 
                                                                            onClick={() => handleManualExit(pos)}
                                                                            disabled={exitingPositionId === (safeMarketId + pos.outcome)}
                                                                            className="px-3 py-1.5 bg-red-50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 text-[10px] font-bold rounded border border-red-200 dark:border-red-900/30 transition-colors flex items-center gap-1"
                                                                        >
                                                                            {exitingPositionId === (safeMarketId + pos.outcome) ? <Loader2 size={10} className="animate-spin"/> : <X size={10}/>}
                                                                            SELL
                                                                        </button>
                                                                    </>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })
                                        ) : (
                                            <div className="text-center py-8 text-gray-400 dark:text-gray-600 flex flex-col items-center gap-2">
                                                <div className="p-3 bg-gray-100 dark:bg-white/5 rounded-full"><ZapIcon size={20} className="opacity-50"/></div>
                                                <p className="text-xs italic">No active positions.</p>
                                            </div>
                                        )}
                                    </div>
                            ) : (
                                    /* HISTORY TAB */
                                    <div className="space-y-2">
                                        {tradeHistory.length > 0 ? (
                                            tradeHistory.slice(0, 8).map(trade => {
                                                const displayAmount = (trade.executedSize && trade.executedSize > 0) ? trade.executedSize : trade.size;
                                                // Defensive ID Check
                                                const tradeId = trade.marketId || "UNKNOWN";
                                                
                                                return (
                                                    <div key={trade.id} className="text-xs flex items-center justify-between p-2 bg-gray-50 dark:bg-black/40 rounded border border-gray-200 dark:border-white/5 hover:border-gray-300 dark:hover:border-gray-700 transition-colors">
                                                        <div className="flex items-center gap-3 overflow-hidden">
                                                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${trade.side === 'BUY' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-500'}`}>
                                                                {trade.side}
                                                            </span>
                                                            <div className="flex flex-col min-w-0">
                                                                <span className="font-bold text-gray-900 dark:text-white truncate max-w-[100px]">{trade.outcome}</span>
                                                                <span className="text-[10px] text-gray-500" title={tradeId}>
                                                                    {tradeId.length > 10 ? tradeId.slice(0, 10) + '...' : tradeId}
                                                                </span>
                                                            </div>
                                                        </div>
                                                        {/* ... Rest of row ... */}
                                                        <div className="flex items-center gap-3">
                                                            <div className="text-right">
                                                                <div className="font-mono font-bold text-gray-900 dark:text-white">${displayAmount.toFixed(2)}</div>
                                                                <div className="text-[10px] text-gray-500">@ {trade.price.toFixed(2)}</div>
                                                            </div>
                                                            {trade.txHash ? (
                                                                <a href={`https://polygonscan.com/tx/${trade.txHash}`} target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-600 dark:hover:text-blue-400 p-1 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded inline-block" title="View on PolygonScan">
                                                                    <ExternalLink size={14}/>
                                                                </a>
                                                            ) : <span className="w-5"></span>}
                                                        </div>
                                                    </div>
                                                );
                                            })
                                        ) : (
                                            <div className="text-center py-8 text-gray-400 dark:text-gray-600 flex flex-col items-center gap-2">
                                                <div className="p-3 bg-gray-100 dark:bg-white/5 rounded-full"><History size={20} className="opacity-50"/></div>
                                                <p className="text-xs italic">No trade history yet.</p>
                                            </div>
                                        )}
                                        {tradeHistory.length > 8 && (
                                            <button onClick={() => setActiveTab('history')} className="w-full py-2 text-[10px] text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg transition-colors">
                                                View Full History
                                            </button>
                                        )}
                                    </div>
                                )}
                        </div>
                    </div>
                </div>
            </div>
        )}

        {/* --- Money Market Tab --- */}
        {activeTab === 'money-market' && (
            <div className="space-y-12 animate-in fade-in slide-in-from-right-4 duration-500">
                <div className="relative p-6 sm:p-8 rounded-3xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-lg">
                    <div className="relative z-10">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="p-2 bg-white/20 rounded-xl">
                                <Scale size={20} className="text-white"/>
                            </div>
                            <h2 className="text-2xl sm:text-3xl font-bold">Market Making Engine</h2>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                            <div className="bg-white/10 p-3 rounded-xl">
                                <div className="font-medium text-emerald-100">Strategy</div>
                                <div className="text-white font-mono">Spread Capture (GTC)</div>
                            </div>
                            <div className="bg-white/10 p-3 rounded-xl">
                                <div className="font-medium text-emerald-100">Market Focus</div>
                                <div className="text-white font-mono">High-Vol / New Listings</div>
                            </div>
                            <div className="bg-white/10 p-3 rounded-xl">
                                <div className="font-medium text-emerald-100">Rewards</div>
                                <div className="text-white font-mono">Liquidity Incentives</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-between px-2">
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-emerald-500/10 rounded-2xl text-emerald-500"><Zap size={24}/></div>
                        <div>
                            <h3 className="text-xl font-black text-white">Live Yield Opportunities</h3>
                            <p className="text-xs text-slate-500">Real-time orderbook spread monitoring</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-6">
                        <button 
                            onClick={() => { fetchBotStatus(); setIsPolling(true); setTimeout(() => setIsPolling(false), 2000); }} 
                            className="p-3 hover:bg-white/5 rounded-2xl transition-all border border-white/10"
                        >
                            <RefreshCw size={18} className={isPolling ? "animate-spin text-emerald-500" : "text-slate-500"}/>
                        </button>
                    </div>
                </div>

                <MoneyMarketFeed opportunities={moneyMarketOpps} onExecute={handleExecuteMM} isAutoArb={config.enableAutoArb} />
            </div>
        )}
        
        {/* BRIDGE */}
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
                <div className="md:col-span-2 glass-panel p-4 sm:p-8 rounded-xl border border-gray-200 dark:border-terminal-border">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 sm:mb-8">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-blue-100 dark:bg-blue-900/20 rounded-lg text-blue-600 dark:text-blue-400">
                                <Globe size={20}/>
                            </div>
                            <div>
                                <h2 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-white">Cross-Chain Bridge</h2>
                                <p className="text-xs text-gray-500">{bridgeMode === 'IN' ? 'External → Polygon Trading Wallet' : 'Polygon Main Wallet → External'}</p>
                            </div>
                        </div>
                        
                        <div className="flex bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                            <button 
                                onClick={() => bridgeMode !== 'IN' && handleSwapDirection()}
                                className={`px-3 sm:px-4 py-1.5 text-xs font-bold rounded-md transition-all ${bridgeMode === 'IN' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                            >
                                Bridge In
                            </button>
                            <button 
                                onClick={() => bridgeMode !== 'OUT' && handleSwapDirection()}
                                className={`px-3 sm:px-4 py-1.5 text-xs font-bold rounded-md transition-all ${bridgeMode === 'OUT' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
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
                                        className="w-full flex items-center justify-between bg-white dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 border border-gray-200 dark:border-white/10 text-gray-900 dark:text-white text-sm rounded-lg px-3 py-2.5 transition-colors"
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
                                                    <option value={proxyAddress}>Trading Wallet (Vault) - {proxyAddress ? `${proxyAddress.slice(0,6)}...` : 'Initialize First'}</option>
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
                                                className={`px-3 py-1 text-[10px] font-bold rounded transition-all ${destToken === 'USDC' ? 'bg-white dark:bg-gray-600 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500'}`}
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

        {/* VAULT (REBRANDED & REDESIGNED) */}
        {activeTab === 'vault' && (
            <div className="max-w-5xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-300 pb-10">
                <div className="flex flex-col md:flex-row items-start md:items-center gap-4 mb-8 pb-8 border-b border-gray-200 dark:border-terminal-border">
                    <div className="flex items-center gap-4 w-full md:w-auto">
                        <div className="p-3 bg-blue-50 dark:bg-terminal-accent/10 rounded-xl">
                            <Sliders size={32} className="text-blue-600 dark:text-terminal-accent" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Strategy & Risk</h2>
                            <p className="text-gray-500 text-sm">Configure how your bot sizes positions and manages risk.</p>
                        </div>
                    </div>
                </div>
                
                {/* Vault Sovereignty Section */}
                <div className="mb-8 glass-panel border-purple-500/20 dark:border-purple-500/30 rounded-2xl overflow-hidden relative group">
                    {/* Background Decorative Element */}
                    <div className="absolute top-0 right-0 p-8 opacity-[0.03] dark:opacity-[0.07] group-hover:opacity-10 transition-opacity pointer-events-none">
                         {recoveryOwnerAdded ? <ShieldCheck size={180} /> : <Fingerprint size={180} />}
                    </div>

                    <div className="p-6 sm:p-8 relative z-10">
                        <div className="flex flex-col lg:flex-row justify-between items-start gap-8">
                            <div className="flex-1">
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="p-2.5 bg-purple-600 rounded-xl shadow-lg shadow-purple-500/20">
                                        <Shield className="text-white" size={24}/>
                                    </div>
                                    <div>
                                        <h3 className="text-l font-black text-gray-900 dark:text-white tracking-tight uppercase">
                                            Vault Sovereignty
                                        </h3>
                                        <p className="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-[0.2em]">Self-Custodial Protocol</p>
                                    </div>
                                </div>
                                
                                <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed max-w-3xl">
                                    By default, the server operates your vault as a managed signer. To achieve <strong>100% platform independence</strong>, 
                                    you can add your Main Wallet as a co-owner on the blockchain. This creates a fail-safe recovery path 
                                    that works even if this terminal is inaccessible.
                                </p>

                                {/* Instructional Grid */}
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-8">
                                    {[
                                        { icon: Link, title: "1. Authorize", desc: "Link Main Wallet" },
                                        { icon: Globe, title: "2. Connect", desc: "Visit Safe{Wallet}" },
                                        { icon: Key, title: "3. Import", desc: "Load Vault Safe" },
                                        { icon: ArrowUpCircle, title: "4. Recover", desc: "Direct Withdraw" }
                                    ].map((step, idx) => (
                                        <div key={idx} className="p-3 bg-gray-50 dark:bg-black/40 rounded-xl border border-gray-200 dark:border-white/5 flex flex-col items-center text-center group/step hover:border-purple-500/30 transition-all">
                                            <step.icon size={16} className="text-purple-500 mb-2 group-hover/step:scale-110 transition-transform" />
                                            <h4 className="text-[11px] font-bold text-gray-900 dark:text-white uppercase mb-1">{step.title}</h4>
                                            <p className="text-[9px] text-gray-500 leading-tight">{step.desc}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="lg:w-64 w-full flex flex-col gap-4">
                                <div className={`p-5 rounded-2xl border flex flex-col items-center text-center transition-all ${
                                    recoveryOwnerAdded 
                                    ? 'bg-green-50/50 dark:bg-green-900/10 border-green-500/30 shadow-lg shadow-green-500/5' 
                                    : 'bg-purple-50/50 dark:bg-purple-900/10 border-purple-500/30'
                                }`}>
                                    <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-3 ${
                                        recoveryOwnerAdded ? 'bg-green-500 text-white' : 'bg-purple-100 dark:bg-purple-900/40 text-purple-600'
                                    }`}>
                                        {recoveryOwnerAdded ? <ShieldCheck size={24}/> : <Lock size={24}/>}
                                    </div>
                                    
                                    <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Status</span>
                                    <span className={`text-sm font-black uppercase tracking-tight ${
                                        recoveryOwnerAdded ? 'text-green-600' : 'text-purple-600'
                                    }`}>
                                        {recoveryOwnerAdded ? 'Sovereign Path Active' : 'Managed Access Only'}
                                    </span>

                                    {!recoveryOwnerAdded && (
                                        <button 
                                            onClick={handleAddRecoveryOwner}
                                            disabled={isAddingRecovery}
                                            className="mt-4 w-full py-3 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-xl text-xs shadow-xl shadow-purple-500/20 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                        >
                                            {isAddingRecovery ? <Loader2 size={14} className="animate-spin"/> : <PlusCircle size={14}/>}
                                            UPGRADE VAULT
                                        </button>
                                    )}

                                    {recoveryOwnerAdded && (
                                        <a 
                                            href="https://app.safe.global" 
                                            target="_blank" 
                                            className="mt-4 w-full py-2 bg-white dark:bg-white/5 text-gray-900 dark:text-white border border-gray-200 dark:border-white/10 rounded-lg text-[10px] font-bold uppercase transition-all hover:bg-gray-50 dark:hover:bg-white/10 flex items-center justify-center gap-2"
                                        >
                                            Open Safe Dashboard <ExternalLink size={12}/>
                                        </a>
                                    )}
                                </div>
                                
                                <div className="p-3 bg-gray-100 dark:bg-white/5 rounded-xl border border-gray-200 dark:border-white/5">
                                    <div className="flex items-center gap-2 mb-1 text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase">
                                        <Info size={12}/> Governance Note
                                    </div>
                                    <p className="text-[9px] text-gray-400 leading-normal">
                                        Adding an owner requires a small blockchain transaction (~0.05 POL) to update the Safe contract on-chain.
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Money Market Protocols Section */}
                <div className="glass-panel p-6 md:p-8 rounded-3xl space-y-6 border border-blue-200 dark:border-blue-500/30 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm mb-8 transition-colors duration-300">
                    <div className="flex items-center gap-4 border-b border-gray-200 dark:border-slate-700 pb-4">
                        <div className="w-10 h-10 md:w-12 md:h-12 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-2xl flex items-center justify-center shadow-sm">
                            <Landmark size={20} />
                        </div>
                        <div>
                            <h4 className="font-bold text-gray-900 dark:text-white text-lg md:text-xl uppercase tracking-tight">Money Market</h4>
                            <p className="text-xs text-gray-500 dark:text-slate-400">Liquidity Provision & Yield</p>
                        </div>
                    </div>

                    <div className="space-y-6">
                        <div className="p-5 rounded-2xl bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-500/20 flex justify-between items-center group hover:shadow-sm transition-all duration-200">
                            <div className="max-w-[70%]">
                                <div className="font-bold text-gray-800 dark:text-gray-100 text-sm md:text-base uppercase mb-1">Autonomous Exploitation</div>
                                <p className="text-xs text-gray-600 dark:text-slate-400 leading-tight">When active, the server engine locks in spreads autonomously 24/7.</p>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input 
                                    type="checkbox" 
                                    checked={config.enableAutoArb} 
                                    onChange={(e) => updateConfig({ enableAutoArb: e.target.checked })} 
                                    className="sr-only peer"
                                />
                                <div className="w-12 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-6 peer-checked:bg-blue-600 after:content-[''] after:absolute after:top-[4px] after:left-[4px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all after:duration-200 peer-checked:after:border-blue-600"></div>
                            </label>
                        </div>

                        <div className="space-y-3 p-4 bg-white/50 dark:bg-slate-800/30 rounded-xl border border-gray-100 dark:border-slate-700/50">
                            <div className="flex justify-between items-center">
                                <label className="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider">Max Allocation per Leg</label>
                                <span className="text-sm font-mono font-bold bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2.5 py-1 rounded-lg">
                                    ${config.maxTradeAmount}
                                </span>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-xs text-gray-500 dark:text-slate-400 w-8">$10</span>
                                <input 
                                    type="range" 
                                    min="10" 
                                    max="500" 
                                    step="10" 
                                    className="flex-1 h-1.5 bg-gray-200 dark:bg-slate-600 rounded-full appearance-none cursor-pointer accent-blue-500" 
                                    value={config.maxTradeAmount} 
                                    onChange={e => updateConfig({ maxTradeAmount: Number(e.target.value) })}
                                />
                                <span className="text-xs text-gray-500 dark:text-slate-400 w-12 text-right">$500</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
                    {/* Left Column: Targets & AI */}
                    <div className="md:col-span-5 space-y-6">
                        {/* Target Wallets */}
                        <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-6 shadow-sm dark:shadow-none">
                            <label className="text-xs text-gray-500 font-bold uppercase mb-3 block flex items-center gap-2">
                                <Users size={14}/> Target Wallets
                            </label>
                            <div className="flex gap-2 mb-4">
                                <input 
                                    className="flex-1 bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded-lg px-3 py-2 text-sm font-mono text-gray-900 dark:text-white outline-none focus:border-blue-500 dark:focus:border-terminal-accent"
                                    placeholder="0x..."
                                    value={targetInput}
                                    onChange={e => setTargetInput(e.target.value)}
                                />
                                <button onClick={() => { if(targetInput) { updateConfig({...config, targets: [...config.targets, targetInput]}); setTargetInput(''); }}} className="px-4 bg-blue-600 dark:bg-terminal-accent rounded-lg text-white font-bold text-xs">ADD</button>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {config.targets.map(t => (
                                    <span key={t} className="px-3 py-1.5 bg-gray-100 dark:bg-white/5 rounded border border-gray-200 dark:border-white/10 text-xs text-gray-700 dark:text-gray-300 font-mono flex gap-2 items-center">
                                        {t.slice(0,6)}...{t.slice(-4)} 
                                        <button onClick={() => updateConfig({...config, targets: config.targets.filter(x => x !== t)})} className="hover:text-red-500"><X size={12}/></button>
                                    </span>
                                ))}
                            </div>
                        </div>

                        {/* AI Risk Guard */}
                        <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-6 shadow-sm dark:shadow-none">
                            <div className="flex items-center justify-between mb-4">
                                <label className="text-xs text-gray-500 font-bold uppercase flex items-center gap-2"><Brain size={14}/> AI Risk Guard</label>
                                <Tooltip text="Gemini 2.5 analyzes the market question. Conservative rejects volatile/ambiguous markets. Degen accepts almost everything." />
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                {['conservative', 'balanced', 'degen'].map(mode => (
                                    <button 
                                        key={mode} 
                                        onClick={() => updateConfig({...config, riskProfile: mode as any})} 
                                        className={`py-2 px-1 rounded-lg text-[10px] font-bold uppercase border transition-all ${config.riskProfile === mode ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-500 text-purple-600 dark:text-purple-400' : 'border-gray-200 dark:border-gray-800 text-gray-500 hover:bg-gray-50 dark:hover:bg-white/5'}`}
                                    >
                                        {mode}
                                    </button>
                                ))}
                            </div>
                            <div className="mt-4 relative">
                                <label className="text-[10px] text-gray-400 uppercase font-bold mb-1 block">Gemini API Key</label>
                                <input 
                                    type={showSecrets ? "text" : "password"}
                                    className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded-lg px-3 py-2 text-xs font-mono text-gray-900 dark:text-white outline-none focus:border-purple-500"
                                    value={config.geminiApiKey}
                                    onChange={e => updateConfig({...config, geminiApiKey: e.target.value})}
                                    placeholder="Required for AI analysis"
                                />
                                <button onClick={() => setShowSecrets(!showSecrets)} className="absolute right-3 top-7 text-gray-400">
                                    {showSecrets ? <EyeOff size={12}/> : <Eye size={12}/>}
                                </button>
                            </div>
                        </div>

                        {/* NEW: Liquidity Guard Section */}
                        <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-6 shadow-sm dark:shadow-none">
                            <div className="flex items-center justify-between mb-4">
                                <label className="text-xs text-gray-500 font-bold uppercase flex items-center gap-2">
                                    <Zap size={14} className="text-blue-500"/> Liquidity Filter
                                </label>
                                <Tooltip text="Slippage Protection: Only trade in markets that meet this liquidity health level. HIGH is safest but skips more trades." />
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                {['HIGH', 'MEDIUM', 'LOW'].map(level => (
                                    <button 
                                        key={level} 
                                        onClick={() => updateConfig({...config, minLiquidityFilter: level as any})} 
                                        className={`py-2 px-1 rounded-lg text-[10px] font-bold uppercase border transition-all ${config.minLiquidityFilter === level ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-500 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-gray-800 text-gray-500 hover:bg-gray-50 dark:hover:bg-white/5'}`}
                                    >
                                        {level}
                                    </button>
                                ))}
                            </div>
                            <p className="text-[10px] text-gray-400 mt-3 italic">
                                *Filters based on spread % and order book depth.
                            </p>
                        </div>

                        {/* Alerts & Notifications (RESTORED) */}
                        <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-6 shadow-sm dark:shadow-none">
                            <div className="flex items-center justify-between mb-4">
                                <label className="text-xs text-gray-500 font-bold uppercase flex items-center gap-2">
                                    <Volume2 size={14}/> App Sounds
                                </label>
                                <input 
                                    type="checkbox" 
                                    className="toggle-checkbox accent-blue-600 w-4 h-4"
                                    checked={config.enableSounds}
                                    onChange={e => updateConfig({...config, enableSounds: e.target.checked})}
                                />
                            </div>

                            <hr className="border-gray-100 dark:border-white/5 my-4"/>

                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs text-gray-500 font-bold uppercase flex items-center gap-2">
                                    <MessageSquare size={14}/> SMS Alerts
                                </label>
                                <input 
                                    type="checkbox"
                                    className="toggle-checkbox accent-green-500 w-4 h-4"
                                    checked={config.enableNotifications}
                                    onChange={e => updateConfig({...config, enableNotifications: e.target.checked})}
                                />
                            </div>
                            
                            <div className={`transition-opacity ${config.enableNotifications ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
                                <input 
                                    type="tel"
                                    className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded-lg px-3 py-2 text-xs font-mono text-gray-900 dark:text-white outline-none focus:border-green-500"
                                    placeholder="+1234567890"
                                    value={config.userPhoneNumber}
                                    onChange={e => updateConfig({...config, userPhoneNumber: e.target.value})}
                                />
                                <p className="text-[10px] text-gray-400 mt-1">Receive texts for trades & cashouts.</p>
                            </div>
                        </div>
                    </div>

                    {/* Right Column: Sizing & Limits */}
                    <div className="md:col-span-7 space-y-6">
                        
                        {/* Position Sizing */}
                        <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-6 shadow-sm dark:shadow-none">
                            <h4 className="text-xs font-bold text-gray-900 dark:text-white uppercase tracking-wider mb-6 flex items-center gap-2">
                                <DollarSign size={14} className="text-green-500"/> Position Sizing
                            </h4>
                            
                            <div className="space-y-6">
                                <div>
                                    <div className="flex justify-between mb-2">
                                        <label className="text-xs text-gray-500 font-bold uppercase">Size Multiplier</label>
                                        <span className="text-sm font-bold text-blue-600 dark:text-terminal-accent">{config.multiplier}x</span>
                                    </div>
                                    <input 
                                        type="range" min="0.1" max="5.0" step="0.1" 
                                        className="w-full accent-blue-600 h-1 bg-gray-200 dark:bg-gray-800 rounded-lg appearance-none cursor-pointer" 
                                        value={config.multiplier} 
                                        onChange={e => updateConfig({...config, multiplier: Number(e.target.value)})}
                                    />
                                    <p className="text-[10px] text-gray-400 mt-2">
                                        Based on proportional equity. If Whale uses 1% of their portfolio, you use {config.multiplier}% of yours.
                                    </p>
                                </div>

                                <div className="grid grid-cols-2 gap-6 pt-4 border-t border-gray-100 dark:border-white/5">
                                    <div>
                                        <label className="text-xs text-gray-500 font-bold uppercase mb-2 block flex items-center gap-1">
                                            Max Bet Cap <Tooltip text="The hard ceiling. The bot will NEVER bet more than this amount on a single trade, regardless of the multiplier."/>
                                        </label>
                                        <div className="relative">
                                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
                                            <input 
                                                type="number"
                                                className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded-lg pl-6 pr-3 py-2 text-sm font-bold text-gray-900 dark:text-white outline-none focus:border-blue-500"
                                                value={config.maxTradeAmount}
                                                onChange={e => updateConfig({...config, maxTradeAmount: Number(e.target.value)})}
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-xs text-gray-500 font-bold uppercase mb-2 block flex items-center gap-1">
                                            Auto Take-Profit <Tooltip text="If a position goes up by this %, the bot will automatically sell it to secure gains."/>
                                        </label>
                                        <div className="relative">
                                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs">+</span>
                                            <input 
                                                type="number"
                                                className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded-lg pl-6 pr-8 py-2 text-sm font-bold text-green-600 dark:text-green-400 outline-none focus:border-green-500"
                                                value={config.autoTp}
                                                onChange={e => updateConfig({...config, autoTp: Number(e.target.value)})}
                                            />
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs">%</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Profit Security (Cashout) */}
                        <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-6 shadow-sm dark:shadow-none">
                            <div className="flex items-center justify-between mb-6">
                                <h4 className="text-xs font-bold text-gray-900 dark:text-white uppercase tracking-wider flex items-center gap-2">
                                    <LockKeyhole size={14} className="text-orange-500"/> Profit Security
                                </h4>
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-bold text-gray-400">AUTO-SWEEP</span>
                                    <input 
                                        type="checkbox" 
                                        className="toggle-checkbox accent-orange-500 w-4 h-4"
                                        checked={config.enableAutoCashout}
                                        onChange={e => updateConfig({...config, enableAutoCashout: e.target.checked})}
                                    />
                                </div>
                            </div>
                            
                            <div className={`space-y-4 transition-opacity ${config.enableAutoCashout ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
                                <p className="text-xs text-gray-500">
                                    Automatically withdraw excess profits to your cold wallet when balance exceeds the retention limit.
                                </p>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="text-[10px] text-gray-500 uppercase font-bold block mb-1">Keep in Bot ($)</label>
                                        <input 
                                            type="number"
                                            className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded px-3 py-2 text-sm text-gray-900 dark:text-white"
                                            value={config.maxRetentionAmount}
                                            onChange={e => updateConfig({...config, maxRetentionAmount: Number(e.target.value)})}
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-gray-500 uppercase font-bold block mb-1">Cold Wallet Address</label>
                                        <input 
                                            type="text"
                                            className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded px-3 py-2 text-xs font-mono text-gray-900 dark:text-white"
                                            placeholder="0x..."
                                            value={config.coldWalletAddress}
                                            onChange={e => updateConfig({...config, coldWalletAddress: e.target.value})}
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="flex justify-end pt-4">
                            <button 
                                onClick={() => {
                                    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
                                    alert("Configuration Saved");
                                }} 
                                className="px-8 py-3 bg-gray-900 dark:bg-white text-white dark:text-black font-bold rounded-xl shadow-lg hover:opacity-90 transition-all flex items-center gap-2"
                            >
                                <Save size={16} /> SAVE CONFIGURATION
                            </button>
                        </div>
                    </div>
                </div>
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
            <div className="glass-panel border border-gray-200 dark:border-terminal-border rounded-xl overflow-hidden h-full animate-in fade-in slide-in-from-bottom-2 duration-300 flex flex-col">
                <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
                    <h3 className="font-bold text-gray-900 dark:text-white flex items-center gap-2"><History size={16} className="text-gray-500"/> Trade Log</h3>
                    <div className="flex items-center gap-4">
                        <span className="text-xs text-gray-500 font-mono">{tradeHistory.length} Entries</span>
                        {proxyAddress && (
                            <a 
                                href={`https://polymarket.com/profile/${proxyAddress}?tab=activity`} 
                                target="_blank" 
                                rel="noreferrer" 
                                className="flex items-center gap-1 text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded hover:underline"
                            >
                                Verify on Polymarket <ExternalLink size={10}/>
                            </a>
                        )}
                    </div>
                </div>
                <div className="overflow-x-auto flex-1">
                    <table className="w-full text-left text-xs">
                        <thead className="bg-gray-100 dark:bg-black text-gray-500 uppercase font-bold tracking-wider sticky top-0 z-10">
                            <tr>
                                <th className="p-4 pl-6">Time</th>
                                <th className="p-4">Market</th>
                                <th className="p-4">Side</th>
                                <th className="p-4">Exec. Price</th>
                                <th className="p-4">My Stake</th>
                                <th className="p-4">AI Reasoning</th>
                                <th className="p-4 text-center">Chain</th>
                                <th className="p-4 text-right pr-6">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-gray-800 font-mono">
                            {tradeHistory.map((tx) => {
                                // Prefer executedSize (User amount) over size (Whale amount) for display
                                const displayAmount = (tx.executedSize && tx.executedSize > 0) ? tx.executedSize : tx.size;
                                
                                return (
                                    <tr key={tx.id} className={`hover:bg-gray-50 dark:hover:bg-white/5 transition-colors ${tx.status === 'SKIPPED' ? 'opacity-50 grayscale' : ''}`}>
                                        <td className="p-4 pl-6 text-gray-500 whitespace-nowrap">{new Date(tx.timestamp).toLocaleString()}</td>
                                        <td className="p-4 text-gray-900 dark:text-white max-w-[200px] truncate" title={tx.marketId}>{tx.marketId}</td>
                                        <td className="p-4">
                                            <span className={`px-2 py-0.5 rounded font-bold ${tx.side === 'BUY' ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-500' : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-500'}`}>
                                                {tx.side} {tx.outcome}
                                            </span>
                                        </td>
                                        <td className="p-4 text-gray-900 dark:text-white font-bold">{tx.price > 0 ? tx.price.toFixed(2) : '-'}</td>
                                        <td className="p-4 text-gray-900 dark:text-white font-mono font-bold">${displayAmount.toFixed(2)}</td>
                                        <td className="p-4 text-gray-500 max-w-[300px] truncate" title={tx.aiReasoning}>
                                            {tx.riskScore ? <span className={`mr-2 font-bold ${tx.riskScore > 7 ? 'text-red-500' : 'text-purple-500'}`}>[{tx.riskScore}/10]</span> : ''}
                                            {tx.aiReasoning || '-'}
                                        </td>
                                        <td className="p-4 text-center">
                                            {tx.txHash ? (
                                                <a href={`https://polygonscan.com/tx/${tx.txHash}`} target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-600 dark:hover:text-blue-400 p-1 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded inline-block" title="View on PolygonScan">
                                                    <ExternalLink size={14}/>
                                                </a>
                                            ) : <span className="text-gray-300">-</span>}
                                        </td>
                                        <td className="p-4 text-right pr-6">
                                            <span className={`font-bold px-2 py-1 rounded text-[10px] uppercase ${
                                                tx.status === 'CLOSED' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-500' : 
                                                tx.status === 'SKIPPED' || tx.status === 'FAILED' ? 'bg-gray-200 dark:bg-gray-800 text-gray-500' : 
                                                'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-500'
                                            }`}>
                                                {tx.status}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    {tradeHistory.length === 0 && <div className="p-12 text-center text-gray-600 text-sm">No history available yet. Start the bot to generate data.</div>}
                </div>
            </div>
        )}

        {/* HELP PAGE */}
        {activeTab === 'help' && (
            <div className="max-w-5xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-300 pb-20">
                
                <div className="text-center space-y-4 pt-4">
                    <h2 className="text-4xl font-black text-gray-900 dark:text-white tracking-tight flex items-center justify-center gap-3">
                        <BookOpen className="text-blue-600" size={32}/> 
                        <span>Command Center Guide</span>
                    </h2>
                    <p className="text-gray-500 dark:text-gray-400 text-lg max-w-2xl mx-auto">
                        Master the terminal. From setup to professional execution strategies.
                    </p>
                    
                    <button 
                        onClick={() => setShowHelpGuide(true)}
                        className="mt-6 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-500/20 transition-all flex items-center gap-3 mx-auto"
                    >
                        <BadgeCheck size={18} />
                        View Institutional Protocols
                    </button>
                </div>

                <div className="glass-panel p-8 rounded-2xl border border-gray-200 dark:border-terminal-border relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-6 opacity-5"><Rocket size={150}/></div>
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-8 flex items-center gap-2 relative z-10">
                        <Zap className="text-yellow-500" size={24}/> Setup Workflow
                    </h3>
                    
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-6 relative z-10">
                        {[
                            { icon: ArrowDownCircle, title: "1. Fund", desc: "Deposit USDC.e and POL via Bridge.", color: "text-blue-500" },
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
                                Your Trading Wallet lives on the <strong>Polygon</strong> blockchain. If you already have USDC on Polygon, simply send it to the address shown in your Dashboard. <strong>You need both POL (Gas) and USDC.e (Trading).</strong>
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

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="glass-panel p-8 rounded-2xl border border-gray-200 dark:border-terminal-border bg-blue-50/50 dark:bg-blue-900/5">
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2">
                            <Server className="text-blue-600" size={24}/> The CLOB Engine
                        </h3>
                        <div className="space-y-6 text-sm text-gray-600 dark:text-gray-400">
                            <p className="leading-relaxed">
                                Bet Mirror uses the <strong>Dedicated Gnosis Safe</strong> model. Unlike basic bots that use raw private keys, our engine deploys a Smart Contract Wallet for every user. This allows for **Gasless Trading** via the Polymarket Relayer.
                            </p>
                            <div className="space-y-3">
                                <div className="flex gap-3">
                                    <CheckCircle2 size={18} className="text-green-500 shrink-0"/>
                                    <div>
                                        <strong className="text-gray-900 dark:text-white">Gasless Transactions</strong>
                                        <p className="text-xs mt-1">Trades are routed through the Polymarket Relayer. You do not need to hold POL (Matic) for gas fees on trading actions.</p>
                                    </div>
                                </div>
                                <div className="flex gap-3">
                                    <CheckCircle2 size={18} className="text-green-500 shrink-0"/>
                                    <div>
                                        <strong className="text-gray-900 dark:text-white">Builder Attribution</strong>
                                        <p className="text-xs mt-1">We inject cryptographic headers into every order, identifying your trades as part of the "Bet Mirror" institutional volume.</p>
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
                                        <th className="pb-2 font-bold text-gray-500 uppercase">Standard Web Bot</th>
                                        <th className="pb-2 font-bold text-blue-600 dark:text-blue-400 uppercase">Bet Mirror Pro</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                                    <tr>
                                        <td className="py-3 font-medium text-gray-900 dark:text-white">Wallet Type</td>
                                        <td className="py-3 text-gray-500">Shared / Custodial EOA</td>
                                        <td className="py-3 text-gray-500 font-bold">Dedicated Gnosis Safe</td>
                                    </tr>
                                    <tr>
                                        <td className="py-3 font-medium text-gray-900 dark:text-white">Execution</td>
                                        <td className="py-3 text-gray-500">User Pays Gas</td>
                                        <td className="py-3 text-gray-500 font-bold">Relayer (Gasless)</td>
                                    </tr>
                                    <tr>
                                        <td className="py-3 font-medium text-gray-900 dark:text-white">Ownership</td>
                                        <td className="py-3 text-gray-500">Platform Owned</td>
                                        <td className="py-3 text-gray-500 font-bold">Smart Contract (User Owned)</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            
                {/* 1. The Wallet Chain */}
                <div className="glass-panel p-8 rounded-2xl border border-gray-200 dark:border-terminal-border relative overflow-hidden">
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2">
                        <Key className="text-yellow-500" size={24}/> The 3-Key System
                    </h3>
                    
                     <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative z-10">
                        <div className="p-6 bg-white dark:bg-black/20 rounded-xl border border-gray-200 dark:border-white/10">
                            <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center text-blue-600 dark:text-blue-400 mb-4">
                                <Wallet size={20}/>
                            </div>
                            <h4 className="font-bold text-gray-900 dark:text-white mb-2">1. Main Wallet (You)</h4>
                            <p className="text-xs text-gray-500 leading-relaxed">
                                Your MetaMask or Phantom wallet. This is the **Admin**. You use it to log in, deposit funds, and receive profits. We never touch this key.
                            </p>
                        </div>
                        <div className="p-6 bg-white dark:bg-black/20 rounded-xl border border-gray-200 dark:border-white/10">
                            <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/30 rounded-full flex items-center justify-center text-purple-600 dark:text-purple-400 mb-4">
                                <Server size={20}/>
                            </div>
                            <h4 className="font-bold text-gray-900 dark:text-white mb-2 text-sm flex items-center gap-2">2. The Trading Key (Bot)
                            </h4>
                            <p className="text-xs text-gray-500 leading-relaxed">
                                An encrypted EOA private key. This key acts as the <strong>Operator</strong>. It has permission to sign trades for your Gnosis Safe, but it does not hold the funds itself.
                            </p>
                        </div>
                        <div className="p-6 bg-white dark:bg-black/20 rounded-xl border border-gray-200 dark:border-white/10">
                            <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center text-green-600 dark:text-green-500 mb-4">
                                <Shield size={20}/>
                            </div>
                            <h4 className="font-bold text-gray-900 dark:text-white mb-2">3. Safe (Vault)</h4>
                            <p className="text-xs text-gray-500 leading-relaxed">
                                A Gnosis Safe Smart Contract on Polygon. This is the **Vault**. Your trading capital sits here. It executes trades only when signed by the Controller.
                            </p>
                        </div>
                    </div>
                </div>

                {/* 2. Execution Flow */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="glass-panel p-8 rounded-2xl border border-gray-200 dark:border-terminal-border bg-blue-50/50 dark:bg-blue-900/5">
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2">
                            <Zap className="text-blue-600" size={24}/> Gasless Execution
                        </h3>
                        <div className="space-y-4 text-sm text-gray-600 dark:text-gray-400">
                            <p>
                                How do we trade without you paying MATIC for every bet?
                            </p>
                            <ol className="list-decimal pl-5 space-y-2">
                                <li>Bot detects a signal and AI approves it.</li>
                                <li>Signer (Bot) cryptographically signs the order intent.</li>
                                <li>This signature is sent to the **Polymarket Relayer**.</li>
                                <li>The Relayer pays the gas fees and submits the transaction to the blockchain.</li>
                                <li>The Gnosis Safe validates the signature and executes the trade.</li>
                            </ol>
                        </div>
                    </div>

                    <div className="glass-panel p-8 rounded-2xl border border-gray-200 dark:border-terminal-border">
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6 flex items-center gap-2">
                            <LockKeyhole className="text-red-500" size={24}/> Recovery & Sovereignty
                        </h3>
                        <div className="space-y-4 text-sm text-gray-600 dark:text-gray-400">
                            <p>
                                What if Bet Mirror disappears?
                            </p>
                            <ul className="list-disc pl-5 space-y-2">
                                <li>
                                    <strong>Withdrawal:</strong> You can trigger a full withdrawal to your Main Wallet at any time via the Dashboard.
                                </li>
                                <li>
                                    <strong>Sovereignty (Advanced):</strong> In the Vault tab, you can add your Main Wallet as a "Co-Owner" of the Safe. This gives you direct, on-chain control of your funds via the Gnosis Safe UI, bypassing our servers entirely.
                                </li>
                            </ul>
                        </div>
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
        targetAddress={proxyAddress || userAddress}
    />

    {/* Withdrawal Modal */}
    <WithdrawalModal 
        isOpen={isWithdrawModalOpen}
        onClose={() => { setIsWithdrawModalOpen(false); setWithdrawalTxHash(null); }}
        balances={proxyWalletBal}
        signerBalances={signerWalletBal}
        onWithdraw={handleWithdraw}
        isWithdrawing={isWithdrawing}
        successTx={withdrawalTxHash}
    />

    {/* Help Guide Modal */}
    <HelpGuideModal
        isOpen={showHelpGuide}
        onClose={() => setShowHelpGuide(false)}
    />

    {/* Order Management Modal */}
    <OrderManagementModal
        isOpen={isOrderModalOpen}
        onClose={() => setIsOrderModalOpen(false)}
        position={selectedPosition}
        orders={openOrders}
        onCancelOrder={handleCancelOrder}
        onRedeemWinnings={handleRedeemWinnings}
    />

    </div>
);
};

// Initialize React app with HMR support
const container = document.getElementById('root');
if (!container) throw new Error('Root container not found');

let root: ReturnType<typeof createRoot>;

if (!(container as any)._reactRoot) {
    root = createRoot(container);
    (container as any)._reactRoot = root;
} else {
    root = (container as any)._reactRoot;
}

root.render(<App />);