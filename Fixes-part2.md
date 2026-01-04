# Complete Audit & Production-Ready Fixes

Based on your full codebase context, here's the comprehensive analysis and production-ready code.

---

## Critical Issue #1: `clobTokenIds` is a JSON String (NOT an Array)

**File:** `market-making-scanner.ts`
**Line:** ~150-155

### Evidence from Logs
```javascript
"clobTokenIds": "[\"87918864...\", \"13650729...\"]"  // STRING, not array!
```

### Current Broken Code
```typescript
const tokenIds: string[] = market.clobTokenIds || 
                            market.clob_token_ids || 
                            market.tokenIds || [];
```

This returns an empty array because `market.clobTokenIds` is truthy (it's a string), but it's not an array.

---

## Critical Issue #2: Single Endpoint Limits Discovery

You only fetch from one endpoint, missing Sports, Trending, Breaking markets.

---

## Critical Issue #3: Missing UI Data Fields

`volume`, `liquidity`, `image` exist in API but aren't being passed correctly to UI.

---

## Production-Ready Scanner Replacement

Replace your entire `discoverMarkets()` method and add the helper methods below:

```typescript
// ============================================================
// REPLACE: discoverMarkets() method in market-making-scanner.ts
// ============================================================

/**
 * PRODUCTION: Multi-source market discovery
 * Fetches from multiple endpoints to capture Sports, Trending, Breaking markets
 */
private async discoverMarkets() {
    this.logger.info('📡 Discovering markets from Gamma API...');
    
    try {
        // Multi-source discovery for comprehensive coverage
        const endpoints = [
            // High volume (general)
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=volume&ascending=false',
            // High liquidity
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&order=liquidity&ascending=false',
            // Sports markets (great spreads!)
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&tag=sports&order=volume&ascending=false',
            // Crypto markets
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&tag=crypto&order=volume&ascending=false',
            // Politics
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&tag=politics&order=volume&ascending=false',
            // Recently created (new markets have wide spreads)
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=30&order=startDate&ascending=false',
        ];

        let addedCount = 0;
        const newTokenIds: string[] = [];
        const seenConditionIds = new Set<string>();

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
            } catch (endpointError) {
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
    if (!conditionId || seenConditionIds.has(conditionId)) {
        return result;
    }

    // CRITICAL FILTER: Skip closed/inactive/paused markets
    if (market.closed === true) return result;
    if (market.acceptingOrders === false) return result;
    if (market.active === false) return result;
    if (market.archived === true) return result;

    // Parse volume/liquidity (can be string or number)
    const volume = this.parseNumber(market.volumeNum || market.volume || market.volumeClob);
    const liquidity = this.parseNumber(market.liquidityNum || market.liquidity || market.liquidityClob);
    const volume24hr = this.parseNumber(market.volume24hr || market.volume24hrClob);

    // Apply volume/liquidity filters
    if (volume < this.config.minVolume) return result;
    if (liquidity < this.config.minLiquidity) return result;

    // FIX: Parse clobTokenIds - IT'S A JSON STRING!
    const tokenIds = this.parseJsonArray(market.clobTokenIds || market.clob_token_ids);
    if (tokenIds.length !== 2) return result; // Binary markets only

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
            const existing = this.trackedMarkets.get(tokenId)!;
            existing.volume = volume;
            existing.liquidity = liquidity;
            existing.bestBid = market.bestBid || existing.bestBid;
            existing.bestAsk = market.bestAsk || existing.bestAsk;
            existing.spread = market.spread || existing.spread;
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
            // NEW: Additional metadata
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
 * Handles both string and array inputs
 */
private parseJsonArray(value: any): string[] {
    if (!value) return [];
    
    if (Array.isArray(value)) {
        return value;
    }
    
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
 * PRODUCTION: Extract category from event tags
 */
private extractCategory(event: any): string | undefined {
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

// ============================================================
// ADD: Manual Market Entry Methods
// ============================================================

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
            // Subscribe to WebSocket
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
            `https://gamma-api.polymarket.com/markets?slug=${slug}`
        );
        
        if (!response.ok) {
            this.logger.warn(`Market not found: ${slug}`);
            return false;
        }
        
        const markets = await response.json();
        if (!markets || markets.length === 0) {
            this.logger.warn(`Market not found: ${slug}`);
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
        this.logger.error(`Failed to add market by slug: ${error}`);
        return false;
    }
}

// ============================================================
// ADD: Bookmark System
// ============================================================

private bookmarkedMarkets: Set<string> = new Set();

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
    return this.getOpportunities().filter(o => 
        this.bookmarkedMarkets.has(o.conditionId)
    );
}

/**
 * Check if market is bookmarked
 */
isBookmarked(conditionId: string): boolean {
    return this.bookmarkedMarkets.has(conditionId);
}

/**
 * Get all bookmarked condition IDs
 */
getBookmarkedMarketIds(): string[] {
    return Array.from(this.bookmarkedMarkets);
}
```

---

## Updated TrackedMarket Interface

Replace your `TrackedMarket` interface:

```typescript
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
    // Token pair tracking
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
```

---

## Updated MarketOpportunity Interface

Replace your `MarketOpportunity` interface:

```typescript
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
    // NEW: Status & metadata for UI
    status: 'active' | 'closed' | 'resolved' | 'paused';
    acceptingOrders: boolean;
    volume24hr?: number;
    category?: string;
    featured?: boolean;
    isBookmarked?: boolean;
}
```

---

## Updated evaluateOpportunity Method

Replace your `evaluateOpportunity` method to include new fields:

```typescript
private evaluateOpportunity(market: TrackedMarket) {
    const spreadCents = market.spread * 100;
    const midpoint = (market.bestBid + market.bestAsk) / 2;

    // Skip invalid prices
    if (market.bestBid <= 0 || market.bestAsk >= 1 || market.bestAsk <= market.bestBid) {
        return;
    }

    // Skip non-active markets
    if (market.status !== 'active' || !market.acceptingOrders) {
        return;
    }

    const ageMinutes = (Date.now() - market.discoveredAt) / (1000 * 60);
    const isStillNew = market.isNew && ageMinutes < this.config.newMarketAgeMinutes;
    const effectiveMinVolume = isStillNew ? 0 : this.config.minVolume;

    // Apply spread filters
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
        // NEW: Status & metadata
        status: market.status,
        acceptingOrders: market.acceptingOrders,
        volume24hr: market.volume24hr,
        category: market.category,
        featured: market.featured,
        isBookmarked: this.bookmarkedMarkets.has(market.conditionId)
    };

    this.updateOpportunitiesInternal(opportunity);
}
```

---

## Bot Engine Integration

Add these methods to expose scanner functionality in `bot-engine.ts`:

```typescript
// Add to BotEngine class

/**
 * Manually add a market to MM scanner by condition ID
 */
public async addMarketToMM(conditionId: string): Promise<boolean> {
    if (!this.arbScanner) {
        this.addLog('warn', 'MM Scanner not initialized');
        return false;
    }
    return this.arbScanner.addMarketByConditionId(conditionId);
}

/**
 * Manually add a market to MM scanner by slug
 */
public async addMarketBySlug(slug: string): Promise<boolean> {
    if (!this.arbScanner) {
        this.addLog('warn', 'MM Scanner not initialized');
        return false;
    }
    return this.arbScanner.addMarketBySlug(slug);
}

/**
 * Bookmark a market for priority tracking
 */
public bookmarkMarket(conditionId: string): void {
    this.arbScanner?.bookmarkMarket(conditionId);
}

/**
 * Unbookmark a market
 */
public unbookmarkMarket(conditionId: string): void {
    this.arbScanner?.unbookmarkMarket(conditionId);
}

/**
 * Get bookmarked opportunities
 */
public getBookmarkedOpportunities(): ArbitrageOpportunity[] {
    return this.arbScanner?.getBookmarkedOpportunities().map(o => ({
        ...o,
        marketId: o.conditionId,
        roi: o.spreadPct,
        combinedCost: 1 - o.spread,
        capacityUsd: o.liquidity || 0
    } as ArbitrageOpportunity)) || [];
}

/**
 * Get opportunities by category
 */
public getOpportunitiesByCategory(category: string): ArbitrageOpportunity[] {
    return this.arbScanner?.getOpportunities()
        .filter(o => o.category === category)
        .map(o => ({
            ...o,
            marketId: o.conditionId,
            roi: o.spreadPct,
            combinedCost: 1 - o.spread,
            capacityUsd: o.liquidity || 0
        } as ArbitrageOpportunity)) || [];
}
```

---

## Summary of All Fixes

| Issue | File | Fix |
|-------|------|-----|
| **Zero markets discovered** | `market-making-scanner.ts` | Parse `clobTokenIds` as JSON string |
| **Missing Sports/Trending** | `market-making-scanner.ts` | Multi-endpoint discovery |
| **Missing images in UI** | `market-making-scanner.ts` | Use `image \|\| icon \|\| event.image` |
| **No manual market entry** | `market-making-scanner.ts` | Add `addMarketByConditionId()`, `addMarketBySlug()` |
| **No bookmark system** | `market-making-scanner.ts` | Add bookmark methods |
| **No market status** | Interfaces + `evaluateOpportunity()` | Add `status`, `acceptingOrders` fields |
| **Missing volume/liquidity** | `processMarketData()` | Parse all numeric fields correctly |

---

## Draft Email for Polymarket Support

Save this as `polymarket-api-questions.txt`:

```
Subject: Gamma API - Market Discovery & Data Format Questions

Hi Polymarket Team,

We're building a market making system using the Gamma API and have a few questions:

1. **Category/Tag Values**: What are all available `tag` parameter values for 
   the `/events` endpoint? We've identified: sports, politics, crypto, 
   entertainment. Are there others?

2. **Trending/Breaking Endpoint**: Is there a dedicated endpoint or parameter 
   to fetch "trending" or "breaking" markets? These often have excellent 
   spreads for market making.

3. **clobTokenIds Format**: We noticed `clobTokenIds` is returned as a JSON 
   string rather than an array:
   `"clobTokenIds": "[\"token1\", \"token2\"]"`
   Is this intentional? Should we always JSON.parse() this field?

4. **Spread Field**: The `spread` field in market responses - is this the 
   current live spread or a calculated/historical value?

5. **Rate Limits**: What are the rate limits for:
   - Gamma API (events/markets endpoints)
   - CLOB WebSocket subscriptions
   - Order placement

6. **Best Practices**: Any recommendations for market makers regarding:
   - Optimal refresh intervals for market discovery
   - Maximum number of simultaneous WebSocket subscriptions

Thank you for your help!

Best regards,
[Your Name]
```

---

## Testing Checklist

After implementing these fixes:

1. ✅ Run scanner and verify `Tracking X tokens` shows > 0
2. ✅ Check logs for Sports markets being discovered
3. ✅ Verify UI cards show images, volume, liquidity
4. ✅ Test manual market entry with a known condition ID
5. ✅ Test bookmark functionality
6. ✅ Verify market status displays correctly