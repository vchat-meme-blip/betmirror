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
  Sun, Moon, Loader2, Timer, Fuel, Check, BarChart3, ChevronDown, MousePointerClick
} from 'lucide-react';
import { web3Service, USDC_POLYGON, USDC_ABI } from './src/services/web3.service';
import { lifiService, BridgeTransactionRecord } from './src/services/lifi-bridge.service';
import { ZeroDevService } from './src/services/zerodev.service';
import { TradeHistoryEntry } from './src/domain/trade.types';
import { TraderProfile, CashoutRecord } from './src/domain/alpha.types';
import { UserStats } from './src/domain/user.types';
import { parseUnits, formatUnits, Contract, BrowserProvider, JsonRpcProvider } from 'ethers';

// Initialize Services
const zeroDevService = new ZeroDevService(process.env.ZERODEV_RPC || 'https://rpc.zerodev.app/api/v2/bundler/PROJECT_ID');

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
}

interface WalletBalances {
    native: string;
    usdc: string;
}

interface SystemStats {
    totalUsers: number;
    totalVolume: number;
    totalRevenue: number;
    totalBridged: number;
    activeBots: number;
}

const STORAGE_KEY = 'bet_mirror_v3_config';

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
            {/* Chat Bubble / Toggle */}
            {!isOpen && (
                <button 
                    onClick={() => setIsOpen(true)} 
                    className="w-14 h-14 bg-blue-600 rounded-full flex items-center justify-center text-white shadow-lg hover:scale-110 transition-all hover:shadow-blue-500/30 group relative"
                >
                    <MessageSquare size={24} className="group-hover:rotate-12 transition-transform" />
                    <span className="absolute top-0 right-0 w-3 h-3 bg-red-500 rounded-full border-2 border-white dark:border-black"></span>
                </button>
            )}

            {/* Modal */}
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

// --- New Component: Bridge Stepper ---
const BridgeStepper = ({ status }: { status: string }) => {
    // Determine step based on status string
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
                {/* Progress Bar Background */}
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

const App = () => {
  // --- STATE: Web3 & Session ---
  const [isConnected, setIsConnected] = useState(false);
  const [needsActivation, setNeedsActivation] = useState(false);
  const [userAddress, setUserAddress] = useState<string>('');
  const [chainId, setChainId] = useState<number>(137);
  
  const [proxyAddress, setProxyAddress] = useState<string>('');
  const [proxyType, setProxyType] = useState<'SMART_ACCOUNT'>('SMART_ACCOUNT'); // Strictly Smart Account
  
  // --- STATE: Balances ---
  const [mainWalletBal, setMainWalletBal] = useState<WalletBalances>({ native: '0.00', usdc: '0.00' });
  const [proxyWalletBal, setProxyWalletBal] = useState<WalletBalances>({ native: '0.00', usdc: '0.00' });

  // --- STATE: UI & Data ---
  const [activeTab, setActiveTab] = useState<'dashboard' | 'marketplace' | 'history' | 'vault' | 'bridge' | 'system' | 'help'>('dashboard');
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const [history, setHistory] = useState<TradeHistoryEntry[]>([]);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [registry, setRegistry] = useState<TraderProfile[]>([]);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [bridgeHistory, setBridgeHistory] = useState<BridgeTransactionRecord[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  
  // --- STATE: Forms & Actions ---
  const [isDepositing, setIsDepositing] = useState(false);
  const [depositAmount, setDepositAmount] = useState('50');
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [isActivating, setIsActivating] = useState(false);
  const [targetInput, setTargetInput] = useState('');
  const [newWalletInput, setNewWalletInput] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);
  const [isAddingWallet, setIsAddingWallet] = useState(false);
  const [showArchitecture, setShowArchitecture] = useState(false);
  
  // --- STATE: Bridging ---
  const [bridgeFromChain, setBridgeFromChain] = useState(8453); // Default to Base
  const [bridgeAmount, setBridgeAmount] = useState('0.1');
  const [bridgeQuote, setBridgeQuote] = useState<any>(null);
  const [isBridging, setIsBridging] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<string>('');

  const [config, setConfig] = useState<AppConfig>({
    targets: [],
    rpcUrl: 'https://polygon-rpc.com',
    geminiApiKey: '',
    multiplier: 1.0,
    riskProfile: 'balanced',
    autoTp: 20,
    enableNotifications: false,
    userPhoneNumber: '',
    enableAutoCashout: false,
    maxRetentionAmount: 50,
    coldWalletAddress: ''
  });

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
      }
  }, [userAddress]);

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

  // --- POLL DATA ---
  useEffect(() => {
    if (!isConnected || !userAddress || needsActivation) return;
    
    // Poll Server State
    const interval = setInterval(async () => {
        try {
            const res = await axios.get(`/api/bot/status/${userAddress}`);
            setIsRunning(res.data.isRunning);
            if (res.data.logs) setLogs(res.data.logs);
            if (res.data.history) setHistory(res.data.history);
            if (res.data.stats) setStats(res.data.stats);

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
  }, [isConnected, userAddress, proxyAddress, needsActivation, activeTab]);

  useEffect(() => {
      if(isConnected && !needsActivation) fetchRegistry();
  }, [isConnected, needsActivation]);

  // --- HELPER: Fetch Balances ---
  const fetchBalances = async () => {
      if (!userAddress || !(window as any).ethereum) return;
      try {
          const provider = new BrowserProvider((window as any).ethereum);
          const network = await provider.getNetwork();
          setChainId(Number(network.chainId));

          // 1. Main Wallet (Native)
          const balMain = await provider.getBalance(userAddress);
          let mainUsdc = '0.00';
          
          // 2. Main Wallet (USDC - if on Polygon)
          if (Number(network.chainId) === 137) {
              const usdcContract = new Contract(USDC_POLYGON, USDC_ABI, provider);
              const balUsdc = await usdcContract.balanceOf(userAddress);
              mainUsdc = formatUnits(balUsdc, 6);
          }

          setMainWalletBal({ 
              native: formatUnits(balMain, 18).slice(0,6), 
              usdc: parseFloat(mainUsdc).toFixed(2) 
          });
          
          // 3. Proxy Wallet Balances (Read-only from Polygon RPC)
          if (proxyAddress) {
              const polyProvider = new JsonRpcProvider('https://polygon-rpc.com');
              const polyBal = await polyProvider.getBalance(proxyAddress);
              const usdcContract = new Contract(USDC_POLYGON, USDC_ABI, polyProvider);
              const usdcBal = await usdcContract.balanceOf(proxyAddress);
              
              setProxyWalletBal({
                  native: formatUnits(polyBal, 18).slice(0,6),
                  usdc: parseFloat(formatUnits(usdcBal, 6)).toFixed(2)
              });
          }
      } catch (e) {}
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
          alert(e.message || "Failed to connect");
      }
  };

  // --- HANDLERS: Smart Account Activation ---
  const handleActivateSmartAccount = async () => {
     setIsActivating(true);
     try {
         const walletClient = await web3Service.getViemWalletClient();
         
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
         alert("✅ Smart Account Activated! You can now deposit funds.");

     } catch (e: any) {
         console.error(e);
         alert("Activation failed: " + e.message);
     } finally {
         setIsActivating(false);
     }
  };

  // --- HANDLERS: Money & Bridge ---
  const handleDepositClick = async () => {
      if (chainId !== 137) {
          // If not on Polygon, suggest Bridging
          const confirmBridge = confirm(`You are connected to Chain ID ${chainId} (Not Polygon).\n\nDo you want to BRIDGE funds to your bot?`);
          if (confirmBridge) {
              setBridgeFromChain(chainId); // Auto set source
              setActiveTab('bridge');
              return;
          }
      } 
      setIsDepositing(!isDepositing);
  };

  const handleDeposit = async () => {
      if (!proxyAddress) return;
      setIsDepositing(true);
      try {
          await web3Service.deposit(proxyAddress, depositAmount);
          alert("Deposit Transaction Sent! Funds will arrive shortly.");
          setIsDepositing(false);
      } catch (e: any) {
          alert(`Deposit Failed: ${e.message}`);
          setIsDepositing(false);
      }
  };

  const handleGetBridgeQuote = async () => {
      if (!bridgeAmount || !proxyAddress) return;
      setBridgeQuote(null);
      try {
          const fromToken = lifiService.getNativeToken(bridgeFromChain);
          const rawAmount = (Number(bridgeAmount) * 1e18).toString();

          const routes = await lifiService.getDepositRoute({
              fromChainId: bridgeFromChain,
              fromTokenAddress: fromToken, 
              fromAmount: rawAmount, 
              toChainId: 137, // Polygon
              toTokenAddress: USDC_POLYGON, // USDC
              toAddress: proxyAddress
          });
          
          if(routes && routes.length > 0) {
              setBridgeQuote(routes[0]);
          } else {
              alert("No route found for this pair.");
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
          
          alert("✅ Bridging Complete! Funds are arriving in your Smart Account.");
          setBridgeQuote(null);
          // Refetch from server
          lifiService.fetchHistory().then(setBridgeHistory);
      } catch (e: any) {
          alert("Bridge Failed: " + e.message);
      } finally {
          setIsBridging(false);
          setBridgeStatus('');
      }
  };

  const handleWithdraw = async () => {
      if(!confirm("Are you sure you want to withdraw ALL funds?")) return;
      setIsWithdrawing(true);

      try {
         const walletClient = await web3Service.getViemWalletClient();
         // In a real scenario, fetch exact balance first
         const withdrawAmount = parseUnits("1000", 6); 
         
         alert("🔒 SECURE WITHDRAWAL\n\nPlease sign the UserOperation in your wallet.\nThis sends a direct command to your Smart Account to release funds.");
         
         const txHash = await zeroDevService.withdrawFunds(
             walletClient,
             proxyAddress,
             userAddress,
             withdrawAmount,
             USDC_POLYGON
         );
         
         alert(`✅ Withdrawal Successful!\nTx Hash: ${txHash}`);
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
          setConfig(prev => ({ ...prev, targets: [...prev.targets, targetInput] }));
      }
      setTargetInput('');
  };

  const removeTarget = (t: string) => {
      setConfig(prev => ({ ...prev, targets: prev.targets.filter(x => x !== t) }));
  };
  
  const copyFromMarketplace = (address: string) => {
      if (!config.targets.includes(address)) {
          setConfig(prev => ({ ...prev, targets: [...prev.targets, address] }));
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
          <div className="min-h-screen bg-white dark:bg-[#050505] flex flex-col items-center justify-center text-gray-900 dark:text-white p-4 transition-colors duration-200">
              {/* Theme Toggle */}
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
                      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-500/30">
                          <Zap size={32} className="text-blue-600 dark:text-blue-400" />
                      </div>
                      <div>
                          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Activate Smart Bot</h2>
                          <p className="text-gray-500">Set up your non-custodial trading account.</p>
                      </div>
                  </div>

                  <div className="space-y-4">
                      <div className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-lg border border-gray-200 dark:border-white/5">
                          <CheckCircle2 size={16} className="text-green-500 mt-1" />
                          <div>
                              <span className="text-sm font-bold text-gray-900 dark:text-white">Non-Custodial Security</span>
                              <p className="text-xs text-gray-500">You hold the admin keys. We only get trade permissions.</p>
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

                  <button 
                      onClick={handleActivateSmartAccount}
                      disabled={isActivating}
                      className="w-full py-4 bg-gradient-to-r from-blue-600 to-blue-500 text-white font-bold rounded-xl hover:opacity-90 transition-all flex items-center justify-center gap-3 shadow-lg shadow-blue-500/20"
                  >
                      {isActivating ? <RefreshCw className="animate-spin" /> : <Rocket size={20} />}
                      {isActivating ? 'DEPLOYING SMART ACCOUNT...' : 'CREATE SMART ACCOUNT'}
                  </button>
                  <p className="text-center text-[10px] text-gray-500">By clicking Create, you sign a Session Key transaction.</p>
              </div>
          </div>
      );
  }

  // --- VIEW: MAIN APP ---
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-terminal-bg text-gray-900 dark:text-gray-300 font-sans selection:bg-blue-500/30 selection:text-white flex flex-col transition-colors duration-200">
      
      {/* --- HEADER --- */}
      <header className="h-16 border-b border-gray-200 dark:border-terminal-border bg-white/80 dark:bg-terminal-card/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-full flex items-center justify-between">
            <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/30">
                    <Activity className="text-white" size={18} />
                </div>
                <div>
                    <h1 className="font-bold text-gray-900 dark:text-white tracking-tight leading-none">
                        <span className="text-blue-600">BET</span> MIRROR
                    </h1>
                    <span className="text-[10px] text-gray-500 font-mono tracking-widest uppercase">TERMINAL</span>
                </div>
            </div>

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

            <div className="flex items-center gap-4">
                 {/* Theme Toggle */}
                 <button onClick={toggleTheme} className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-white/10 text-gray-600 dark:text-gray-400 transition-colors">
                     {theme === 'light' ? <Moon size={16}/> : <Sun size={16}/>}
                 </button>

                 <div className="hidden md:flex flex-col items-end mr-2">
                    <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full status-dot ${isRunning ? 'bg-green-500 text-green-500' : 'bg-gray-400 text-gray-400'}`}></div>
                        <span className="text-[10px] font-mono font-bold text-gray-500 dark:text-gray-400">{isRunning ? 'ENGINE ONLINE' : 'STANDBY'}</span>
                    </div>
                 </div>

                 {isRunning ? (
                    <button onClick={handleStop} className="h-9 px-4 bg-red-50 dark:bg-terminal-danger/10 hover:bg-red-100 dark:hover:bg-terminal-danger/20 text-red-600 dark:text-terminal-danger border border-red-200 dark:border-terminal-danger/50 rounded flex items-center gap-2 text-xs font-bold transition-all">
                        <Square size={14} fill="currentColor" /> STOP
                    </button>
                ) : (
                    <button onClick={handleStart} className="h-9 px-4 bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-2 text-xs font-bold transition-all shadow-lg shadow-blue-500/30">
                        <Play size={14} fill="currentColor" /> START ENGINE
                    </button>
                )}
            </div>
        </div>
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
                        
                        <div className="grid grid-cols-2 gap-8 relative z-10">
                             {/* Connected Wallet */}
                             <div className="space-y-3">
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-[10px] text-white">W</div>
                                    <span className="text-sm font-bold text-gray-900 dark:text-white">Main Wallet</span>
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
                                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] text-white bg-purple-600">P</div>
                                    <span className="text-sm font-bold text-gray-900 dark:text-white">Smart Bot</span>
                                    <span className="text-[10px] text-gray-500 bg-gray-200 dark:bg-gray-900 px-1.5 rounded">Polygon</span>
                                </div>
                                <div className="p-3 bg-white dark:bg-black/40 rounded border border-gray-200 dark:border-gray-800 flex justify-between shadow-sm dark:shadow-none">
                                    <span className="text-xs text-gray-500 dark:text-gray-400">POL</span>
                                    <span className="text-sm font-mono text-gray-900 dark:text-white">{proxyWalletBal.native}</span>
                                </div>
                                <div className="p-3 bg-white dark:bg-black/40 rounded border border-gray-200 dark:border-gray-800 flex justify-between shadow-sm dark:shadow-none">
                                    <span className="text-xs text-gray-500 dark:text-gray-400">USDC</span>
                                    <span className="text-sm font-mono text-gray-900 dark:text-white">{proxyWalletBal.usdc}</span>
                                </div>
                             </div>
                        </div>

                        {/* Action Bar */}
                        <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-800 flex gap-3">
                            <button 
                                onClick={handleDepositClick}
                                className="flex-1 py-2 bg-blue-50 dark:bg-terminal-accent/10 hover:bg-blue-100 dark:hover:bg-terminal-accent/20 border border-blue-200 dark:border-terminal-accent/30 text-blue-600 dark:text-terminal-accent rounded text-xs font-bold transition-all flex items-center justify-center gap-2"
                            >
                                <ArrowDownCircle size={14}/> {chainId === 137 ? 'DEPOSIT USDC' : 'BRIDGE FUNDS'}
                            </button>
                            <button 
                                onClick={handleWithdraw}
                                className="flex-1 py-2 bg-red-50 dark:bg-terminal-danger/10 hover:bg-red-100 dark:hover:bg-terminal-danger/20 border border-red-200 dark:border-terminal-danger/30 text-red-600 dark:text-terminal-danger rounded text-xs font-bold transition-all flex items-center justify-center gap-2"
                            >
                                <ArrowUpCircle size={14}/> TRUSTLESS WITHDRAW
                            </button>
                        </div>
                        
                        {/* Inline Deposit Modal */}
                        {isDepositing && chainId === 137 && (
                            <div className="mt-4 p-3 bg-white dark:bg-black rounded border border-gray-200 dark:border-gray-800 animate-in zoom-in-95 duration-200 flex gap-2 shadow-lg">
                                <input type="number" value={depositAmount} onChange={e => setDepositAmount(e.target.value)} className="flex-1 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded px-3 text-sm text-gray-900 dark:text-white"/>
                                <button onClick={handleDeposit} className="bg-black dark:bg-white text-white dark:text-black text-xs font-bold px-4 rounded hover:opacity-80">CONFIRM</button>
                            </div>
                        )}
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
                                            <span className={`w-1.5 h-1.5 rounded-full ${trade.side === 'BUY' ? 'bg-green-500 dark:bg-terminal-success' : 'bg-red-500 dark:bg-terminal-danger'}`}></span>
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
        
        {/* SYSTEM PAGE */}
        {activeTab === 'system' && systemStats && (
            <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
                <div className="flex items-center gap-4">
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl"><Gauge size={32} className="text-blue-600 dark:text-blue-500"/></div>
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">System Command</h2>
                        <p className="text-gray-500">Global Aggregated Data & Platform Metrics</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                    <div className="glass-panel p-6 rounded-xl border border-blue-100 dark:border-blue-500/20 bg-blue-50 dark:bg-blue-900/10">
                        <h4 className="text-xs font-bold text-blue-600 dark:text-blue-400 uppercase mb-2">Total Volume</h4>
                        <div className="text-3xl font-bold text-gray-900 dark:text-white font-mono">${systemStats.totalVolume.toLocaleString()}</div>
                    </div>
                    <div className="glass-panel p-6 rounded-xl border border-green-100 dark:border-green-500/20 bg-green-50 dark:bg-green-900/10">
                        <h4 className="text-xs font-bold text-green-600 dark:text-green-400 uppercase mb-2">Platform Revenue</h4>
                        <div className="text-3xl font-bold text-gray-900 dark:text-white font-mono">${systemStats.totalRevenue.toFixed(2)}</div>
                        <div className="text-[10px] text-green-600 mt-1">1% Fee Share</div>
                    </div>
                    <div className="glass-panel p-6 rounded-xl border border-purple-100 dark:border-purple-500/20 bg-purple-50 dark:bg-purple-900/10">
                        <h4 className="text-xs font-bold text-purple-600 dark:text-purple-400 uppercase mb-2">Active Bots</h4>
                        <div className="text-3xl font-bold text-gray-900 dark:text-white font-mono">{systemStats.activeBots} / {systemStats.totalUsers}</div>
                    </div>
                    <div className="glass-panel p-6 rounded-xl border border-orange-100 dark:border-orange-500/20 bg-orange-50 dark:bg-orange-900/10">
                        <h4 className="text-xs font-bold text-orange-600 dark:text-orange-400 uppercase mb-2">Total Bridged</h4>
                        <div className="text-3xl font-bold text-gray-900 dark:text-white font-mono">${systemStats.totalBridged.toLocaleString()}</div>
                    </div>
                </div>
            </div>
        )}

        {/* BRIDGE */}
        {activeTab === 'bridge' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
                {/* Bridge Form */}
                <div className="md:col-span-2 glass-panel p-8 rounded-xl border border-gray-200 dark:border-terminal-border">
                    <div className="flex items-center justify-between mb-8">
                        <div className="flex items-center gap-3">
                            <Globe className="text-blue-600 dark:text-terminal-accent" />
                            <h2 className="text-xl font-bold text-gray-900 dark:text-white">Cross-Chain Deposit</h2>
                        </div>
                        <div className="flex gap-2">
                             <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-[10px] text-gray-600 dark:text-gray-400 font-bold flex items-center gap-1">
                                 <Zap size={10} className="text-blue-500"/> Powered by Li.Fi
                             </div>
                             <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-[10px] text-gray-600 dark:text-gray-400 font-bold">0.5% Fee</div>
                        </div>
                    </div>
                    
                    <div className="space-y-6 max-w-lg mx-auto">
                        <div className="p-4 bg-white dark:bg-black/40 rounded-lg border border-gray-200 dark:border-terminal-border shadow-sm dark:shadow-none">
                            <label className="text-xs text-gray-500 uppercase font-bold mb-2 block">From</label>
                            <div className="flex gap-2 mb-4">
                                <select 
                                    className="bg-gray-50 dark:bg-terminal-card border border-gray-200 dark:border-terminal-border text-gray-900 dark:text-white text-sm rounded px-3 py-2 flex-1 outline-none"
                                    value={bridgeFromChain}
                                    onChange={(e) => setBridgeFromChain(Number(e.target.value))}
                                >
                                    <option value={8453}>Base (ETH)</option>
                                    <option value={56}>BNB Chain (BNB)</option>
                                    <option value={42161}>Arbitrum (ETH)</option>
                                    <option value={1}>Ethereum (ETH)</option>
                                    <option value={1151111081099710}>Solana (SOL)</option>
                                </select>
                            </div>
                            <input 
                                type="number" 
                                className="w-full bg-transparent text-2xl font-mono text-gray-900 dark:text-white outline-none"
                                placeholder="0.0"
                                value={bridgeAmount}
                                onChange={(e) => setBridgeAmount(e.target.value)}
                            />
                        </div>

                        <div className="flex justify-center"><ArrowDownCircle className="text-gray-400 dark:text-gray-600" /></div>

                        <div className="p-4 bg-gray-50 dark:bg-black/40 rounded-lg border border-gray-200 dark:border-terminal-border opacity-80 dark:opacity-70">
                            <label className="text-xs text-gray-500 uppercase font-bold mb-2 block">To (Smart Account)</label>
                            <div className="flex justify-between items-center">
                                <div className="flex items-center gap-2">
                                    <div className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center text-[10px] text-white">P</div>
                                    <span className="text-gray-900 dark:text-white font-bold">Polygon</span>
                                </div>
                                <span className="text-gray-900 dark:text-white font-mono">USDC</span>
                            </div>
                        </div>

                        {!bridgeQuote ? (
                            <button onClick={handleGetBridgeQuote} className="w-full py-3 bg-blue-600 dark:bg-terminal-accent hover:bg-blue-700 dark:hover:bg-blue-600 text-white font-bold rounded-lg transition-all shadow-lg">
                                GET QUOTE
                            </button>
                        ) : (
                            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                                {/* Detailed Quote Card */}
                                <div className="p-4 bg-white dark:bg-black/20 border border-blue-200 dark:border-blue-500/30 rounded-lg text-sm space-y-3 shadow-sm relative overflow-hidden">
                                    <div className="absolute top-0 left-0 w-1 h-full bg-blue-500"></div>
                                    <div className="flex justify-between items-center">
                                        <span className="font-bold text-gray-900 dark:text-white">Quote Summary</span>
                                        <span className="text-[10px] bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 px-2 py-0.5 rounded font-bold">BEST RATE</span>
                                    </div>
                                    
                                    <div className="grid grid-cols-2 gap-4 pt-2">
                                        <div>
                                            <span className="text-[10px] text-gray-500 uppercase block">Receive</span>
                                            <span className="font-mono font-bold text-gray-900 dark:text-white text-lg">~{parseFloat(bridgeQuote.toAmountUSD).toFixed(2)} USDC</span>
                                        </div>
                                        <div>
                                            <span className="text-[10px] text-gray-500 uppercase block">Est. Time</span>
                                            <span className="font-mono font-bold text-gray-900 dark:text-white flex items-center gap-1"><Timer size={12}/> ~2 Mins</span>
                                        </div>
                                        <div>
                                            <span className="text-[10px] text-gray-500 uppercase block">Gas Cost</span>
                                            <span className="font-mono font-bold text-gray-700 dark:text-gray-300 flex items-center gap-1"><Fuel size={12}/> ${parseFloat(bridgeQuote.gasCostUSD || '0').toFixed(2)}</span>
                                        </div>
                                        <div>
                                            <span className="text-[10px] text-gray-500 uppercase block">Fee (0.5%)</span>
                                            <span className="font-mono font-bold text-gray-700 dark:text-gray-300">${(parseFloat(bridgeQuote.fromAmountUSD) * 0.005).toFixed(2)}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Action Button or Stepper */}
                                {isBridging ? (
                                    <BridgeStepper status={bridgeStatus} />
                                ) : (
                                    <button onClick={handleExecuteBridge} className="w-full py-3 bg-green-600 dark:bg-terminal-success hover:bg-green-700 dark:hover:bg-green-600 text-white font-bold rounded-lg transition-all flex justify-center gap-2 shadow-lg">
                                        <Zap/> CONFIRM BRIDGE
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

        {/* WALLET (VAULT REBRAND) */}
        {activeTab === 'vault' && (
            <div className="max-w-5xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-300 pb-10">
                <div className="flex items-center gap-4 mb-8 pb-8 border-b border-gray-200 dark:border-terminal-border">
                    <div className="p-3 bg-blue-50 dark:bg-terminal-accent/10 rounded-xl"><Wallet size={32} className="text-blue-600 dark:text-terminal-accent" /></div>
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Smart Wallet Config</h2>
                        <p className="text-gray-500 text-sm">Manage keys, risk profiles, and automation.</p>
                    </div>
                    <div className="ml-auto flex gap-4 items-center">
                         <div className="flex gap-2">
                             <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 text-[10px] text-gray-500 dark:text-gray-400 font-bold">ZeroDev</div>
                             <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 text-[10px] text-gray-500 dark:text-gray-400 font-bold">Gelato</div>
                             <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 text-[10px] text-gray-500 dark:text-gray-400 font-bold">Polygon</div>
                         </div>
                         <button onClick={() => setShowArchitecture(true)} className="text-xs text-blue-600 dark:text-blue-500 hover:text-blue-800 dark:hover:text-white underline">Why is this Secure?</button>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
                    {/* Security Card */}
                    <div className="md:col-span-5 space-y-6">
                         <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-5 space-y-4 shadow-sm dark:shadow-none">
                             <div className="flex justify-between items-center">
                                 <div className="flex items-center gap-2">
                                     <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white bg-purple-600"><Zap size={14}/></div>
                                     <div>
                                         <div className="text-sm font-bold text-gray-900 dark:text-white">Smart Bot</div>
                                         <div className="text-[10px] text-gray-500">Kernel v3.1</div>
                                     </div>
                                 </div>
                                 <div className="text-[10px] font-bold px-2 py-1 rounded border border-purple-500 text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-500/10">ACTIVE</div>
                             </div>
                             <div className="p-3 bg-gray-50 dark:bg-black/40 rounded border border-gray-200 dark:border-gray-800 space-y-2">
                                 <div className="flex justify-between">
                                     <span className="text-xs text-gray-500">Address</span>
                                     <span className="text-xs font-mono text-gray-900 dark:text-white break-all text-right ml-4">{proxyAddress}</span>
                                 </div>
                             </div>
                             <div className="flex justify-between items-center pt-2">
                                 <div className="text-[10px] text-gray-500">{stats?.tradesCount || 0} Total Trades</div>
                                 <button onClick={handleWithdraw} className="px-3 py-1 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-500 text-xs font-bold rounded hover:bg-red-100 dark:hover:bg-red-900/40">Trustless Withdraw</button>
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
                                     onChange={e => setConfig({...config, geminiApiKey: e.target.value})}
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
                                <button onClick={() => { if(targetInput) { setConfig(p => ({...p, targets: [...p.targets, targetInput]})); setTargetInput(''); }}} className="px-4 bg-blue-600 dark:bg-terminal-accent rounded text-white font-bold text-xs">ADD</button>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {config.targets.map(t => (
                                    <span key={t} className="px-3 py-1.5 bg-gray-100 dark:bg-white/5 rounded border border-gray-200 dark:border-white/10 text-xs text-gray-700 dark:text-gray-300 font-mono flex gap-2">
                                        {t.slice(0,6)}...{t.slice(-4)} 
                                        <button onClick={() => setConfig(p => ({...p, targets: p.targets.filter(x => x!==t)}))}><X size={12}/></button>
                                    </span>
                                ))}
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-6">
                            <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-5 shadow-sm dark:shadow-none">
                                <div className="flex items-center justify-between mb-3">
                                    <label className="text-xs text-gray-500 font-bold uppercase">Risk Profile</label>
                                    <Tooltip text="Conservative: Low volatility. Balanced: Standard EV. Degen: High risk/reward." />
                                </div>
                                <div className="space-y-2">
                                    {['conservative', 'balanced', 'degen'].map(mode => (
                                        <button key={mode} onClick={() => setConfig({...config, riskProfile: mode as any})} className={`w-full py-2 px-3 rounded text-xs font-bold uppercase border transition-all flex justify-between ${config.riskProfile === mode ? 'bg-blue-50 dark:bg-terminal-accent/10 border-blue-500 dark:border-terminal-accent text-blue-600 dark:text-terminal-accent' : 'border-gray-200 dark:border-gray-800 text-gray-500'}`}>
                                            {mode} {config.riskProfile === mode && <CheckCircle2 size={12}/>}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="bg-white dark:bg-terminal-card border border-gray-200 dark:border-terminal-border rounded-xl p-5 space-y-5 shadow-sm dark:shadow-none">
                                <div>
                                    <label className="text-xs text-gray-500 font-bold uppercase mb-2 block flex justify-between">Multiplier <span className="text-gray-900 dark:text-white">x{config.multiplier}</span></label>
                                    <input type="number" step="0.1" className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded px-3 py-2 text-sm text-gray-900 dark:text-white font-mono" value={config.multiplier} onChange={e => setConfig({...config, multiplier: Number(e.target.value)})}/>
                                </div>
                                <div>
                                    <label className="text-xs text-gray-500 font-bold uppercase mb-2 block flex justify-between">Auto TP <span className="text-green-600 dark:text-terminal-success">+{config.autoTp}%</span></label>
                                    <input type="range" min="5" max="100" className="w-full accent-green-600 dark:accent-terminal-success h-1 bg-gray-200 dark:bg-gray-800 rounded-lg appearance-none cursor-pointer" value={config.autoTp} onChange={e => setConfig({...config, autoTp: Number(e.target.value)})}/>
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
                                        onChange={e => setConfig({...config, enableAutoCashout: e.target.checked})}
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
                                                    onChange={e => setConfig({...config, maxRetentionAmount: Number(e.target.value)})}
                                                />
                                            </div>
                                            <div>
                                                <label className="text-[10px] text-gray-500 uppercase font-bold block mb-1">Dest. Address</label>
                                                <input 
                                                    type="text"
                                                    className="w-full bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-terminal-border rounded px-2 py-1.5 text-xs text-gray-900 dark:text-white"
                                                    placeholder="0x..."
                                                    value={config.coldWalletAddress}
                                                    onChange={e => setConfig({...config, coldWalletAddress: e.target.value})}
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
                                        onChange={e => setConfig({...config, enableNotifications: e.target.checked})}
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
                                                onChange={e => setConfig({...config, userPhoneNumber: e.target.value})}
                                            />
                                        </div>
                                    )}
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
                            Discover high-performing wallets. Copy them to earn profit. List them to <span className="text-gray-900 dark:text-white font-bold">earn 1%</span> fees on every copy.
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
                                    <tr key={trader.address} className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors group">
                                        <td className="p-4 pl-6">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-300 to-gray-200 dark:from-gray-800 dark:to-gray-700 flex items-center justify-center text-xs font-bold text-gray-700 dark:text-white border border-gray-200 dark:border-gray-700">
                                                    {trader.address.slice(2,4)}
                                                </div>
                                                <div>
                                                    <div className="text-gray-900 dark:text-white font-bold flex items-center gap-1">
                                                        {trader.ens || `${trader.address.slice(0,6)}...${trader.address.slice(-4)}`}
                                                        {trader.isVerified && <CheckCircle2 size={12} className="text-green-500"/>}
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="p-4 text-center text-green-600 dark:text-green-400 font-bold">{trader.winRate}%</td>
                                        <td className="p-4 text-center text-blue-600 dark:text-blue-400 font-bold">${trader.totalPnl.toLocaleString()}</td>
                                        <td className="p-4 text-center text-gray-500">{trader.copyCount || 0}</td>
                                        <td className="p-4 text-right pr-6">
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
                                        <span className={`px-2 py-0.5 rounded font-bold ${tx.side === 'BUY' ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-500' : 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-500'}`}>
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
            <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Help & Support</h2>
                <div className="space-y-4">
                    <div className="glass-panel p-6 rounded-xl border border-gray-200 dark:border-terminal-border">
                        <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">How do I fund my bot?</h3>
                        <p className="text-gray-500 dark:text-gray-400 text-sm">Go to the <strong>Bridge</strong> tab. You can deposit ETH, BNB, or SOL from other chains directly into your Polygon Smart Account. The system handles the swapping and bridging automatically.</p>
                    </div>
                    <div className="glass-panel p-6 rounded-xl border border-gray-200 dark:border-terminal-border">
                        <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Is my money safe?</h3>
                        <p className="text-gray-500 dark:text-gray-400 text-sm">Yes. We use <strong>Account Abstraction</strong>. The bot server only has permission to place trades. It physically cannot sign a withdrawal transaction. Only your main wallet can withdraw funds.</p>
                    </div>
                    <div className="glass-panel p-6 rounded-xl border border-gray-200 dark:border-terminal-border">
                        <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">How does the 1% Fee work?</h3>
                        <p className="text-gray-500 dark:text-gray-400 text-sm">When you copy a profitable trade, 1% of the net profit is automatically sent to the wallet that you copied (if they are registered). This incentivizes the best traders to list themselves.</p>
                    </div>
                </div>
            </div>
        )}

      </main>
      
      <FeedbackWidget userId={userAddress} />
      
      {/* Landing View Helper */}
      {!isConnected && <Landing onConnect={handleConnect} theme={theme} toggleTheme={toggleTheme} />}
    </div>
  );
};

const SmartLogo = ({ src, fallbackText, className }: { src: string, fallbackText: string, className?: string }) => {
    const [error, setError] = useState(false);
    
    if(error) {
        return (
            <div className={`flex items-center justify-center text-white font-bold text-xl border border-white/10 ${className}`}>
                {fallbackText}
            </div>
        )
    }
    
    return (
        <img 
            src={src} 
            onError={() => setError(true)} 
            className={`object-cover ${className}`} 
            alt={fallbackText}
        />
    )
}

// --- HERO BACKGROUND (PROFESSIONAL) ---
const HeroBackground = () => {
  return (
    <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
       {/* Clean Grid Pattern */}
       <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-soft-light"></div>
       <div className="absolute inset-0 bg-grid-slate-200/[0.04] bg-[bottom_1px_center] dark:bg-grid-slate-800/[0.05]" style={{ backgroundSize: '40px 40px', maskImage: 'linear-gradient(to bottom, transparent, black)' }}></div>
    </div>
  )
}

const Landing = ({ onConnect, theme, toggleTheme }: { onConnect: () => void, theme: string, toggleTheme: () => void }) => (
    <div className="min-h-[100dvh] bg-gray-50 dark:bg-[#050505] font-sans transition-colors duration-300 flex flex-col relative overflow-x-hidden">
        
        <HeroBackground />

        {/* Floating Header */}
        <div className="absolute top-0 left-0 w-full p-6 flex justify-between items-center z-50 max-w-7xl mx-auto left-0 right-0">
             <div className="flex items-center gap-2 opacity-80">
                 <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20">
                    <Activity size={18} className="text-white"/>
                 </div>
                 <span className="font-bold text-sm text-gray-900 dark:text-white tracking-widest">BET MIRROR</span>
             </div>
             <button 
                onClick={toggleTheme} 
                className="p-3 bg-white/80 dark:bg-white/5 rounded-full hover:scale-110 transition-all shadow-sm backdrop-blur-md text-gray-600 dark:text-white border border-gray-200 dark:border-white/10"
             >
                {theme === 'light' ? <Moon size={18}/> : <Sun size={18}/>}
             </button>
        </div>

        <div className="flex-1 flex flex-col items-center pt-48 pb-16 px-6 z-10 w-full max-w-7xl mx-auto">
            
            {/* Header / Branding */}
            <div className="text-center space-y-8 max-w-4xl w-full animate-in fade-in slide-in-from-bottom-8 duration-700">
                
                {/* Main Title */}
                <div className="space-y-4">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/50 text-blue-600 dark:text-blue-400 text-[10px] font-bold uppercase tracking-widest mb-4">
                        <Zap size={10}/> Account Abstraction V2 Live
                    </div>
                    <h1 className="text-5xl md:text-7xl font-black tracking-tighter text-gray-900 dark:text-white mb-6 drop-shadow-sm leading-tight">
                        <span className="text-blue-600">BET</span> MIRROR
                    </h1>
                    <p className="text-lg md:text-2xl text-gray-500 dark:text-gray-400 font-normal max-w-2xl mx-auto leading-relaxed">
                        The institutional-grade prediction market terminal. <br/>
                        <span className="text-gray-900 dark:text-gray-200 font-medium">Non-Custodial. AI-Powered. 24/7 Cloud Execution.</span>
                    </p>
                </div>

                {/* CTA */}
                <div className="max-w-sm mx-auto w-full pt-12">
                    <button 
                        onClick={onConnect} 
                        className="group relative w-full py-4 bg-gray-900 dark:bg-white text-white dark:text-black font-bold text-lg rounded-xl shadow-xl shadow-blue-500/10 hover:shadow-blue-500/20 hover:-translate-y-1 transition-all duration-300"
                    >
                        <span className="relative flex items-center justify-center gap-3">
                            Connect Terminal <ArrowRightLeft size={18} className="opacity-50"/>
                        </span>
                    </button>
                    <div className="flex justify-center gap-8 mt-8 text-[10px] uppercase tracking-widest font-bold text-gray-400">
                        <span className="flex items-center gap-2"><Shield size={12}/> Audited</span>
                        <span className="flex items-center gap-2"><Zap size={12}/> Gasless</span>
                        <span className="flex items-center gap-2"><Globe size={12}/> Global</span>
                    </div>
                </div>

                {/* Divider */}
                <div className="w-full max-w-xs mx-auto h-px bg-gradient-to-r from-transparent via-gray-200 dark:via-gray-800 to-transparent my-32"></div>

                {/* Supported Chains - Logos */}
                <div className="space-y-10">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-[0.2em]">
                        POWERED BY
                    </p>
                    <div className="flex flex-wrap justify-center items-center gap-16 md:gap-20 opacity-60 grayscale hover:grayscale-0 transition-all duration-500">
                        <img src="https://cryptologos.cc/logos/polygon-matic-logo.svg?v=026" alt="Polygon" className="h-6 w-auto hover:scale-110 transition-transform" referrerPolicy="no-referrer" />
                        <img src="https://cryptologos.cc/logos/ethereum-eth-logo.svg?v=026" alt="Ethereum" className="h-6 w-auto hover:scale-110 transition-transform" referrerPolicy="no-referrer" />
                        <img src="https://cryptologos.cc/logos/base-base-logo.svg?v=026" alt="Base" className="h-6 w-auto hover:scale-110 transition-transform" referrerPolicy="no-referrer" />
                        <img src="https://cryptologos.cc/logos/arbitrum-arb-logo.svg?v=026" alt="Arbitrum" className="h-6 w-auto hover:scale-110 transition-transform" referrerPolicy="no-referrer" />
                        <img src="https://cryptologos.cc/logos/solana-sol-logo.svg?v=026" alt="Solana" className="h-5 w-auto hover:scale-110 transition-transform" referrerPolicy="no-referrer" />
                    </div>
                </div>

                {/* Markets Status Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto pt-32 text-left w-full">
                    
                    {/* Active Market Card */}
                    <div className="p-8 rounded-3xl bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-white/10 shadow-sm hover:shadow-md transition-all duration-300 group hover:-translate-y-1">
                        <div className="flex items-center gap-3 mb-6">
                            <span className="relative flex h-2.5 w-2.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
                            </span>
                            <span className="text-[10px] font-bold text-green-600 dark:text-green-400 uppercase tracking-wider">Live Integration</span>
                        </div>
                        <div className="flex items-center gap-4 mb-6">
                            <img src="https://assets.polymarket.com/static/logo-round.svg" alt="Polymarket" className="w-12 h-12 rounded-full" referrerPolicy="no-referrer" onError={(e) => e.currentTarget.src = 'https://cryptologos.cc/logos/polygon-matic-logo.svg?v=026'}/>
                            <h3 className="text-2xl font-bold text-gray-900 dark:text-white">Polymarket</h3>
                        </div>
                        <p className="text-sm text-gray-500 dark:text-gray-400 font-medium leading-relaxed">
                            The world's largest prediction market. Copy trade politics, sports, and crypto events with institutional speed.
                        </p>
                    </div>

                    {/* Coming Soon Card */}
                    <div className="p-8 rounded-3xl bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/5 opacity-70 hover:opacity-100 transition-all duration-300 group">
                        <div className="flex items-center gap-3 mb-6">
                            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500"></span>
                            <span className="text-[10px] font-bold text-yellow-600 dark:text-yellow-500 uppercase tracking-wider">Coming Soon</span>
                        </div>
                        <div className="flex items-center gap-4 mb-6">
                             <div className="w-12 h-12 rounded-full bg-gray-200 dark:bg-gray-800 flex items-center justify-center font-bold text-gray-500 text-xl">pb</div>
                            <h3 className="text-2xl font-bold text-gray-900 dark:text-white">PredictBase</h3>
                        </div>
                        <p className="text-sm text-gray-500 dark:text-gray-400 font-medium leading-relaxed">
                            Next-generation sports & crypto markets with high-frequency liquidity and low fees.
                        </p>
                    </div>

                </div>

                {/* Suggestion Input */}
                <div className="pt-16 pb-24">
                    <div className="inline-flex flex-col items-center gap-3 group cursor-pointer opacity-60 hover:opacity-100 transition-opacity">
                        <div className="p-3 rounded-full bg-white dark:bg-white/10 border border-gray-200 dark:border-white/10 text-gray-400 group-hover:text-blue-500 group-hover:border-blue-200 transition-all">
                            <MousePointerClick size={20} />
                        </div>
                        <p className="text-xs font-bold text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors uppercase tracking-widest">
                            Suggest a market integration
                        </p>
                    </div>
                </div>

            </div>
            
            <div className="animate-bounce opacity-20 mt-12">
                <ChevronDown className="text-gray-400 w-8 h-8"/>
            </div>

            {/* --- HOW IT WORKS SECTION --- */}
            <div className="w-full max-w-6xl mx-auto mt-32 pb-32">
                <div className="text-center mb-20">
                    <span className="text-blue-600 dark:text-blue-500 text-xs font-bold uppercase tracking-widest">Architecture</span>
                    <h2 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-white mt-4">How It Works</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-8 px-4">
                    {/* Step 1 */}
                    <div className="p-10 bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-white/10 rounded-3xl hover:border-blue-500/30 transition-all shadow-sm group">
                        <div className="w-14 h-14 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-2xl flex items-center justify-center mb-8 group-hover:scale-110 transition-transform">
                            <Wallet size={28}/>
                        </div>
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">1. Connect & Deploy</h3>
                        <p className="text-gray-500 text-sm leading-relaxed">
                            Link your wallet. We instantly deploy a non-custodial <strong>Smart Account</strong> (ZeroDev Kernel) on Polygon.
                        </p>
                    </div>

                    {/* Step 2 */}
                    <div className="p-10 bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-white/10 rounded-3xl hover:border-purple-500/30 transition-all shadow-sm group">
                        <div className="w-14 h-14 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 rounded-2xl flex items-center justify-center mb-8 group-hover:scale-110 transition-transform">
                            <Key size={28}/>
                        </div>
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">2. Grant Permission</h3>
                        <p className="text-gray-500 text-sm leading-relaxed">
                            Sign a restricted <strong>Session Key</strong>. This grants our cloud server permission to <em>execute trades only</em>.
                        </p>
                    </div>

                    {/* Step 3 */}
                    <div className="p-10 bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-white/10 rounded-3xl hover:border-green-500/30 transition-all shadow-sm group">
                        <div className="w-14 h-14 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 rounded-2xl flex items-center justify-center mb-8 group-hover:scale-110 transition-transform">
                            <Server size={28}/>
                        </div>
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">3. Cloud Execution</h3>
                        <p className="text-gray-500 text-sm leading-relaxed">
                            Our Node.js engine monitors the blockchain 24/7, uses <strong>Gemini AI</strong> to analyze risk, and executes copy-trades.
                        </p>
                    </div>
                </div>
            </div>

        </div>
    </div>
);

const root = createRoot(document.getElementById('root')!);
root.render(<App />);