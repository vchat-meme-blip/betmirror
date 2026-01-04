import { IExchangeAdapter } from '../adapters/interfaces.js';
import { Logger } from '../utils/logger.util.js';
import { WS_URLS } from '../config/env.js';
import { MoneyMarketOpportunity } from '../database/index.js';
import EventEmitter from 'events';
// Use default import for WebSocket
import WebSocket from 'ws';
import type RawData from 'ws';

// Rate limiter utility
class RateLimiter {
    private lastRequestTime = 0;
    private delay: number;

    constructor(delayMs: number = 1500) {
        this.delay = delayMs;
    }

    async limit<T>(promise: () => Promise<T>): Promise<T> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.delay) {
            await new Promise(resolve => 
                setTimeout(resolve, this.delay - timeSinceLastRequest)
            );
        }

        this.lastRequestTime = Date.now();
        return await promise();
    }
}

// ============================================================
// INTERFACES (ENHANCED)
// ============================================================

export interface MarketOpportunity {
    marketId: string;
    conditionId: string;
    tokenId: string;
    question: string;
    image?: string;
    marketSlug?: string;
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
    // Inventory skew
    skew?: number;
    // NEW: Status & Metadata for UI
    status: 'active' | 'closed' | 'resolved' | 'paused';
    acceptingOrders: boolean;
    volume24hr?: number;
    category?: string;
    featured?: boolean;
    isBookmarked?: boolean;
}

interface TrackedMarket {
    conditionId: string;
    tokenId: string;
    question: string;
    image?: string;
    marketSlug?: string;
    bestBid: number;
    bestAsk: number;
    spread: number;
    volume: number;
    liquidity: number;
    isNew: boolean;
    discoveredAt: number;
    rewardsMaxSpread?: number;
    rewardsMinSize?: number;
    // Track YES/NO token mapping
    isYesToken?: boolean;
    pairedTokenId?: string;
    // NEW: Status & metadata
    status: 'active' | 'closed' | 'resolved' | 'paused';
    acceptingOrders: boolean;
    volume24hr?: number;
    orderMinSize?: number;
    orderPriceMinTickSize?: number;
    category?: string;
    featured?: boolean;
    competitive?: number;
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
    // Risk management config
    priceMoveThresholdPct: number;    // Cancel orders if price moves X%
    maxInventoryPerToken: number;      // Max USD exposure per token
    autoMergeThreshold: number;        // Merge when pairs exceed this
    enableKillSwitch: boolean;         // Enable emergency stop
}

// Risk Management Interfaces
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
// MAIN SCANNER CLASS (ENHANCED)
// ============================================================

export class MarketMakingScanner extends EventEmitter {
    // Core state
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
    private rateLimiter = new RateLimiter(1500); // 1.5 seconds between requests

    // Risk management state
    private lastMidpoints: Map<string, number> = new Map();
    private inventoryBalances: Map<string, InventoryBalance> = new Map();
    private tickSizes: Map<string, TickSizeInfo> = new Map();
    private resolvedMarkets: Set<string> = new Set();
    private killSwitchActive = false;
    private bookmarkedMarkets: Set<string> = new Set();

    // Default config (EXTENDED)
    private config: MarketMakerConfig = {
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

    constructor(
        private adapter: IExchangeAdapter,
        private logger: Logger,
        config?: Partial<MarketMakerConfig>
    ) {
        super();
        if (config) this.config = { ...this.config, ...config };
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
            // Debug API before discovery
            await this.debugApiResponse();
            
            await this.discoverMarkets();
            this.connect();
            
            this.refreshInterval = setInterval(() => {
                this.discoverMarkets();
            }, this.config.refreshIntervalMs);
            
            this.logger.success('📊 MM ENGINE: Spread Capture Mode Active');
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to start scanner:', err);
            this.isScanning = false;
            throw err;
        }
    }

    /**
     * Fetch available tag IDs from Gamma API
     */
    private async fetchTagIds(): Promise<Record<string, number>> {
        const tagMap: Record<string, number> = {};
        
        try {
            const response = await this.rateLimiter.limit(() => 
                fetch('https://gamma-api.polymarket.com/tags?limit=100')
            );
            
            if (!response.ok) {
                this.logger.warn('Failed to fetch tags, using defaults');
                return tagMap;
            }
            
            const tags = await response.json();
            
            // Map common category names to their IDs
            for (const tag of tags) {
                const slug = (tag.slug || tag.label || '').toLowerCase();
                const id = parseInt(tag.id);
                
                if (slug.includes('sport') || slug.includes('nfl') || slug.includes('nba')) {
                    tagMap.sports = tagMap.sports || id;
                }
                if (slug.includes('politic') || slug.includes('election')) {
                    tagMap.politics = tagMap.politics || id;
                }
                if (slug.includes('crypto') || slug.includes('bitcoin') || slug.includes('ethereum')) {
                    tagMap.crypto = tagMap.crypto || id;
                }
                if (slug.includes('business') || slug.includes('economy') || slug.includes('stock')) {
                    tagMap.business = tagMap.business || id;
                }
                if (slug.includes('entertainment') || slug.includes('celebrity')) {
                    tagMap.entertainment = tagMap.entertainment || id;
                }
            }
            
            this.logger.debug(`Found tag IDs: ${JSON.stringify(tagMap)}`);
            return tagMap;
            
        } catch (error) {
            this.logger.warn(`Failed to fetch tags: ${error}`);
            return tagMap;
        }
    }

    /**
     * PRODUCTION: Multi-source market discovery
     * Fetches from multiple endpoints to capture different market segments
     */
    private async discoverMarkets() {
        this.logger.info('📡 Discovering markets from Gamma API...');
        
        try {
            // Step 1: Fetch available tags to get tag IDs
            const tagIds = await this.fetchTagIds();
            
            // Step 2: Build endpoints with correct parameters
            const endpoints = [
                // High volume markets (most reliable)
                'https://gamma-api.polymarket.com/events?closed=false&limit=100&order=volume&ascending=false',
                
                // High liquidity markets
                'https://gamma-api.polymarket.com/events?closed=false&limit=100&order=liquidity&ascending=false',
                
                // Newest markets (recently created)
                'https://gamma-api.polymarket.com/events?closed=false&limit=50&order=id&ascending=false',
                
                // Category-specific using tag_id (if we have them)
                ...(tagIds.sports ? [`https://gamma-api.polymarket.com/events?closed=false&limit=100&tag_id=${tagIds.sports}&order=volume&ascending=false`] : []),
                ...(tagIds.politics ? [`https://gamma-api.polymarket.com/events?closed=false&limit=100&tag_id=${tagIds.politics}&order=volume&ascending=false`] : []),
                ...(tagIds.crypto ? [`https://gamma-api.polymarket.com/events?closed=false&limit=100&tag_id=${tagIds.crypto}&order=volume&ascending=false`] : []),
                ...(tagIds.business ? [`https://gamma-api.polymarket.com/events?closed=false&limit=50&tag_id=${tagIds.business}&order=volume&ascending=false`] : []),
            ];

            let addedCount = 0;
            const newTokenIds: string[] = [];
            const seenConditionIds = new Set<string>();

            for (const url of endpoints) {
                try {
                    this.logger.debug(`Fetching: ${url}`);
                    const response = await this.rateLimiter.limit(() => fetch(url));
                    
                    if (!response.ok) {
                        this.logger.debug(`Endpoint returned ${response.status}: ${url}`);
                        continue;
                    }
                    
                    const data = await response.json();
                    const events = Array.isArray(data) ? data : (data.data || []);
                    
                    this.logger.debug(`Got ${events.length} events from ${url.split('?')[0]}`);

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
                } catch (endpointError) {
                    this.logger.debug(`Endpoint error: ${url} - ${endpointError}`);
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

        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to discover markets:', err);
        }
    }

    /**
     * PRODUCTION: Process a single market from API response
     * Handles JSON string parsing for clobTokenIds, outcomes, outcomePrices
     */
    private processMarketData(
        market: any, 
        event: any, 
        seenConditionIds: Set<string>
    ): { added: boolean; tokenIds: string[] } {
        const result = { added: false, tokenIds: [] as string[] };

        // Get condition ID
        const conditionId = market.conditionId || market.condition_id;
        
        // DEBUG: Log first 5 markets to see filtering
        const debugCount = seenConditionIds.size;
        const shouldDebug = debugCount < 5;
        
        if (shouldDebug) {
            this.logger.info(`\n=== DEBUG MARKET #${debugCount + 1} ===`);
            this.logger.info(`Question: ${market.question?.slice(0, 60)}`);
            this.logger.info(`ConditionId: ${conditionId}`);
        }

        if (!conditionId) {
            if (shouldDebug) this.logger.warn(`❌ FILTERED: No conditionId`);
            return result;
        }
        
        if (seenConditionIds.has(conditionId)) {
            if (shouldDebug) this.logger.warn(`❌ FILTERED: Already seen`);
            return result;
        }

        // Check closed/inactive filters
        if (shouldDebug) {
            this.logger.info(`closed: ${market.closed} (type: ${typeof market.closed})`);
            this.logger.info(`acceptingOrders: ${market.acceptingOrders} (type: ${typeof market.acceptingOrders})`);
            this.logger.info(`active: ${market.active} (type: ${typeof market.active})`);
            this.logger.info(`archived: ${market.archived} (type: ${typeof market.archived})`);
        }

        if (market.closed === true) {
            if (shouldDebug) this.logger.warn(`❌ FILTERED: closed === true`);
            return result;
        }
        if (market.acceptingOrders === false) {
            if (shouldDebug) this.logger.warn(`❌ FILTERED: acceptingOrders === false`);
            return result;
        }
        if (market.active === false) {
            if (shouldDebug) this.logger.warn(`❌ FILTERED: active === false`);
            return result;
        }
        if (market.archived === true) {
            if (shouldDebug) this.logger.warn(`❌ FILTERED: archived === true`);
            return result;
        }

        // Parse volume/liquidity
        const volume = this.parseNumber(market.volumeNum || market.volume || market.volumeClob);
        const liquidity = this.parseNumber(market.liquidityNum || market.liquidity || market.liquidityClob);
        
        if (shouldDebug) {
            this.logger.info(`volume: ${volume} (raw: ${market.volume}, volumeNum: ${market.volumeNum})`);
            this.logger.info(`liquidity: ${liquidity} (raw: ${market.liquidity}, liquidityNum: ${market.liquidityNum})`);
        }

        if (volume < 100) {
            if (shouldDebug) this.logger.warn(`❌ FILTERED: volume ${volume} < 100`);
            return result;
        }
        if (liquidity < 100) {
            if (shouldDebug) this.logger.warn(`❌ FILTERED: liquidity ${liquidity} < 100`);
            return result;
        }

        // Parse clobTokenIds - THIS IS THE CRITICAL PART
        const rawTokenIds = market.clobTokenIds || market.clob_token_ids;
        
        if (shouldDebug) {
            this.logger.info(`clobTokenIds raw: ${rawTokenIds}`);
            this.logger.info(`clobTokenIds type: ${typeof rawTokenIds}`);
        }
        
        const tokenIds = this.parseJsonArray(rawTokenIds);
        
        if (shouldDebug) {
            this.logger.info(`Parsed tokenIds: ${JSON.stringify(tokenIds)}`);
            this.logger.info(`tokenIds length: ${tokenIds.length}`);
        }

        if (tokenIds.length === 0) {
            if (shouldDebug) this.logger.warn(`❌ FILTERED: No tokenIds parsed`);
            return result;
        }
        
        if (tokenIds.length !== 2) {
            if (shouldDebug) this.logger.warn(`❌ FILTERED: Non-binary (${tokenIds.length} tokens)`);
            return result;
        }

        // If we get here, market passed all filters!
        if (shouldDebug) {
            this.logger.success(`✅ PASSED ALL FILTERS!`);
        }

        // Mark as seen
        seenConditionIds.add(conditionId);

        // Parse outcomes and prices
        const outcomes = this.parseJsonArray(market.outcomes) || ['Yes', 'No'];
        const outcomePrices = this.parseJsonArray(market.outcomePrices);
        const status = this.computeMarketStatus(market);
        const volume24hr = this.parseNumber(market.volume24hr || market.volume24hrClob);

        // Process each token
        for (let i = 0; i < tokenIds.length; i++) {
            const tokenId = tokenIds[i];
            
            if (this.trackedMarkets.has(tokenId)) {
                const existing = this.trackedMarkets.get(tokenId)!;
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
                category: this.extractCategory(event, market),
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
    private parseJsonArray(value: any): string[] {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                return [];
            }
        }
        return [];
    }

    /**
     * PRODUCTION: Parse number from string or number
     */
    private parseNumber(value: any): number {
        if (typeof value === 'number') return value;
        if (typeof value === 'string') return parseFloat(value) || 0;
        return 0;
    }

    /**
     * PRODUCTION: Compute market status from API fields
     */
    private computeMarketStatus(market: any): 'active' | 'closed' | 'resolved' | 'paused' {
        if (market.closed === true) return 'closed';
        if (market.umaResolutionStatus === 'resolved') return 'resolved';
        if (market.acceptingOrders === false) return 'paused';
        return 'active';
    }

    /**
     * PRODUCTION: Check if market was created recently (within 24 hours)
     */
    private isRecentlyCreated(createdAt: string | undefined): boolean {
        if (!createdAt) return false;
        try {
            const created = new Date(createdAt).getTime();
            const now = Date.now();
            const hoursSinceCreation = (now - created) / (1000 * 60 * 60);
            return hoursSinceCreation < 24;
        } catch {
            return false;
        }
    }

    /**
     * PRODUCTION: Extract category from event tags array
     */
    private extractCategory(event: any, market?: any): string | undefined {
        // Check event tags first (array of { id, label, slug })
        if (event.tags && Array.isArray(event.tags) && event.tags.length > 0) {
            const tag = event.tags[0];
            return tag.slug || tag.label || undefined;
        }
        
        // Fallback: infer from slug
        const slug = (event.slug || market?.slug || '').toLowerCase();
        if (slug.includes('nfl') || slug.includes('nba') || slug.includes('super-bowl') || slug.includes('sport')) {
            return 'sports';
        }
        if (slug.includes('bitcoin') || slug.includes('ethereum') || slug.includes('crypto')) {
            return 'crypto';
        }
        if (slug.includes('election') || slug.includes('president') || slug.includes('trump') || slug.includes('biden')) {
            return 'politics';
        }
        if (slug.includes('stock') || slug.includes('company') || slug.includes('business')) {
            return 'business';
        }
        
        return undefined;
    }

    /**
     * Debug method to test API responses
     */
    async debugApiResponse() {
        try {
            // Test basic endpoint
            const response = await fetch(
                'https://gamma-api.polymarket.com/events?closed=false&limit=5&order=volume&ascending=false'
            );
            const data = await response.json();
            
            this.logger.info('=== API TEST ===');
            this.logger.info(`Events count: ${data.length}`);
            
            if (data[0]) {
                this.logger.info(`First event: ${data[0].title}`);
                this.logger.info(`Markets count: ${data[0].markets?.length}`);
                
                if (data[0].markets?.[0]) {
                    const m = data[0].markets[0];
                    this.logger.info(`First market question: ${m.question}`);
                    this.logger.info(`clobTokenIds type: ${typeof m.clobTokenIds}`);
                    this.logger.info(`clobTokenIds value: ${m.clobTokenIds}`);
                    this.logger.info(`Parsed tokens: ${JSON.stringify(this.parseJsonArray(m.clobTokenIds))}`);
                    this.logger.info(`Volume: ${m.volume} ${m.volumeNum}`);
                    this.logger.info(`Closed: ${m.closed}`);
                    this.logger.info(`AcceptingOrders: ${m.acceptingOrders}`);
                }
            }
            
            // Test tags endpoint
            const tagsResponse = await fetch('https://gamma-api.polymarket.com/tags?limit=20');
            const tags = await tagsResponse.json();
            this.logger.info('\n=== TAGS ===');
            this.logger.info(`Sample tags: ${tags.slice(0, 5).map((t: any) => `${t.id}: ${t.slug}`).join(', ')}`);
            
        } catch (e) {
            this.logger.error(`API test failed: ${e}`);
        }
    }

    /**
     * PRODUCTION: Manually add a market by condition ID
     */
    async addMarketByConditionId(conditionId: string): Promise<boolean> {
        try {
            const response = await fetch(
                `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`
            );
            
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
            const seenConditionIds = new Set<string>();
            const result = this.processMarketData(market, { title: market.question }, seenConditionIds);
            
            if (result.added && result.tokenIds.length > 0) {
                if (this.ws?.readyState === 1) {
                    this.subscribeToTokens(result.tokenIds);
                }
                this.logger.success(`✅ Manually added market: ${market.question?.slice(0, 50)}...`);
                return true;
            }
            
            return false;
        } catch (error) {
            this.logger.error(`Failed to add market: ${error}`);
            return false;
        }
    }

    /**
     * PRODUCTION: Manually add a market by slug
     */
    async addMarketBySlug(slug: string): Promise<boolean> {
        try {
            const response = await fetch(
                `https://gamma-api.polymarket.com/markets/slug/${slug}`
            );
            
            if (!response.ok) {
                this.logger.warn(`Market not found: ${slug}`);
                return false;
            }
            
            const market = await response.json();
            if (!market || !market.conditionId) {
                this.logger.warn(`Market not found by slug: ${slug}`);
                return false;
            }

            const seenConditionIds = new Set<string>();
            const result = this.processMarketData(market, { title: market.question }, seenConditionIds);
            
            if (result.added && result.tokenIds.length > 0) {
                if (this.ws?.readyState === 1) {
                    this.subscribeToTokens(result.tokenIds);
                }
                this.logger.success(`✅ Manually added market: ${market.question?.slice(0, 50)}...`);
                return true;
            }
            
            return false;
        } catch (error) {
            this.logger.error(`Failed to add market by slug: ${error}`);
            return false;
        }
    }

    /**
     * Bookmark a market for priority tracking
     */
    bookmarkMarket(conditionId: string): void {
        this.bookmarkedMarkets.add(conditionId);
        this.logger.info(`📌 Bookmarked market: ${conditionId}`);
    }

    /**
     * Remove bookmark
     */
    unbookmarkMarket(conditionId: string): void {
        this.bookmarkedMarkets.delete(conditionId);
        this.logger.info(`📌 Unbookmarked market: ${conditionId}`);
    }

    /**
     * Get bookmarked opportunities
     */
    getBookmarkedOpportunities(): MarketOpportunity[] {
        return this.opportunities.filter(o => 
            this.bookmarkedMarkets.has(o.conditionId)
        );
    }

    /**
     * Check if market is bookmarked
     */
    isBookmarked(conditionId: string): boolean {
        return this.bookmarkedMarkets.has(conditionId);
    }

    private connect() {
        if (!this.isScanning) return;

        const wsUrl = `${WS_URLS.CLOB}/ws/market`;
        this.logger.info(`🔌 Connecting to ${wsUrl}`);
        this.ws = new WebSocket(wsUrl);

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

    private subscribeToAllTrackedTokens() {
        if (!this.ws || this.ws.readyState !== 1) return;

        const assetIds = Array.from(this.trackedMarkets.keys());
        
        const subscribeMsg = {
            type: 'market',
            assets_ids: assetIds,
            custom_feature_enabled: true 
        };

        this.ws.send(JSON.stringify(subscribeMsg));
        this.logger.info(`📡 Subscribed to ${assetIds.length} tokens with custom features enabled`);
    }

    private subscribeToTokens(tokenIds: string[]) {
        if (!this.ws || this.ws.readyState !== 1 || tokenIds.length === 0) return;

        this.ws.send(JSON.stringify({
            assets_ids: tokenIds,
            operation: 'subscribe'
        }));
        
        this.logger.debug(`📡 Subscribed to ${tokenIds.length} additional tokens`);
    }

    private processMessage(msg: any) {
        if (!msg?.event_type) return;

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
                
                if (this.config.enableKillSwitch) {
                    this.triggerKillSwitch(`Volatility spike on ${market.tokenId}`);
                }
            }
        }

        this.lastMidpoints.set(tokenId, price);
    }

    private handleMarketResolved(msg: any) {
        const conditionId = msg.market;
        const winningOutcome = msg.winning_outcome;
        const winningAssetId = msg.winning_asset_id;
        const question = msg.question || 'Unknown';

        if (this.resolvedMarkets.has(conditionId)) return;
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

        this.emit('tickSizeChange', {
            tokenId,
            oldTickSize,
            newTickSize
        });
    }

    // FIX: Renamed evaluateOpportunityInternal to evaluateOpportunity to match message handler calls
    private evaluateOpportunity(market: TrackedMarket) {
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

    private async updateOpportunitiesInternal(opp: MarketOpportunity) {
        const existingIdx = this.opportunities.findIndex(o => o.tokenId === opp.tokenId);
        if (existingIdx !== -1) {
            this.opportunities[existingIdx] = opp;
        } else {
            this.opportunities.push(opp);
        }

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
        for (const [tokenId, market] of this.trackedMarkets.entries()) {
            this.evaluateOpportunity(market);
        }
    }

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

    getOpportunities(maxAgeMs = 60000): MarketOpportunity[] {
        const now = Date.now();
        return this.opportunities.filter(o => now - o.timestamp < maxAgeMs);
    }

    getLatestOpportunities(): MarketOpportunity[] {
        return this.getOpportunities();
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

    getTrackedMarket(tokenId: string): TrackedMarket | undefined {
        return this.trackedMarkets.get(tokenId);
    }
}
