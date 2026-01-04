import { WS_URLS } from '../config/env.js';
import { MoneyMarketOpportunity } from '../database/index.js';
import EventEmitter from 'events';
// Use default import for WebSocket
import WebSocket from 'ws';
// ============================================================
// MAIN SCANNER CLASS (ENHANCED)
// ============================================================
export class MarketMakingScanner extends EventEmitter {
    adapter;
    logger;
    // Core state
    isScanning = false;
    isConnected = false;
    // FIX: Using explicit ws.WebSocket type
    ws;
    trackedMarkets = new Map();
    opportunities = [];
    pingInterval;
    refreshInterval;
    reconnectAttempts = 0;
    reconnectTimeout;
    maxReconnectAttempts = 10;
    maxReconnectDelay = 30000;
    // Risk management state
    lastMidpoints = new Map();
    inventoryBalances = new Map();
    tickSizes = new Map();
    resolvedMarkets = new Set();
    killSwitchActive = false;
    bookmarkedMarkets = new Set();
    // Default config (EXTENDED)
    config = {
        minSpreadCents: 1,
        maxSpreadCents: 15,
        minVolume: 5000,
        minLiquidity: 1000,
        preferRewardMarkets: true,
        preferNewMarkets: true,
        newMarketAgeMinutes: 60,
        refreshIntervalMs: 5 * 60 * 1000,
        // Risk defaults
        priceMoveThresholdPct: 5,
        maxInventoryPerToken: 500,
        autoMergeThreshold: 100,
        enableKillSwitch: true
    };
    constructor(adapter, logger, config) {
        super();
        this.adapter = adapter;
        this.logger = logger;
        if (config)
            this.config = { ...this.config, ...config };
    }
    async start() {
        if (this.isScanning && this.isConnected) {
            this.logger.info('🔍 Market making scanner already running');
            return;
        }
        if (this.isScanning) {
            await this.stop();
        }
        this.isScanning = true;
        this.killSwitchActive = false;
        this.logger.info('🚀 Starting market making scanner...');
        this.logger.info(`📊 Config: minSpread=${this.config.minSpreadCents}¢, maxSpread=${this.config.maxSpreadCents}¢, minVolume=$${this.config.minVolume}`);
        try {
            await this.discoverMarkets();
            this.connect();
            this.refreshInterval = setInterval(() => {
                this.discoverMarkets();
            }, this.config.refreshIntervalMs);
            this.logger.success('📊 MM ENGINE: Spread Capture Mode Active');
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to start scanner:', err);
            this.isScanning = false;
            throw err;
        }
    }
    /**
     * PRODUCTION: Multi-source market discovery
     * Fetches from multiple endpoints to capture Sports, Trending, Breaking markets
     */
    async discoverMarkets() {
        this.logger.info('📡 Discovering markets from Gamma API...');
        try {
            // Multi-source discovery for comprehensive coverage
            const endpoints = [
                // Trending markets (high volume and recent activity)
                'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&order=volume24hr&ascending=false',
                // Breaking markets (recently created with high activity)
                'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=30&order=createdAt&ascending=false&minVolume=1000',
                // High volume markets
                'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&order=volume&ascending=false',
                // High liquidity markets
                'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&order=liquidity&ascending=false',
                // Category-specific markets
                ...['sports', 'politics', 'crypto', 'entertainment', 'business', 'science'].map(category => `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=30&tag=${category}&order=volume&ascending=false`)
            ];
            let addedCount = 0;
            const newTokenIds = [];
            const seenConditionIds = new Set();
            for (const url of endpoints) {
                try {
                    const response = await fetch(url);
                    if (!response.ok) {
                        this.logger.debug(`Endpoint failed: ${url} - ${response.status}`);
                        continue;
                    }
                    const data = await response.json();
                    const events = Array.isArray(data) ? data : (data.data || []);
                    for (const event of events) {
                        const markets = event.markets || [];
                        for (const market of markets) {
                            const result = this.processMarketData(market, event, seenConditionIds);
                            if (result.added) {
                                addedCount++;
                                newTokenIds.push(...result.tokenIds);
                            }
                        }
                    }
                }
                catch (endpointError) {
                    this.logger.debug(`Endpoint error: ${url}`);
                    continue;
                }
            }
            this.logger.info(`✅ Tracking ${this.trackedMarkets.size} tokens (${addedCount} new) | Min volume: $${this.config.minVolume}`);
            // Subscribe to WebSocket for new tokens
            if (newTokenIds.length > 0 && this.ws?.readyState === 1) {
                this.subscribeToTokens(newTokenIds);
            }
            // Trigger initial opportunity evaluation for markets with price data
            this.updateOpportunities();
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to discover markets:', err);
        }
    }
    /**
     * PRODUCTION: Process a single market from API response
     * Handles JSON string parsing for clobTokenIds, outcomes, outcomePrices
     */
    processMarketData(market, event, seenConditionIds) {
        const result = { added: false, tokenIds: [] };
        // Get condition ID
        const conditionId = market.conditionId || market.condition_id;
        if (!conditionId || seenConditionIds.has(conditionId)) {
            return result;
        }
        // CRITICAL FILTER: Skip closed/inactive/paused markets
        if (market.closed === true)
            return result;
        if (market.acceptingOrders === false)
            return result;
        if (market.active === false)
            return result;
        if (market.archived === true)
            return result;
        // Parse volume/liquidity (can be string or number)
        const volume = this.parseNumber(market.volumeNum || market.volume || market.volumeClob);
        const liquidity = this.parseNumber(market.liquidityNum || market.liquidity || market.liquidityClob);
        const volume24hr = this.parseNumber(market.volume24hr || market.volume24hrClob);
        // Apply volume/liquidity filters
        if (volume < this.config.minVolume)
            return result;
        if (liquidity < this.config.minLiquidity)
            return result;
        // FIX: Parse clobTokenIds - IT'S A JSON STRING!
        const tokenIds = this.parseJsonArray(market.clobTokenIds || market.clob_token_ids);
        if (tokenIds.length !== 2)
            return result; // Binary markets only
        // Parse outcomes
        const outcomes = this.parseJsonArray(market.outcomes) || ['Yes', 'No'];
        // Parse current prices
        const outcomePrices = this.parseJsonArray(market.outcomePrices);
        // Mark as seen
        seenConditionIds.add(conditionId);
        // Compute market status
        const status = this.computeMarketStatus(market);
        // Process each token (YES and NO)
        for (let i = 0; i < tokenIds.length; i++) {
            const tokenId = tokenIds[i];
            if (this.trackedMarkets.has(tokenId)) {
                // Update existing market data
                const existing = this.trackedMarkets.get(tokenId);
                existing.volume = volume;
                existing.liquidity = liquidity;
                existing.bestBid = market.bestBid || existing.bestBid;
                existing.bestAsk = market.bestAsk || existing.bestAsk;
                existing.spread = market.spread || existing.spread;
                existing.status = status;
                existing.acceptingOrders = market.acceptingOrders !== false;
                continue;
            }
            const isYesToken = (outcomes[i]?.toLowerCase() === 'yes') || (i === 0);
            const pairedTokenId = tokenIds[i === 0 ? 1 : 0];
            // Get price from outcomePrices if available
            let initialPrice = 0;
            if (outcomePrices && outcomePrices[i]) {
                initialPrice = this.parseNumber(outcomePrices[i]);
            }
            this.trackedMarkets.set(tokenId, {
                conditionId,
                tokenId,
                question: market.question || event.title || 'Unknown',
                image: market.image || market.icon || event.image || event.icon || '',
                marketSlug: market.slug || '',
                bestBid: market.bestBid || (initialPrice > 0 ? initialPrice - 0.005 : 0),
                bestAsk: market.bestAsk || (initialPrice > 0 ? initialPrice + 0.005 : 0),
                spread: market.spread || 0.01,
                volume,
                liquidity,
                isNew: market.new === true || this.isRecentlyCreated(market.createdAt),
                discoveredAt: Date.now(),
                rewardsMaxSpread: market.rewardsMaxSpread,
                rewardsMinSize: market.rewardsMinSize,
                isYesToken,
                pairedTokenId,
                status,
                acceptingOrders: market.acceptingOrders !== false,
                volume24hr,
                orderMinSize: market.orderMinSize || 5,
                orderPriceMinTickSize: market.orderPriceMinTickSize || 0.01,
                category: this.extractCategory(event),
                featured: market.featured === true || event.featured === true,
                competitive: market.competitive
            });
            result.tokenIds.push(tokenId);
            result.added = true;
        }
        return result;
    }
    /**
     * PRODUCTION: Parse JSON string to array
     */
    parseJsonArray(value) {
        if (!value)
            return [];
        if (Array.isArray(value))
            return value;
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            }
            catch (e) {
                return [];
            }
        }
        return [];
    }
    /**
     * PRODUCTION: Parse number from string or number
     */
    parseNumber(value) {
        if (typeof value === 'number')
            return value;
        if (typeof value === 'string')
            return parseFloat(value) || 0;
        return 0;
    }
    /**
     * PRODUCTION: Compute market status from API fields
     */
    computeMarketStatus(market) {
        if (market.closed === true)
            return 'closed';
        if (market.umaResolutionStatus === 'resolved')
            return 'resolved';
        if (market.acceptingOrders === false)
            return 'paused';
        return 'active';
    }
    /**
     * PRODUCTION: Check if market was created recently (within 24 hours)
     */
    isRecentlyCreated(createdAt) {
        if (!createdAt)
            return false;
        try {
            const created = new Date(createdAt).getTime();
            const now = Date.now();
            const hoursSinceCreation = (now - created) / (1000 * 60 * 60);
            return hoursSinceCreation < 24;
        }
        catch {
            return false;
        }
    }
    /**
     * PRODUCTION: Extract category from event tags
     */
    extractCategory(event) {
        if (event.tags && Array.isArray(event.tags) && event.tags.length > 0) {
            return event.tags[0];
        }
        if (event.slug) {
            if (event.slug.includes('nfl') || event.slug.includes('nba') || event.slug.includes('super-bowl')) {
                return 'sports';
            }
            if (event.slug.includes('bitcoin') || event.slug.includes('ethereum') || event.slug.includes('crypto')) {
                return 'crypto';
            }
            if (event.slug.includes('election') || event.slug.includes('president') || event.slug.includes('trump')) {
                return 'politics';
            }
        }
        return undefined;
    }
    /**
     * PRODUCTION: Manually add a market by condition ID
     */
    async addMarketByConditionId(conditionId) {
        try {
            const response = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
            if (!response.ok) {
                this.logger.warn(`Market not found: ${conditionId}`);
                return false;
            }
            const markets = await response.json();
            if (!markets || markets.length === 0) {
                this.logger.warn(`Market not found: ${conditionId}`);
                return false;
            }
            const market = markets[0];
            const seenConditionIds = new Set();
            const result = this.processMarketData(market, { title: market.question }, seenConditionIds);
            if (result.added && result.tokenIds.length > 0) {
                if (this.ws?.readyState === 1) {
                    this.subscribeToTokens(result.tokenIds);
                }
                this.logger.success(`✅ Manually added market: ${market.question?.slice(0, 50)}...`);
                return true;
            }
            return false;
        }
        catch (error) {
            this.logger.error(`Failed to add market: ${error}`);
            return false;
        }
    }
    /**
     * PRODUCTION: Manually add a market by slug
     */
    async addMarketBySlug(slug) {
        try {
            const response = await fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`);
            if (!response.ok) {
                this.logger.warn(`Market not found: ${slug}`);
                return false;
            }
            const market = await response.json();
            if (!market || !market.conditionId) {
                this.logger.warn(`Market not found by slug: ${slug}`);
                return false;
            }
            const seenConditionIds = new Set();
            const result = this.processMarketData(market, { title: market.question }, seenConditionIds);
            if (result.added && result.tokenIds.length > 0) {
                if (this.ws?.readyState === 1) {
                    this.subscribeToTokens(result.tokenIds);
                }
                this.logger.success(`✅ Manually added market: ${market.question?.slice(0, 50)}...`);
                return true;
            }
            return false;
        }
        catch (error) {
            this.logger.error(`Failed to add market by slug: ${error}`);
            return false;
        }
    }
    /**
     * Bookmark a market for priority tracking
     */
    bookmarkMarket(conditionId) {
        this.bookmarkedMarkets.add(conditionId);
        this.logger.info(`📌 Bookmarked market: ${conditionId}`);
    }
    /**
     * Remove bookmark
     */
    unbookmarkMarket(conditionId) {
        this.bookmarkedMarkets.delete(conditionId);
        this.logger.info(`📌 Unbookmarked market: ${conditionId}`);
    }
    /**
     * Get bookmarked opportunities
     */
    getBookmarkedOpportunities() {
        return this.opportunities.filter(o => this.bookmarkedMarkets.has(o.conditionId));
    }
    /**
     * Check if market is bookmarked
     */
    isBookmarked(conditionId) {
        return this.bookmarkedMarkets.has(conditionId);
    }
    connect() {
        if (!this.isScanning)
            return;
        const wsUrl = `${WS_URLS.CLOB}/ws/market`;
        this.logger.info(`🔌 Connecting to ${wsUrl}`);
        this.ws = new WebSocket(wsUrl);
        const wsAny = this.ws;
        wsAny.on('open', () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.logger.success('✅ WebSocket connected');
            this.subscribeToAllTrackedTokens();
            this.startPing();
        });
        wsAny.on('message', (data) => {
            try {
                const msg = data.toString();
                if (msg === 'PONG')
                    return;
                const parsed = JSON.parse(msg);
                if (Array.isArray(parsed)) {
                    parsed.forEach(m => this.processMessage(m));
                }
                else {
                    this.processMessage(parsed);
                }
            }
            catch (error) {
            }
        });
        wsAny.on('close', (code, reason) => {
            this.isConnected = false;
            this.logger.warn(`📡 WebSocket closed: ${code}`);
            this.stopPing();
            if (this.isScanning)
                this.handleReconnect();
        });
        wsAny.on('error', (error) => {
            this.logger.error(`❌ WebSocket error: ${error.message}`);
        });
    }
    subscribeToAllTrackedTokens() {
        if (!this.ws || this.ws.readyState !== 1)
            return;
        const assetIds = Array.from(this.trackedMarkets.keys());
        const subscribeMsg = {
            type: 'market',
            assets_ids: assetIds,
            custom_feature_enabled: true
        };
        this.ws.send(JSON.stringify(subscribeMsg));
        this.logger.info(`📡 Subscribed to ${assetIds.length} tokens with custom features enabled`);
    }
    subscribeToTokens(tokenIds) {
        if (!this.ws || this.ws.readyState !== 1 || tokenIds.length === 0)
            return;
        this.ws.send(JSON.stringify({
            assets_ids: tokenIds,
            operation: 'subscribe'
        }));
        this.logger.debug(`📡 Subscribed to ${tokenIds.length} additional tokens`);
    }
    processMessage(msg) {
        if (!msg?.event_type)
            return;
        if (this.killSwitchActive && msg.event_type !== 'market_resolved') {
            return;
        }
        switch (msg.event_type) {
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
    handleBestBidAsk(msg) {
        const tokenId = msg.asset_id;
        const bestBid = parseFloat(msg.best_bid || '0');
        const bestAsk = parseFloat(msg.best_ask || '1');
        const spread = parseFloat(msg.spread || '0');
        let market = this.trackedMarkets.get(tokenId);
        if (!market)
            return;
        market.bestBid = bestBid;
        market.bestAsk = bestAsk;
        market.spread = spread;
        this.evaluateOpportunity(market);
    }
    handleBookUpdate(msg) {
        const tokenId = msg.asset_id;
        const bids = msg.bids || [];
        const asks = msg.asks || [];
        if (bids.length === 0 || asks.length === 0)
            return;
        let market = this.trackedMarkets.get(tokenId);
        if (!market)
            return;
        const bestBid = parseFloat(bids[0]?.price || '0');
        const bestAsk = parseFloat(asks[0]?.price || '1');
        market.bestBid = bestBid;
        market.bestAsk = bestAsk;
        market.spread = bestAsk - bestBid;
        this.evaluateOpportunity(market);
    }
    handleNewMarket(msg) {
        const assetIds = msg.assets_ids || [];
        const question = msg.question || 'New Market';
        const conditionId = msg.market;
        const outcomes = msg.outcomes || ['Yes', 'No'];
        if (assetIds.length !== 2)
            return;
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
                    isYesToken: outcomes[i]?.toLowerCase() === 'yes' || i === 0,
                    pairedTokenId: assetIds[i === 0 ? 1 : 0],
                    status: 'active',
                    acceptingOrders: true
                });
            }
        }
        if (assetIds.length > 0 && this.ws?.readyState === 1) {
            this.subscribeToTokens(assetIds);
            this.logger.success(`✨ Subscribed to new market: ${question.slice(0, 50)}...`);
        }
    }
    handlePriceChange(msg) {
        const priceChanges = msg.price_changes || [];
        for (const change of priceChanges) {
            const tokenId = change.asset_id;
            const market = this.trackedMarkets.get(tokenId);
            if (!market)
                continue;
            if (change.best_bid)
                market.bestBid = parseFloat(change.best_bid);
            if (change.best_ask)
                market.bestAsk = parseFloat(change.best_ask);
            market.spread = market.bestAsk - market.bestBid;
            this.evaluateOpportunity(market);
        }
    }
    handleLastTradePrice(msg) {
        const tokenId = msg.asset_id;
        const price = parseFloat(msg.price);
        const market = this.trackedMarkets.get(tokenId);
        if (!market)
            return;
        const lastMid = this.lastMidpoints.get(tokenId);
        if (lastMid && lastMid > 0) {
            const movePct = Math.abs(price - lastMid) / lastMid * 100;
            if (movePct > this.config.priceMoveThresholdPct) {
                this.logger.warn(`🔴 FLASH MOVE: ${movePct.toFixed(1)}% on ${market.question.slice(0, 30)}...`);
                if (this.config.enableKillSwitch) {
                    this.triggerKillSwitch(`Volatility spike on ${market.tokenId}`);
                }
            }
        }
        this.lastMidpoints.set(tokenId, price);
    }
    handleMarketResolved(msg) {
        const conditionId = msg.market;
        const winningOutcome = msg.winning_outcome;
        const winningAssetId = msg.winning_asset_id;
        const question = msg.question || 'Unknown';
        if (this.resolvedMarkets.has(conditionId))
            return;
        this.resolvedMarkets.add(conditionId);
        this.logger.info(`🏁 MARKET RESOLVED: ${question}`);
        this.logger.info(`🏆 Winner: ${winningOutcome} (${winningAssetId})`);
        for (const [tokenId, market] of this.trackedMarkets.entries()) {
            if (market.conditionId === conditionId) {
                this.trackedMarkets.delete(tokenId);
            }
        }
        this.opportunities = this.opportunities.filter(o => o.conditionId !== conditionId);
        this.emit('marketResolved', {
            conditionId,
            winningOutcome,
            winningAssetId,
            question
        });
    }
    handleTickSizeChange(msg) {
        const tokenId = msg.asset_id;
        const oldTickSize = msg.old_tick_size;
        const newTickSize = msg.new_tick_size;
        this.tickSizes.set(tokenId, {
            tokenId,
            tickSize: newTickSize,
            updatedAt: Date.now()
        });
        this.logger.warn(`📏 TICK SIZE CHANGE: ${tokenId} | ${oldTickSize} → ${newTickSize}`);
        this.emit('tickSizeChange', {
            tokenId,
            oldTickSize,
            newTickSize
        });
    }
    // FIX: Renamed evaluateOpportunityInternal to evaluateOpportunity to match message handler calls
    evaluateOpportunity(market) {
        const spreadCents = market.spread * 100;
        const midpoint = (market.bestBid + market.bestAsk) / 2;
        if (market.bestBid <= 0 || market.bestAsk >= 1 || market.bestAsk <= market.bestBid) {
            return;
        }
        if (market.status !== 'active' || !market.acceptingOrders) {
            return;
        }
        const ageMinutes = (Date.now() - market.discoveredAt) / (1000 * 60);
        const isStillNew = market.isNew && ageMinutes < this.config.newMarketAgeMinutes;
        const effectiveMinVolume = isStillNew ? 0 : this.config.minVolume;
        if (spreadCents < this.config.minSpreadCents)
            return;
        if (spreadCents > this.config.maxSpreadCents)
            return;
        if (market.volume < effectiveMinVolume)
            return;
        const spreadPct = midpoint > 0 ? (market.spread / midpoint) * 100 : 0;
        const skew = this.getInventorySkew(market.conditionId);
        const opportunity = {
            marketId: market.conditionId,
            conditionId: market.conditionId,
            tokenId: market.tokenId,
            question: market.question,
            image: market.image,
            marketSlug: market.marketSlug,
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
            skew,
            status: market.status,
            acceptingOrders: market.acceptingOrders,
            volume24hr: market.volume24hr,
            category: market.category,
            featured: market.featured,
            isBookmarked: this.bookmarkedMarkets.has(market.conditionId)
        };
        this.updateOpportunitiesInternal(opportunity);
    }
    async updateOpportunitiesInternal(opp) {
        const existingIdx = this.opportunities.findIndex(o => o.tokenId === opp.tokenId);
        if (existingIdx !== -1) {
            this.opportunities[existingIdx] = opp;
        }
        else {
            this.opportunities.push(opp);
        }
        try {
            await MoneyMarketOpportunity.findOneAndUpdate({ tokenId: opp.tokenId }, { ...opp, timestamp: new Date() }, { upsert: true });
        }
        catch (dbErr) { }
        this.opportunities.sort((a, b) => {
            if (a.isNew !== b.isNew)
                return a.isNew ? -1 : 1;
            return b.spreadCents - a.spreadCents;
        });
        this.emit('opportunity', opp);
    }
    updateOpportunities() {
        for (const [tokenId, market] of this.trackedMarkets.entries()) {
            this.evaluateOpportunity(market);
        }
    }
    startPing() {
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === 1) {
                this.ws.send('PING');
            }
        }, 10000);
    }
    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
    }
    handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max reconnection attempts reached');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
        this.logger.info(`Reconnecting in ${delay}ms (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        this.reconnectTimeout = setTimeout(() => {
            if (this.isScanning)
                this.connect();
        }, delay);
    }
    stop() {
        this.logger.info('🛑 Stopping market making scanner...');
        this.isScanning = false;
        this.isConnected = false;
        this.stopPing();
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
        if (this.ws) {
            const wsAny = this.ws;
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
    getOpportunities(maxAgeMs = 60000) {
        const now = Date.now();
        return this.opportunities.filter(o => now - o.timestamp < maxAgeMs);
    }
    getLatestOpportunities() {
        return this.getOpportunities();
    }
    getInventorySkew(conditionId) {
        const balance = this.inventoryBalances.get(conditionId);
        if (!balance)
            return 0;
        const total = balance.yes + balance.no;
        if (total === 0)
            return 0;
        return (balance.yes - balance.no) / total;
    }
    getTickSize(tokenId) {
        const info = this.tickSizes.get(tokenId);
        return info?.tickSize || '0.01';
    }
    triggerKillSwitch(reason) {
        if (!this.config.enableKillSwitch)
            return;
        this.killSwitchActive = true;
        this.logger.error(`🚨 KILL SWITCH TRIGGERED: ${reason}`);
        this.emit('killSwitch', { reason, timestamp: Date.now() });
    }
    resetKillSwitch() {
        this.killSwitchActive = false;
        this.logger.info('🔄 Kill switch reset');
    }
    isKillSwitchActive() {
        return this.killSwitchActive;
    }
    getTrackedMarket(tokenId) {
        return this.trackedMarkets.get(tokenId);
    }
}
