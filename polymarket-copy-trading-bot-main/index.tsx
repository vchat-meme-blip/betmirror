import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Shield, Play, Square, Activity, Settings, Wallet, Key, 
  Terminal, Trash2, Eye, EyeOff, Save, Lock, Users, Trophy, 
  TrendingUp, History, AlertCircle, CheckCircle2, Copy, ExternalLink,
  Smartphone, ArrowRightCircle, Coins, PlusCircle, Brain, RefreshCw, Server
} from 'lucide-react';
import { createPolymarketClient } from './src/infrastructure/clob-client.factory';
import { TradeMonitorService } from './src/services/trade-monitor.service';
import { TradeExecutorService } from './src/services/trade-executor.service';
import { aiAgent, RiskProfile } from './src/services/ai-agent.service';
import { alphaRegistry } from './src/services/alpha-registry.service';
import { TraderProfile } from './src/domain/alpha.types';
import { TradeSignal } from './src/domain/trade.types';

// --- Types ---
interface Log {
  id: string;
  time: string;
  type: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

interface TradeRecord extends TradeSignal {
  id: string;
  status: 'EXECUTED' | 'SKIPPED' | 'TP_HIT';
  pnl?: number;
  txHash?: string;
  aiReasoning?: string;
  riskScore?: number;
}

interface AppConfig {
  userAddresses: string;
  privateKey: string;
  rpcUrl: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  multiplier: number;
  useAi: boolean;
  riskProfile: RiskProfile;
  takeProfitPercent: number;
  // Automation
  mainWalletAddress: string;
  maxRetentionAmount: number;
  enableAutoCashout: boolean;
  // Admin / Revenue
  adminRevenueWallet: string; // If user is admin, they set this
  // Notifications
  enableNotifications: boolean;
  userPhoneNumber: string;
  twilioSid: string;
  twilioToken: string;
  twilioFrom: string;
  registryUrl: string; 
}

const STORAGE_KEY = 'bet_mirror_config_v2.6_pro';

// --- Logger Adapter ---
class UILogger {
  constructor(private addLog: (l: Log) => void) {}
  
  private log(type: Log['type'], msg: string, err?: Error) {
    const message = err ? `${msg} ${err.message}` : msg;
    this.addLog({
      id: Math.random().toString(36),
      time: new Date().toLocaleTimeString(),
      type,
      message
    });
  }

  info(msg: string) { this.log('info', msg); }
  warn(msg: string) { this.log('warn', msg); }
  error(msg: string, err?: Error) { this.log('error', msg, err); }
  debug(msg: string) { /* ignore debug in UI */ }
}

const App = () => {
  // State
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const [tradeHistory, setTradeHistory] = useState<TradeRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'marketplace' | 'history' | 'vault'>('dashboard');
  const [showSecrets, setShowSecrets] = useState(false);
  const [communityWallets, setCommunityWallets] = useState<TraderProfile[]>([]);
  
  // Marketplace State
  const [newWalletInput, setNewWalletInput] = useState('');
  const [myFinderAddress, setMyFinderAddress] = useState(''); 
  const [isAddingWallet, setIsAddingWallet] = useState(false);
  
  const [config, setConfig] = useState<AppConfig>({
    userAddresses: '',
    privateKey: '',
    rpcUrl: 'https://polygon-rpc.com',
    apiKey: '',
    apiSecret: '',
    apiPassphrase: '',
    multiplier: 1.0,
    useAi: false,
    riskProfile: 'balanced',
    takeProfitPercent: 20, 
    mainWalletAddress: '',
    maxRetentionAmount: 1000,
    enableAutoCashout: false,
    adminRevenueWallet: '0xAdmin... (Default)',
    enableNotifications: false,
    userPhoneNumber: '',
    twilioSid: '',
    twilioToken: '',
    twilioFrom: '',
    registryUrl: 'http://localhost:3000/api'
  });

  // Refs
  const monitorRef = useRef<TradeMonitorService | null>(null);
  const executorRef = useRef<TradeExecutorService | null>(null);

  // Helper functions
  const addLog = (log: Log) => {
    setLogs(prev => [log, ...prev].slice(0, 200));
  };

  const addTradeRecord = (record: TradeRecord) => {
    setTradeHistory(prev => [record, ...prev]);
  };

  // Load Config
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setConfig(prev => ({ ...prev, ...parsed }));
        if(parsed.registryUrl) alphaRegistry.setApiUrl(parsed.registryUrl);
      } catch (e) {
        console.error('Failed to load config', e);
      }
    }
    loadRegistry();
  }, []);

  const loadRegistry = async () => {
    try {
        const list = await alphaRegistry.getRegistry();
        setCommunityWallets(list);
        addLog({ id: 'reg', time: new Date().toLocaleTimeString(), type: 'info', message: `Connected to Registry: ${list.length} wallets loaded.` });
    } catch (e) {
        addLog({ id: 'err', time: new Date().toLocaleTimeString(), type: 'error', message: 'Registry Offline. Is the server running?' });
    }
  };

  const saveConfig = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    if(config.registryUrl) alphaRegistry.setApiUrl(config.registryUrl);
    addLog({ id: 'save', time: new Date().toLocaleTimeString(), type: 'success', message: 'Configuration Saved Securely.' });
  };

  const clearLogs = () => setLogs([]);

  // --- Marketplace Logic ---
  const handleAddWallet = async () => {
    if(!newWalletInput.startsWith('0x') || newWalletInput.length < 40) {
        addLog({ id: 'err', time: new Date().toLocaleTimeString(), type: 'error', message: 'Invalid Wallet Address format' });
        return;
    }
    
    setIsAddingWallet(true);
    const finder = myFinderAddress || config.privateKey ? '0xME' : '0xAnonymous';

    // REAL ASYNC CALL
    const result = await alphaRegistry.addWallet(newWalletInput, finder);
    
    if (result.success && result.profile) {
        setCommunityWallets(prev => [result.profile!, ...prev]);
        setNewWalletInput('');
        addLog({ id: 'wl', time: new Date().toLocaleTimeString(), type: 'success', message: `Alpha Listed! You earn 1% from copies.` });
    } else {
        addLog({ id: 'err', time: new Date().toLocaleTimeString(), type: 'warn', message: result.message });
    }
    setIsAddingWallet(false);
  };

  // --- Core Engine Logic ---
  const handleStart = async () => {
    if (!config.privateKey || !config.userAddresses) {
      addLog({ id: 'err', time: new Date().toLocaleTimeString(), type: 'error', message: 'Vault Configuration Incomplete' });
      setActiveTab('vault');
      return;
    }

    try {
      setIsRunning(true);
      addLog({ id: 'init', time: new Date().toLocaleTimeString(), type: 'info', message: 'Initializing Bet Mirror Engine...' });

      // Init AI
      if (config.useAi) {
        addLog({ id: 'ai', time: new Date().toLocaleTimeString(), type: 'info', message: `Risk Agent: ${config.riskProfile.toUpperCase()}` });
      }

      const logger = new UILogger(addLog);
      const client = await createPolymarketClient({
        rpcUrl: config.rpcUrl,
        privateKey: config.privateKey,
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        apiPassphrase: config.apiPassphrase
      });

      logger.info(`Proxy Wallet Connected: ${client.wallet.address.slice(0,6)}...${client.wallet.address.slice(-4)}`);

      const executor = new TradeExecutorService({
        client,
        proxyWallet: client.wallet.address,
        env: {
            tradeMultiplier: config.multiplier,
            usdcContractAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
            adminRevenueWallet: config.adminRevenueWallet,
            registryApiUrl: config.registryUrl // Pass the real URL
        } as any,
        logger
      });

      const monitor = new TradeMonitorService({
        client,
        logger,
        env: { ...config, fetchIntervalSeconds: 3, aggregationWindowSeconds: 300 } as any,
        userAddresses: config.userAddresses.split(',').map(s => s.trim()),
        onDetectedTrade: async (signal) => {
          let aiReasoning = 'AI Disabled';
          let shouldExecute = true;
          let riskScore = 0;

          // AI Analysis
          if (config.useAi) {
            logger.info(`🤖 Agent analyzing...`);
            const analysis = await aiAgent.analyzeTrade(
              `Market: ${signal.marketId}`, 
              signal.side, 
              signal.outcome, 
              signal.sizeUsd, 
              signal.price,
              config.riskProfile
            );
            
            aiReasoning = analysis.reasoning;
            shouldExecute = analysis.shouldCopy;
            riskScore = analysis.riskScore;
            
            if (!shouldExecute) logger.warn(`🛑 Blocked by Agent: ${analysis.reasoning}`);
          }

          if (shouldExecute) {
             await executor.copyTrade(signal);
             addTradeRecord({ ...signal, id: Math.random().toString(36), status: 'EXECUTED', aiReasoning, riskScore });
          } else {
             addTradeRecord({ ...signal, id: Math.random().toString(36), status: 'SKIPPED', aiReasoning, riskScore });
          }
        }
      });

      monitorRef.current = monitor;
      executorRef.current = executor;

      await monitor.start();

    } catch (e: any) {
      setIsRunning(false);
      addLog({ id: 'fatal', time: new Date().toLocaleTimeString(), type: 'error', message: e.message });
    }
  };

  const handleStop = () => {
    if (monitorRef.current) monitorRef.current.stop();
    setIsRunning(false);
    addLog({ id: 'stop', time: new Date().toLocaleTimeString(), type: 'info', message: 'Engine Stopped.' });
  };

  const copyWallet = (address: string) => {
      const current = config.userAddresses ? config.userAddresses.split(',').map(s=>s.trim()) : [];
      if(!current.includes(address)) {
          const newVal = current.length > 0 && current[0] !== '' ? `${config.userAddresses},${address}` : address;
          setConfig({...config, userAddresses: newVal});
          addLog({ id: 'cp', time: new Date().toLocaleTimeString(), type: 'success', message: `Added ${address.slice(0,6)}... to copy list` });
      }
  };

  return (
    <div className="min-h-screen bg-terminal-bg text-gray-300 font-sans selection:bg-terminal-accent/30 selection:text-white flex flex-col">
      
      {/* --- HEADER --- */}
      <header className="h-16 border-b border-terminal-border bg-terminal-card/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-full flex items-center justify-between">
            {/* Logo */}
            <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-[0_0_15px_rgba(59,130,246,0.5)]">
                    <Activity className="text-white" size={18} />
                </div>
                <div>
                    <h1 className="font-bold text-white tracking-tight leading-none">BET MIRROR</h1>
                    <span className="text-[10px] text-terminal-accent font-mono tracking-widest uppercase">PRO TERMINAL v2.6</span>
                </div>
            </div>

            {/* Nav */}
            <nav className="hidden md:flex items-center gap-1 bg-terminal-card border border-terminal-border rounded-lg p-1">
                {['dashboard', 'marketplace', 'history', 'vault'].map((tab) => (
                    <button 
                        key={tab}
                        onClick={() => setActiveTab(tab as any)}
                        className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-2 ${
                            activeTab === tab 
                            ? 'bg-terminal-border text-white shadow-sm' 
                            : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                        }`}
                    >
                        {tab === 'dashboard' && <Activity size={14} />}
                        {tab === 'marketplace' && <Users size={14} />}
                        {tab === 'history' && <History size={14} />}
                        {tab === 'vault' && <Wallet size={14} />}
                        <span className="capitalize">{tab}</span>
                    </button>
                ))}
            </nav>

            {/* Actions */}
            <div className="flex items-center gap-4">
                 {/* Connection Status Indicator */}
                 <div className="hidden md:flex flex-col items-end mr-2">
                    <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full status-dot ${isRunning ? 'bg-terminal-success text-terminal-success' : 'bg-gray-600 text-gray-600'}`}></div>
                        <span className="text-[10px] font-mono font-bold text-gray-400">{isRunning ? 'ENGINE ONLINE' : 'STANDBY'}</span>
                    </div>
                    <span className="text-[10px] text-gray-600 font-mono">Polygon Mainnet</span>
                 </div>

                {isRunning ? (
                    <button onClick={handleStop} className="h-9 px-4 bg-terminal-danger/10 hover:bg-terminal-danger/20 text-terminal-danger border border-terminal-danger/50 rounded flex items-center gap-2 text-xs font-bold transition-all">
                        <Square size={14} fill="currentColor" /> STOP
                    </button>
                ) : (
                    <button onClick={handleStart} className="h-9 px-4 bg-terminal-accent hover:bg-blue-600 text-white rounded flex items-center gap-2 text-xs font-bold transition-all shadow-[0_0_15px_rgba(59,130,246,0.3)] hover:shadow-[0_0_20px_rgba(59,130,246,0.5)]">
                        <Play size={14} fill="currentColor" /> START ENGINE
                    </button>
                )}
            </div>
        </div>
      </header>

      {/* --- MAIN CONTENT --- */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 overflow-hidden">
        
        {/* VIEW: DASHBOARD */}
        {activeTab === 'dashboard' && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6 h-full">
                {/* Left Panel: Logs & Terminal */}
                <div className="col-span-12 md:col-span-8 flex flex-col gap-6">
                    {/* Metrics Row */}
                    <div className="grid grid-cols-3 gap-4">
                        <div className="glass-panel p-4 rounded-xl">
                            <div className="flex justify-between items-start mb-2">
                                <span className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Proxy Wallet</span>
                                {config.privateKey ? <CheckCircle2 size={14} className="text-terminal-success" /> : <AlertCircle size={14} className="text-terminal-warn" />}
                            </div>
                            <div className="font-mono text-lg text-white truncate">
                                {config.privateKey ? '0x••••••••' : 'Not Configured'}
                            </div>
                        </div>
                        <div className="glass-panel p-4 rounded-xl">
                            <div className="flex justify-between items-start mb-2">
                                <span className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Targets</span>
                                <Users size={14} className="text-terminal-accent" />
                            </div>
                            <div className="font-mono text-lg text-white">
                                {config.userAddresses.split(',').filter(Boolean).length} <span className="text-xs text-gray-600">Active</span>
                            </div>
                        </div>
                        <div className="glass-panel p-4 rounded-xl">
                            <div className="flex justify-between items-start mb-2">
                                <span className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">AI Agent</span>
                                <Brain size={14} className={config.useAi ? "text-purple-400" : "text-gray-700"} />
                            </div>
                            <div className="font-mono text-lg text-white">
                                {config.useAi ? 'Active' : 'Offline'}
                            </div>
                        </div>
                    </div>

                    {/* Console */}
                    <div className="flex-1 glass-panel rounded-xl overflow-hidden flex flex-col min-h-[400px]">
                        <div className="px-4 py-2 border-b border-terminal-border bg-terminal-card/80 flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <Terminal size={14} className="text-gray-400" />
                                <span className="text-xs font-mono font-bold text-gray-400">SYSTEM_LOGS</span>
                            </div>
                            <button onClick={clearLogs} className="text-gray-600 hover:text-white transition-colors">
                                <Trash2 size={12} />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1 bg-[#050505]">
                             {logs.length === 0 && (
                                <div className="h-full flex flex-col items-center justify-center text-gray-700 gap-2">
                                    <Terminal size={32} />
                                    <span>System Ready. Waiting for commands...</span>
                                </div>
                             )}
                             {logs.map((log) => (
                                <div key={log.id} className="flex gap-3 hover:bg-white/5 p-0.5 rounded animate-in fade-in duration-200">
                                    <span className="text-gray-600 shrink-0 select-none">[{log.time}]</span>
                                    <span className={`break-all ${
                                        log.type === 'error' ? 'text-terminal-danger' : 
                                        log.type === 'warn' ? 'text-terminal-warn' : 
                                        log.type === 'success' ? 'text-terminal-success' : 'text-blue-200'
                                    }`}>
                                        {log.type === 'info' && <span className="text-gray-500 mr-2">INFO</span>}
                                        {log.type === 'success' && <span className="text-terminal-success mr-2">Qw</span>}
                                        {log.message}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Right Panel: Strategy & Config Preview */}
                <div className="col-span-12 md:col-span-4 flex flex-col gap-6">
                    <div className="glass-panel p-5 rounded-xl space-y-6">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-bold text-white flex items-center gap-2">
                                <Settings size={16} className="text-terminal-accent" /> Strategy Config
                            </h3>
                            <button onClick={() => setActiveTab('vault')} className="text-[10px] text-terminal-accent hover:underline">EDIT</button>
                        </div>
                        
                        <div className="space-y-4">
                            <div className="flex items-center justify-between text-xs p-2 bg-white/5 rounded border border-white/5">
                                <span className="text-gray-400">Mode</span>
                                <span className={`font-mono font-bold uppercase ${
                                    config.riskProfile === 'conservative' ? 'text-terminal-success' : 
                                    config.riskProfile === 'degen' ? 'text-terminal-danger' : 'text-terminal-accent'
                                }`}>{config.riskProfile}</span>
                            </div>
                            
                            <div className="flex items-center justify-between text-xs p-2 bg-white/5 rounded border border-white/5">
                                <span className="text-gray-400">Multiplier</span>
                                <span className="font-mono font-bold text-white">x{config.multiplier}</span>
                            </div>

                            <div className="flex items-center justify-between text-xs p-2 bg-white/5 rounded border border-white/5">
                                <span className="text-gray-400">Auto TP</span>
                                <span className="font-mono font-bold text-terminal-success">+{config.takeProfitPercent}%</span>
                            </div>

                            <div className="flex items-center justify-between text-xs p-2 bg-white/5 rounded border border-white/5">
                                <span className="text-gray-400">Cashout Cap</span>
                                <span className="font-mono font-bold text-white">${config.maxRetentionAmount}</span>
                            </div>
                        </div>

                        <div className="pt-4 border-t border-terminal-border">
                            <h4 className="text-[10px] font-bold text-gray-500 uppercase mb-3">Recent Signals</h4>
                            <div className="space-y-2">
                                {tradeHistory.slice(0, 3).map(trade => (
                                    <div key={trade.id} className="text-xs flex items-center justify-between p-2 bg-black/40 rounded border border-white/5">
                                        <div className="flex items-center gap-2">
                                            <span className={`w-1.5 h-1.5 rounded-full ${trade.side === 'BUY' ? 'bg-terminal-success' : 'bg-terminal-danger'}`}></span>
                                            <span className="font-mono text-gray-300">{trade.side}</span>
                                        </div>
                                        <span className="text-gray-500 text-[10px]">{trade.outcome}</span>
                                        <span className="font-mono text-white">${trade.sizeUsd}</span>
                                    </div>
                                ))}
                                {tradeHistory.length === 0 && (
                                    <div className="text-[10px] text-gray-600 text-center py-4 italic">No signals yet</div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {/* VIEW: ALPHA MARKETPLACE */}
        {activeTab === 'marketplace' && (
            <div className="h-full flex flex-col gap-6 animate-in fade-in slide-in-from-right-4 duration-300">
                {/* Hero Banner */}
                <div className="relative glass-panel rounded-xl p-8 overflow-hidden">
                    <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                        <Users size={200} />
                    </div>
                    <div className="relative z-10 max-w-2xl">
                        <h2 className="text-2xl font-bold text-white mb-2 flex items-center gap-3">
                            Alpha Registry <span className="text-xs bg-terminal-accent text-white px-2 py-0.5 rounded font-mono">GLOBAL</span>
                        </h2>
                        <p className="text-gray-400 text-sm mb-6 leading-relaxed">
                            A decentralized ledger of high-performance wallets. Add a wallet to the registry and 
                            <span className="text-white font-bold"> earn 1% </span> of every profitable trade executed by users copying it.
                        </p>
                        
                        <div className="flex gap-2">
                             <div className="flex-1 bg-black/50 border border-terminal-border rounded-lg flex items-center px-3 focus-within:border-terminal-accent transition-colors">
                                <Smartphone size={16} className="text-gray-500 mr-2" />
                                <input 
                                    type="text" 
                                    placeholder="Enter High Win-Rate Wallet Address (0x...)"
                                    className="bg-transparent border-none outline-none text-sm font-mono text-white w-full py-2 placeholder:text-gray-700"
                                    value={newWalletInput}
                                    onChange={(e) => setNewWalletInput(e.target.value)}
                                />
                             </div>
                             <button 
                                onClick={handleAddWallet}
                                disabled={isAddingWallet}
                                className="px-6 bg-terminal-accent hover:bg-blue-600 disabled:opacity-50 text-white font-bold rounded-lg text-sm flex items-center gap-2 transition-all"
                            >
                                {isAddingWallet ? <RefreshCw size={16} className="animate-spin" /> : <PlusCircle size={16} />}
                                Add & Earn
                            </button>
                        </div>
                    </div>
                </div>

                {/* Registry Table */}
                <div className="glass-panel rounded-xl overflow-hidden flex-1 border border-terminal-border">
                    <div className="p-4 border-b border-terminal-border bg-terminal-card/50 flex justify-between items-center">
                        <h3 className="font-bold text-gray-300 text-sm flex items-center gap-2">
                            <Server size={14} /> Live Registry
                        </h3>
                        <button onClick={loadRegistry} className="text-xs text-terminal-accent hover:underline flex items-center gap-1">
                            <RefreshCw size={12} /> Refresh
                        </button>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-black/40 text-gray-500 text-[10px] uppercase font-bold tracking-wider">
                                <tr>
                                    <th className="p-4">Rank</th>
                                    <th className="p-4">Trader Identity</th>
                                    <th className="p-4 text-right">Win Rate</th>
                                    <th className="p-4 text-right">30d PnL</th>
                                    <th className="p-4 text-right">Finder (Earns Fee)</th>
                                    <th className="p-4 text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5 font-mono">
                                {communityWallets.map((trader, idx) => (
                                    <tr key={idx} className="hover:bg-white/5 transition-colors group">
                                        <td className="p-4 text-gray-600">#{idx + 1}</td>
                                        <td className="p-4">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-gray-800 to-gray-700 flex items-center justify-center text-xs font-bold text-white border border-white/10">
                                                    {trader.address.slice(2,4)}
                                                </div>
                                                <div>
                                                    <div className="font-bold text-white flex items-center gap-1">
                                                        {trader.ens || `${trader.address.slice(0,6)}...${trader.address.slice(-4)}`}
                                                        {trader.isVerified && <CheckCircle2 size={12} className="text-terminal-accent" />}
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="p-4 text-right text-terminal-success">{trader.winRate}%</td>
                                        <td className="p-4 text-right text-white">${trader.totalPnl.toLocaleString()}</td>
                                        <td className="p-4 text-right text-xs text-purple-400 group-hover:text-purple-300">
                                            {trader.listedBy.slice(0,6)}...
                                        </td>
                                        <td className="p-4 text-right">
                                            <button 
                                                onClick={() => copyWallet(trader.address)}
                                                className="px-3 py-1 bg-terminal-accent/10 hover:bg-terminal-accent/30 text-terminal-accent border border-terminal-accent/50 rounded text-xs font-bold transition-all"
                                            >
                                                COPY
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {communityWallets.length === 0 && (
                            <div className="p-12 text-center text-gray-600">
                                <p>Registry connection initializing...</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )}

        {/* VIEW: VAULT */}
        {activeTab === 'vault' && (
            <div className="max-w-4xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-300">
                <div className="glass-panel p-8 rounded-xl border border-terminal-border mb-8">
                     <div className="flex items-center gap-4 mb-8 pb-8 border-b border-terminal-border">
                        <div className="p-3 bg-terminal-accent/10 rounded-xl">
                            <Lock size={32} className="text-terminal-accent" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold text-white">Security Vault</h2>
                            <p className="text-gray-500 text-sm">Manage keys, endpoints, and automation settings locally.</p>
                        </div>
                     </div>

                     <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        {/* Keys */}
                        <div className="space-y-4">
                            <h3 className="text-xs font-bold text-white uppercase tracking-wider mb-4 flex items-center gap-2">
                                <Key size={14} className="text-terminal-warn" /> Credentials
                            </h3>
                            
                            <div className="space-y-2">
                                <label className="text-xs text-gray-500">Proxy Wallet Private Key</label>
                                <div className="relative">
                                    <input 
                                        type={showSecrets ? "text" : "password"}
                                        className="w-full bg-black/40 border border-terminal-border rounded-lg px-4 py-3 text-sm focus:border-terminal-accent outline-none font-mono text-white transition-colors"
                                        placeholder="Enter EVM Private Key"
                                        value={config.privateKey}
                                        onChange={e => setConfig({...config, privateKey: e.target.value})}
                                    />
                                    <button 
                                        onClick={() => setShowSecrets(!showSecrets)}
                                        className="absolute right-3 top-3 text-gray-500 hover:text-white"
                                    >
                                        {showSecrets ? <EyeOff size={16} /> : <Eye size={16} />}
                                    </button>
                                </div>
                            </div>
                            
                            <div className="space-y-2">
                                <label className="text-xs text-gray-500">Target Wallets (Comma Separated)</label>
                                <textarea 
                                    className="w-full bg-black/40 border border-terminal-border rounded-lg px-4 py-3 text-sm focus:border-terminal-accent outline-none font-mono text-white min-h-[100px]"
                                    placeholder="0x123..., 0x456..."
                                    value={config.userAddresses}
                                    onChange={e => setConfig({...config, userAddresses: e.target.value})}
                                />
                            </div>
                        </div>

                        {/* Config */}
                        <div className="space-y-6">
                            <h3 className="text-xs font-bold text-white uppercase tracking-wider mb-4 flex items-center gap-2">
                                <Coins size={14} className="text-terminal-success" /> Automation
                            </h3>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-xs text-gray-500">Max Retention ($)</label>
                                    <input 
                                        type="number"
                                        className="w-full bg-black/40 border border-terminal-border rounded-lg px-4 py-2 text-sm focus:border-terminal-accent outline-none font-mono text-white"
                                        value={config.maxRetentionAmount}
                                        onChange={e => setConfig({...config, maxRetentionAmount: Number(e.target.value)})}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs text-gray-500">Auto Cashout</label>
                                    <button 
                                        onClick={() => setConfig({...config, enableAutoCashout: !config.enableAutoCashout})}
                                        className={`w-full py-2 rounded-lg text-xs font-bold border transition-all ${
                                            config.enableAutoCashout 
                                            ? 'bg-terminal-success/20 border-terminal-success text-terminal-success' 
                                            : 'bg-black/40 border-terminal-border text-gray-500'
                                        }`}
                                    >
                                        {config.enableAutoCashout ? 'ENABLED' : 'DISABLED'}
                                    </button>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-xs text-gray-500">Registry API URL</label>
                                <input 
                                    type="text"
                                    className="w-full bg-black/40 border border-terminal-border rounded-lg px-4 py-2 text-xs focus:border-terminal-accent outline-none font-mono text-gray-400"
                                    value={config.registryUrl}
                                    onChange={e => setConfig({...config, registryUrl: e.target.value})}
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-xs text-gray-500">Risk Profile</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {['conservative', 'balanced', 'degen'].map(p => (
                                        <button
                                            key={p}
                                            onClick={() => setConfig({...config, riskProfile: p as any})}
                                            className={`py-1.5 rounded border text-[10px] uppercase font-bold transition-all ${
                                                config.riskProfile === p 
                                                ? 'bg-terminal-accent text-white border-terminal-accent' 
                                                : 'bg-transparent border-gray-700 text-gray-500 hover:border-gray-500'
                                            }`}
                                        >
                                            {p}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                     </div>

                     <div className="mt-8 pt-6 border-t border-terminal-border flex justify-end">
                        <button 
                            onClick={saveConfig}
                            className="px-8 py-3 bg-terminal-accent hover:bg-blue-600 text-white font-bold rounded-lg shadow-lg shadow-blue-900/20 flex items-center gap-2 transition-all"
                        >
                            <Save size={18} /> SAVE CONFIGURATION
                        </button>
                     </div>
                </div>
            </div>
        )}

      </main>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);