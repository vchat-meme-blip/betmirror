import { IExchangeAdapter } from '../adapters/interfaces.js';
import { Logger } from '../utils/logger.util.js';
import { WS_URLS } from '../config/env.js';
import { MoneyMarketOpportunity } from '../database/index.js';
import EventEmitter from 'events';
// Use default import for WebSocket
import WebSocket from 'ws';
import type RawData from 'ws';

// ============================================================
// INTERFACES (UNCHANGED)
// ============================================================

export interface MarketOpportunity {
    marketId: string;
    conditionId: string;
    tokenId: string;
    question: string;
    bestBid: number;
    bestAsk: number;
    spread: number;
    spreadPct: number;
    spreadCents: number;
    midpoint: number;
    volume: number;
    liquidity: number;
    isNew: boolean;
    rewardsMaxSpread?: number;
    rewardsMinSize?: number;
    timestamp: number;
    // Compatibility fields for UI
    roi: number;
    combinedCost: number;
    capacityUsd: number;
    // NEW: Inventory skew
    skew?: number;
}

interface TrackedMarket {
    conditionId: string;
    tokenId: string;
    question: string;
    bestBid: number;
    bestAsk: number;
    spread: number;
    volume: number;
    liquidity: number;
    isNew: boolean;
    discoveredAt: number;
    rewardsMaxSpread?: number;
    rewardsMinSize?: number;
    // NEW: Track YES/NO token mapping
    isYesToken?: boolean;
    pairedTokenId?: string;
}

export interface MarketMakerConfig {
    minSpreadCents: number;
    maxSpreadCents: number;
    minVolume: number;
    minLiquidity: number;
    preferRewardMarkets: boolean;
    preferNewMarkets: boolean;
    newMarketAgeMinutes: number;
    refreshIntervalMs: number;
    // NEW: Risk management config
    priceMoveThresholdPct: number;    // Cancel orders if price moves X%
    maxInventoryPerToken: number;      // Max USD exposure per token
    autoMergeThreshold: number;        // Merge when pairs exceed this
    enableKillSwitch: boolean;         // Enable emergency stop
}

// ============================================================
// NEW: Risk Management Interfaces
// ============================================================

interface InventoryBalance {
    yes: number;
    no: number;
    yesTokenId: string;
    noTokenId: string;
    conditionId: string;
}

interface TickSizeInfo {
    tokenId: string;
    tickSize: string;
    updatedAt: number;
}

// ============================================================
// MAIN SCANNER CLASS (PRESERVED + ENHANCED)
// ============================================================

export class MarketMakingScanner extends EventEmitter {
    // ORIGINAL: Core state
    private isScanning = false;
    private isConnected = false;
    // FIX: Using explicit ws.WebSocket type
    private ws?: WebSocket;
    private trackedMarkets: Map<string, TrackedMarket> = new Map();
    private opportunities: MarketOpportunity[] = [];
    private pingInterval?: NodeJS.Timeout;
    private refreshInterval?: NodeJS.Timeout;
    private reconnectAttempts = 0;
    private reconnectTimeout?: NodeJS.Timeout;
    private readonly maxReconnectAttempts = 10;
    private readonly maxReconnectDelay = 30000;

    // NEW: Risk management state
    private lastMidpoints: Map<string, number> = new Map();
    private inventoryBalances: Map<string, InventoryBalance> = new Map();
    private tickSizes: Map<string, TickSizeInfo> = new Map();
    private resolvedMarkets: Set<string> = new Set();
    private killSwitchActive = false;

    // ORIGINAL: Default config (EXTENDED)
    private config: MarketMakerConfig = {
        minSpreadCents: 2,
        maxSpreadCents: 15,
        minVolume: 5000,
        minLiquidity: 1000,
        preferRewardMarkets: true,
        preferNewMarkets: true,
        newMarketAgeMinutes: 60,
        refreshIntervalMs: 5 * 60 * 1000,
        // NEW: Risk defaults
        priceMoveThresholdPct: 5,
        maxInventoryPerToken: 500,
        autoMergeThreshold: 100,
        enableKillSwitch: true
    };

    constructor(
        private adapter: IExchangeAdapter,
        private logger: Logger,
        config?: Partial<MarketMakerConfig>
    ) {
        super();
        if (config) this.config = { ...this.config, ...config };
    }

    // ============================================================
    // ORIGINAL: Core Methods (UNCHANGED)
    // ============================================================

    async start() {
        if (this.isScanning && this.isConnected) {
            this.logger.info('🔍 Market making scanner already running');
            return;
        }

        if (this.isScanning) {
            await this.stop();
        }

        this.isScanning = true;
        this.killSwitchActive = false; // Reset kill switch on start
        this.logger.info('🚀 Starting market making scanner...');
        this.logger.info(`📊 Config: minSpread=${this.config.minSpreadCents}¢, maxSpread=${this.config.maxSpreadCents}¢, minVolume=$${this.config.minVolume}`);

        try {
            await this.discoverMarkets();
            this.connect();
            
            this.refreshInterval = setInterval(() => {
                this.discoverMarkets();
            }, this.config.refreshIntervalMs);
            
            this.logger.success('📊 MM ENGINE: Spread Capture Mode Active');

            await this.debugGammaApi(); 
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to start scanner:', err);
            this.isScanning = false;
            throw err;
        }
    }

    // run separately
    private async debugGammaApi() {
        try {
            const response = await fetch(
                'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=5&order=volume&ascending=false'
            );
            const data = await response.json();
            
            console.log('=== RAW RESPONSE ===');
            const events = Array.isArray(data) ? data : (data.data || []);
            if (events[0]) {
                console.log(JSON.stringify(events[0], null, 2));
                if (events[0].markets?.[0]) {
                    const m = events[0].markets[0];
                    console.log('\n=== FIRST MARKET ===');
                    console.log('volume:', m.volume, typeof m.volume);
                    console.log('liquidity:', m.liquidity, typeof m.liquidity);
                }
            }
        } catch (e) {}
    }

    /**
     * ORIGINAL: Discover markets via Gamma API
     * Per docs: GET /events?active=true&closed=false&order=volume&ascending=false
     */
    private async discoverMarkets() {
        this.logger.info('📡 Discovering high-volume markets from Gamma API...');
        
        try {
            const response = await fetch(
                'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=volume&ascending=false'
            );
            
            if (!response.ok) {
                throw new Error(`Gamma API error: ${response.status}`);
            }
            
            const data = await response.json();
            const events = Array.isArray(data) ? data : (data.data || []);

            let addedCount = 0;
            const newTokenIds: string[] = [];

            for (const event of events) {
                const markets = event.markets || [];
                
                for (const market of markets) {
                    /**
                     * CRITICAL FILTER:
                     * Filter out closed markets found in logs that cause 404s.
                     */
                    if (market.closed === true || market.acceptingOrders === false || market.resolved === true) {
                        continue;
                    }

                    // Volume/liquidity can be string or number
                    const volume = parseFloat(market.volume || market.volumeNum || '0');
                    const liquidity = parseFloat(market.liquidity || market.liquidityNum || '0');

                    if (volume < this.config.minVolume) continue;
                    if (liquidity < this.config.minLiquidity) continue;

                    // Get token IDs - try multiple field names
                    const tokenIds: string[] = market.clobTokenIds || 
                                            market.clob_token_ids || 
                                            market.tokenIds || [];
                                            
                    if (tokenIds.length !== 2) continue; // Strictly Binary for MM

                    const conditionId = market.conditionId || market.condition_id;
                    if (!conditionId) continue;

                    const rewards = market.rewards || {};
                    const outcomes: string[] = market.outcomes || ['Yes', 'No'];

                    for (let i = 0; i < tokenIds.length; i++) {
                        const tokenId = tokenIds[i];
                        
                        if (this.trackedMarkets.has(tokenId)) {
                            const existing = this.trackedMarkets.get(tokenId)!;
                            existing.volume = volume;
                            existing.liquidity = liquidity;
                            continue;
                        }

                        const isYesToken = outcomes[i]?.toLowerCase() === 'yes' || i === 0;
                        const pairedTokenId = tokenIds[i === 0 ? 1 : 0];

                        this.trackedMarkets.set(tokenId, {
                            conditionId,
                            tokenId,
                            question: market.question || event.title || 'Unknown',
                            bestBid: 0,
                            bestAsk: 0,
                            spread: 0,
                            volume,
                            liquidity,
                            isNew: false,
                            discoveredAt: Date.now(),
                            rewardsMaxSpread: rewards.max_spread,
                            rewardsMinSize: rewards.min_size,
                            isYesToken,
                            pairedTokenId
                        });

                        newTokenIds.push(tokenId);
                        addedCount++;

                        // SYNC FIX: Fetch initial price from REST immediately
                        this.fetchInitialPrice(tokenId);
                    }
                }
            }

            this.logger.info(`✅ Tracking ${this.trackedMarkets.size} tokens (${addedCount} new) | Min volume: $${this.config.minVolume}`);

            if (newTokenIds.length > 0 && this.ws?.readyState === 1) {
                this.subscribeToTokens(newTokenIds);
            }

        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to discover markets:', err);
        }
    }

    /**
     * NEW: Fetch initial midpoint from REST to avoid empty UI
     */
    private async fetchInitialPrice(tokenId: string) {
        try {
            const market = this.trackedMarkets.get(tokenId);
            if (!market) return;
            
            const response = await fetch(`${WS_URLS.CLOB.replace('wss://ws-subscriptions-clob', 'https://clob')}/midpoint?token_id=${tokenId}`);
            if (response.ok) {
                const data = await response.json();
                const mid = parseFloat(data.mid);
                if (mid > 0) {
                    market.bestBid = mid - 0.005;
                    market.bestAsk = mid + 0.005;
                    market.spread = 0.01;
                    this.updateOpportunities();
                }
            }
        } catch (e) {}
    }

    // ORIGINAL: WebSocket connection (UNCHANGED)
    private connect() {
        if (!this.isScanning) return;

        const wsUrl = `${WS_URLS.CLOB}/ws/market`;
        this.logger.info(`🔌 Connecting to ${wsUrl}`);
        this.ws = new WebSocket(wsUrl);

        // FIX: Typescript may confuse browser and node ws, cast to any to ensure 'on' works
        const wsAny = this.ws as any;

        wsAny.on('open', () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.logger.success('✅ WebSocket connected');
            this.subscribeToAllTrackedTokens();
            this.startPing();
        });

        wsAny.on('message', (data: RawData) => {
            try {
                const msg = data.toString();
                if (msg === 'PONG') return;
                
                const parsed = JSON.parse(msg);
                if (Array.isArray(parsed)) {
                    parsed.forEach(m => this.processMessage(m));
                } else {
                    this.processMessage(parsed);
                }
            } catch (error) {
                // Ignore parse errors for non-JSON messages
            }
        });

        wsAny.on('close', (code: number, reason: string) => {
            this.isConnected = false;
            this.logger.warn(`📡 WebSocket closed: ${code}`);
            this.stopPing();
            if (this.isScanning) this.handleReconnect();
        });

        wsAny.on('error', (error: Error) => {
            this.logger.error(`❌ WebSocket error: ${error.message}`);
        });
    }

    /**
     * ORIGINAL: Subscribe with custom_feature_enabled
     * Per docs: Enables best_bid_ask + new_market + market_resolved + tick_size_change
     */
    private subscribeToAllTrackedTokens() {
        if (!this.ws || this.ws.readyState !== 1) return;

        const assetIds = Array.from(this.trackedMarkets.keys());
        
        const subscribeMsg = {
            type: 'market',
            assets_ids: assetIds,
            custom_feature_enabled: true  // Enables ALL custom events
        };

        this.ws.send(JSON.stringify(subscribeMsg));
        this.logger.info(`📡 Subscribed to ${assetIds.length} tokens with custom features enabled`);
    }

    // ORIGINAL: Dynamic subscription (UNCHANGED)
    private subscribeToTokens(tokenIds: string[]) {
        if (!this.ws || this.ws.readyState !== 1 || tokenIds.length === 0) return;

        this.ws.send(JSON.stringify({
            assets_ids: tokenIds,
            operation: 'subscribe'
        }));
        
        this.logger.debug(`📡 Subscribed to ${tokenIds.length} additional tokens`);
    }

    /**
     * ENHANCED: Process WebSocket messages
     * Per docs: event_type can be: book, price_change, best_bid_ask, new_market,
     * last_trade_price, market_resolved, tick_size_change
     */
    private processMessage(msg: any) {
        if (!msg?.event_type) return;

        // NEW: Skip processing if kill switch is active
        if (this.killSwitchActive && msg.event_type !== 'market_resolved') {
            return;
        }

        switch (msg.event_type) {
            // ORIGINAL handlers
            case 'best_bid_ask':
                this.handleBestBidAsk(msg);
                break;
            case 'book':
                this.handleBookUpdate(msg);
                break;
            case 'new_market':
                this.handleNewMarket(msg);
                break;
            case 'price_change':
                this.handlePriceChange(msg);
                break;

            // NEW: Risk management handlers
            case 'last_trade_price':
                this.handleLastTradePrice(msg);
                break;
            case 'market_resolved':
                this.handleMarketResolved(msg);
                break;
            case 'tick_size_change':
                this.handleTickSizeChange(msg);
                break;
        }
    }

    // ============================================================
    // ORIGINAL: Event Handlers (UNCHANGED)
    // ============================================================

    private handleBestBidAsk(msg: any) {
        const tokenId = msg.asset_id;
        const bestBid = parseFloat(msg.best_bid || '0');
        const bestAsk = parseFloat(msg.best_ask || '1');
        const spread = parseFloat(msg.spread || '0');

        let market = this.trackedMarkets.get(tokenId);
        if (!market) return;

        market.bestBid = bestBid;
        market.bestAsk = bestAsk;
        market.spread = spread;

        this.evaluateOpportunity(market);
    }

    private handleBookUpdate(msg: any) {
        const tokenId = msg.asset_id;
        const bids = msg.bids || [];
        const asks = msg.asks || [];

        if (bids.length === 0 || asks.length === 0) return;

        let market = this.trackedMarkets.get(tokenId);
        if (!market) return;

        const bestBid = parseFloat(bids[0]?.price || '0');
        const bestAsk = parseFloat(asks[0]?.price || '1');

        market.bestBid = bestBid;
        market.bestAsk = bestAsk;
        market.spread = bestAsk - bestBid;

        this.evaluateOpportunity(market);
    }

    private handleNewMarket(msg: any) {
        const assetIds: string[] = msg.assets_ids || [];
        const question = msg.question || 'New Market';
        const conditionId = msg.market;
        const outcomes: string[] = msg.outcomes || ['Yes', 'No'];

        /**
         * 🔒 BINARY GUARD:
         * Strictly enforce 2 outcomes for mergePositions [1, 2] compatibility.
         */
        if (assetIds.length !== 2) return;

        this.logger.info(`🆕 NEW BINARY MARKET DETECTED: ${question}`);

        for (let i = 0; i < assetIds.length; i++) {
            const tokenId = assetIds[i];
            if (!this.trackedMarkets.has(tokenId)) {
                this.trackedMarkets.set(tokenId, {
                    conditionId,
                    tokenId,
                    question,
                    bestBid: 0,
                    bestAsk: 0,
                    spread: 0,
                    volume: 0,
                    liquidity: 0,
                    isNew: true,
                    discoveredAt: Date.now(),
                    // NEW: Track token pairs
                    isYesToken: outcomes[i]?.toLowerCase() === 'yes' || i === 0,
                    pairedTokenId: assetIds[i === 0 ? 1 : 0]
                });
            }
        }

        if (assetIds.length > 0 && this.ws?.readyState === 1) {
            this.subscribeToTokens(assetIds);
            this.logger.success(`✨ Subscribed to new market: ${question.slice(0, 50)}...`);
        }
    }

    private handlePriceChange(msg: any) {
        const priceChanges = msg.price_changes || [];
        
        for (const change of priceChanges) {
            const tokenId = change.asset_id;
            const market = this.trackedMarkets.get(tokenId);
            if (!market) continue;

            if (change.best_bid) market.bestBid = parseFloat(change.best_bid);
            if (change.best_ask) market.bestAsk = parseFloat(change.best_ask);
            market.spread = market.bestAsk - market.bestBid;

            this.evaluateOpportunity(market);
        }
    }

    // ============================================================
    // NEW: Risk Management Event Handlers
    // ============================================================

    /**
     * Handle last_trade_price events - detect flash moves
     * Per docs: { asset_id, price, side, size, timestamp }
     */
    private handleLastTradePrice(msg: any) {
        const tokenId = msg.asset_id;
        const price = parseFloat(msg.price);
        const market = this.trackedMarkets.get(tokenId);
        
        if (!market) return;

        const lastMid = this.lastMidpoints.get(tokenId);
        
        if (lastMid && lastMid > 0) {
            const movePct = Math.abs(price - lastMid) / lastMid * 100;

            if (movePct > this.config.priceMoveThresholdPct) {
                this.logger.warn(`🔴 FLASH MOVE: ${movePct.toFixed(1)}% on ${market.question.slice(0, 30)}...`);
                
                // Trigger Kill Switch if enabled
                if (this.config.enableKillSwitch) {
                    this.triggerKillSwitch(`Volatility spike on ${market.tokenId}`);
                }
            }
        }

        this.lastMidpoints.set(tokenId, price);
    }

    /**
     * Handle market_resolved events - stop trading, prepare redemption
     * Per docs: { market, winning_asset_id, winning_outcome, question, timestamp }
     * Requires custom_feature_enabled: true
     */
    private handleMarketResolved(msg: any) {
        const conditionId = msg.market;
        const winningOutcome = msg.winning_outcome;
        const winningAssetId = msg.winning_asset_id;
        const question = msg.question || 'Unknown';

        if (this.resolvedMarkets.has(conditionId)) return;
        this.resolvedMarkets.add(conditionId);

        this.logger.info(`🏁 MARKET RESOLVED: ${question}`);
        this.logger.info(`🏆 Winner: ${winningOutcome} (${winningAssetId})`);

        // Remove from tracked markets
        for (const [tokenId, market] of this.trackedMarkets.entries()) {
            if (market.conditionId === conditionId) {
                this.trackedMarkets.delete(tokenId);
            }
        }

        // Remove from opportunities
        this.opportunities = this.opportunities.filter(o => o.conditionId !== conditionId);

        // Emit event for trade executor to cancel orders and redeem
        this.emit('marketResolved', {
            conditionId,
            winningOutcome,
            winningAssetId,
            question
        });
    }

    /**
     * Handle tick_size_change events - update price rounding
     * Per docs: Emitted when price > 0.96 or price < 0.04
     */
    private handleTickSizeChange(msg: any) {
        const tokenId = msg.asset_id;
        const oldTickSize = msg.old_tick_size;
        const newTickSize = msg.new_tick_size;

        this.tickSizes.set(tokenId, {
            tokenId,
            tickSize: newTickSize,
            updatedAt: Date.now()
        });

        this.logger.warn(`📏 TICK SIZE CHANGE: ${tokenId} | ${oldTickSize} → ${newTickSize}`);

        // Emit event for trade executor to re-quote with new tick size
        this.emit('tickSizeChange', {
            tokenId,
            oldTickSize,
            newTickSize
        });
    }

    // ============================================================
    // ORIGINAL: Opportunity Evaluation (UNCHANGED)
    // ============================================================

    private evaluateOpportunity(market: TrackedMarket) {
        const spreadCents = market.spread * 100;
        const midpoint = (market.bestBid + market.bestAsk) / 2;

        if (market.bestBid <= 0 || market.bestAsk >= 1 || market.bestAsk <= market.bestBid) {
            return;
        }

        const ageMinutes = (Date.now() - market.discoveredAt) / (1000 * 60);
        const isStillNew = market.isNew && ageMinutes < this.config.newMarketAgeMinutes;
        const effectiveMinVolume = isStillNew ? 0 : this.config.minVolume;

        if (spreadCents < this.config.minSpreadCents) return;
        if (spreadCents > this.config.maxSpreadCents) return;
        if (market.volume < effectiveMinVolume) return;

        const spreadPct = midpoint > 0 ? (market.spread / midpoint) * 100 : 0;
        const skew = this.getInventorySkew(market.conditionId);

        const opportunity: MarketOpportunity = {
            marketId: market.conditionId,
            conditionId: market.conditionId,
            tokenId: market.tokenId,
            question: market.question,
            bestBid: market.bestBid,
            bestAsk: market.bestAsk,
            spread: market.spread,
            spreadPct,
            spreadCents,
            midpoint,
            volume: market.volume,
            liquidity: market.liquidity,
            isNew: isStillNew,
            rewardsMaxSpread: market.rewardsMaxSpread,
            rewardsMinSize: market.rewardsMinSize,
            timestamp: Date.now(),
            roi: spreadPct,
            combinedCost: 1 - market.spread,
            capacityUsd: market.liquidity,
            // NEW: pass inventory skew to executor
            skew
        };

        this.updateOpportunitiesInternal(opportunity);
    }

    private async updateOpportunitiesInternal(opp: MarketOpportunity) {
        const existingIdx = this.opportunities.findIndex(o => o.tokenId === opp.tokenId);
        if (existingIdx !== -1) {
            this.opportunities[existingIdx] = opp;
        } else {
            this.opportunities.push(opp);
        }

        // PERSIST TO DATABASE
        try {
            await MoneyMarketOpportunity.findOneAndUpdate(
                { tokenId: opp.tokenId },
                { ...opp, timestamp: new Date() },
                { upsert: true }
            );
        } catch (dbErr) {}

        this.opportunities.sort((a, b) => {
            if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
            return b.spreadCents - a.spreadCents;
        });

        this.emit('opportunity', opp);
    }

    private updateOpportunities() {
        const opps: MarketOpportunity[] = [];
        const now = Date.now();

        for (const [tokenId, market] of this.trackedMarkets.entries()) {
            if (market.bestBid > 0 && market.bestAsk > 0) {
                const spreadCents = market.spread * 100;
                
                if (spreadCents >= this.config.minSpreadCents && spreadCents <= this.config.maxSpreadCents) {
                    const midpoint = (market.bestBid + market.bestAsk) / 2;
                    const isNew = (now - market.discoveredAt) < (this.config.newMarketAgeMinutes * 60 * 1000);
                    
                    const opp: MarketOpportunity = {
                        marketId: market.conditionId,
                        conditionId: market.conditionId,
                        tokenId,
                        question: market.question,
                        bestBid: market.bestBid,
                        bestAsk: market.bestAsk,
                        spread: market.spread,
                        spreadPct: (market.spread / midpoint) * 100,
                        spreadCents,
                        midpoint,
                        volume: market.volume,
                        liquidity: market.liquidity,
                        isNew,
                        rewardsMaxSpread: market.rewardsMaxSpread,
                        rewardsMinSize: market.rewardsMinSize,
                        timestamp: now,
                        roi: (market.spread / midpoint) * 100,
                        combinedCost: 1 - market.spread,
                        capacityUsd: market.liquidity
                    };
                    opps.push(opp);
                    
                    // Fire update to DB
                    MoneyMarketOpportunity.findOneAndUpdate(
                        { tokenId: opp.tokenId },
                        { ...opp, timestamp: new Date() },
                        { upsert: true }
                    ).catch(() => {});
                }
            }
        }
        this.opportunities = opps.sort((a, b) => b.spreadPct - a.spreadPct);
        if (this.opportunities.length > 0) {
            this.emit('opportunity', this.opportunities[0]);
        }
    }

    // ============================================================
    // ORIGINAL: Connection Management (UNCHANGED)
    // ============================================================

    private startPing() {
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === 1) {
                this.ws.send('PING');
            }
        }, 10000);
    }

    private stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
    }

    private handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);

        this.logger.info(`Reconnecting in ${delay}ms (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimeout = setTimeout(() => {
            if (this.isScanning) this.connect();
        }, delay);
    }

    public stop() {
        this.logger.info('🛑 Stopping market making scanner...');
        this.isScanning = false;
        this.isConnected = false;
        this.stopPing();

        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }

        if (this.ws) {
            const wsAny = this.ws as any;
            wsAny.removeAllListeners();
            if (this.ws.readyState === 1) {
                wsAny.terminate();
            }
            this.ws = undefined;
        }

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        this.logger.warn('🛑 Scanner stopped');
    }

    // ============================================================
    // ORIGINAL: Public Getters (UNCHANGED)
    // ============================================================

    getOpportunities(maxAgeMs = 60000): MarketOpportunity[] {
        const now = Date.now();
        return this.opportunities.filter(o => now - o.timestamp < maxAgeMs);
    }

    getLatestOpportunities(): MarketOpportunity[] {
        return this.getOpportunities();
    }

    getNewMarketOpportunities(): MarketOpportunity[] {
        return this.getOpportunities().filter(o => o.isNew);
    }

    getRewardEligibleOpportunities(): MarketOpportunity[] {
        return this.getOpportunities().filter(o => 
            o.rewardsMaxSpread && o.spread <= o.rewardsMaxSpread
        );
    }

    getHighVolumeOpportunities(minVolume = 50000): MarketOpportunity[] {
        return this.getOpportunities().filter(o => o.volume >= minVolume);
    }

    getBestOpportunities(limit = 10): MarketOpportunity[] {
        return this.getOpportunities()
            .sort((a, b) => {
                const scoreA = (a.isNew ? 50 : 0) + (a.volume > 50000 ? 20 : 0) + a.spreadCents;
                const scoreB = (b.isNew ? 50 : 0) + (b.volume > 50000 ? 20 : 0) + b.spreadCents;
                return scoreB - scoreA;
            })
            .slice(0, limit);
    }

    // ============================================================
    // NEW: Risk Management Public Methods
    // ============================================================

    onOrderFilled(tokenId: string, side: 'BUY' | 'SELL', size: number) {
        const market = this.trackedMarkets.get(tokenId);
        if (!market) return;

        const conditionId = market.conditionId;
        let balance = this.inventoryBalances.get(conditionId);

        if (!balance) {
            balance = {
                yes: 0,
                no: 0,
                yesTokenId: market.isYesToken ? tokenId : (market.pairedTokenId || ''),
                noTokenId: market.isYesToken ? (market.pairedTokenId || '') : tokenId,
                conditionId
            };
            this.inventoryBalances.set(conditionId, balance);
        }

        const isYes = market.isYesToken;
        if (side === 'BUY') {
            if (isYes) balance.yes += size;
            else balance.no += size;
        } else {
            if (isYes) balance.yes -= size;
            else balance.no -= size;
        }

        const mergeableAmount = Math.min(balance.yes, balance.no);
        if (mergeableAmount >= this.config.autoMergeThreshold) {
            this.emit('mergeOpportunity', { conditionId, amount: mergeableAmount, balance });
        }

        const midpoint = market.bestBid > 0 ? (market.bestBid + market.bestAsk) / 2 : 0.5;
        const yesExposure = Math.max(0, balance.yes - balance.no) * midpoint;
        const noExposure = Math.max(0, balance.no - balance.yes) * (1 - midpoint);
        const maxExposure = Math.max(yesExposure, noExposure);

        if (maxExposure > this.config.maxInventoryPerToken) {
            this.logger.warn(`⚠️ Inventory limit exceeded: $${maxExposure.toFixed(2)} on ${market.question.slice(0, 30)}...`);
            this.emit('inventoryLimit', { conditionId, tokenId, exposure: maxExposure, balance });
        }
    }

    getInventorySkew(conditionId: string): number {
        const balance = this.inventoryBalances.get(conditionId);
        if (!balance) return 0;
        const total = balance.yes + balance.no;
        if (total === 0) return 0;
        return (balance.yes - balance.no) / total;
    }

    getTickSize(tokenId: string): string {
        const info = this.tickSizes.get(tokenId);
        return info?.tickSize || '0.01';
    }

    roundToTickSize(price: number, tokenId: string): number {
        const tickSize = parseFloat(this.getTickSize(tokenId));
        return Math.round(price / tickSize) * tickSize;
    }

    triggerKillSwitch(reason: string) {
        if (!this.config.enableKillSwitch) return;
        this.killSwitchActive = true;
        this.logger.error(`🚨 KILL SWITCH TRIGGERED: ${reason}`);
        this.emit('killSwitch', { reason, timestamp: Date.now() });
    }

    resetKillSwitch() {
        this.killSwitchActive = false;
        this.logger.info('🔄 Kill switch reset');
    }

    isKillSwitchActive(): boolean {
        return this.killSwitchActive;
    }

    getInventoryBalance(conditionId: string): InventoryBalance | undefined {
        return this.inventoryBalances.get(conditionId);
    }

    getAllInventoryBalances(): Map<string, InventoryBalance> {
        return new Map(this.inventoryBalances);
    }

    getTrackedMarket(tokenId: string): TrackedMarket | undefined {
        return this.trackedMarkets.get(tokenId);
    }

    isMarketResolved(conditionId: string): boolean {
        return this.resolvedMarkets.has(conditionId);
    }

    async emergencyStop(reason: string) {
        this.triggerKillSwitch(reason);
        this.stop();
    }
}