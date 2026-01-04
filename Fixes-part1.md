# Market Making Scanner - Complete Audit & Improvement Plan

## Executive Summary

Your scanner is discovering **0 markets** because the `clobTokenIds` field in the Gamma API response is a **JSON string**, not an array. The parsing fails silently.

---

## Issue #1: Zero Markets Discovered (CRITICAL)

### Root Cause
**File:** `market-making-scanner.ts`
**Line:** ~150-155

```typescript
// CURRENT CODE (BROKEN):
const tokenIds: string[] = market.clobTokenIds || 
                            market.clob_token_ids || 
                            market.tokenIds || [];
```

### Evidence from Logs
```
"clobTokenIds": "[\"87918864565491471386671337550198987821013545780599955289795581515743085459873\", \"13650729373396863503149204494735335464119911986355339951778806205194377721658\"]"
```

The `clobTokenIds` is a **string** (note the outer quotes), not an array!

### Fix
```typescript
// FIXED CODE:
let tokenIds: string[] = [];
const rawTokenIds = market.clobTokenIds || market.clob_token_ids || market.tokenIds;
if (typeof rawTokenIds === 'string') {
    try {
        tokenIds = JSON.parse(rawTokenIds);
    } catch (e) {
        tokenIds = [];
    }
} else if (Array.isArray(rawTokenIds)) {
    tokenIds = rawTokenIds;
}
```

---

## Issue #2: Missing Category/Tag Filtering

### Current Limitation
You only fetch from one endpoint with no category filtering:
```typescript
// Line ~130
const response = await fetch(
    'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=volume&ascending=false'
);
```

### Available Categories (from Polymarket)
- `sports` - NFL, NBA, Soccer, etc.
- `politics` - Elections, policy
- `crypto` - Bitcoin, Ethereum prices
- `entertainment` - Movies, TV, celebrities
- `science` - Weather, space
- `business` - Stocks, companies

### Fix: Multi-Category Discovery
```typescript
private async discoverMarkets() {
    const categories = ['sports', 'politics', 'crypto', 'entertainment'];
    const endpoints = [
        // High volume across all
        'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=volume&ascending=false',
        // Trending/Breaking
        'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&order=liquidity&ascending=false',
        // By category
        ...categories.map(cat => 
            `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&tag=${cat}&order=volume&ascending=false`
        )
    ];

    for (const url of endpoints) {
        await this.fetchAndProcessMarkets(url);
    }
}
```

---

## Issue #3: UI Cards Missing Volume/Liquidity/Images

### Root Cause
**File:** `market-making-scanner.ts`
**Lines:** ~160-180

The `image` field exists in the API but may not be passed correctly:

```typescript
// CURRENT:
image: market.image || '',
```

### Evidence from Logs
```
"image": "https://polymarket-upload.s3.us-east-2.amazonaws.com/NFL+Team+Logos/BAL.png",
"icon": "https://polymarket-upload.s3.us-east-2.amazonaws.com/NFL+Team+Logos/BAL.png",
```

### Fix: Use Both Fields
```typescript
image: market.image || market.icon || event.image || '',
```

### TrackedMarket Interface Update
```typescript
interface TrackedMarket {
    // ... existing fields
    image?: string;
    icon?: string;
    volume24hr?: number;
    liquidity?: number;
    bestBid?: number;
    bestAsk?: number;
    spread?: number;
    // NEW: Additional metadata
    category?: string;
    featured?: boolean;
    competitive?: number;
}
```

---

## Issue #4: Manual Market Entry Not Supported

### Current State
No method exists to manually add a market by condition ID or slug.

### Fix: Add Manual Entry Method
```typescript
/**
 * Manually add a market by condition ID
 */
async addMarketManually(conditionId: string): Promise<boolean> {
    try {
        const response = await fetch(
            `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`
        );
        const markets = await response.json();
        
        if (!markets || markets.length === 0) {
            this.logger.warn(`Market not found: ${conditionId}`);
            return false;
        }

        const market = markets[0];
        await this.processMarket(market, { title: market.question });
        return true;
    } catch (error) {
        this.logger.error(`Failed to add market: ${error}`);
        return false;
    }
}

/**
 * Add market by slug (e.g., "will-the-buffalo-bills-win-super-bowl-2026")
 */
async addMarketBySlug(slug: string): Promise<boolean> {
    try {
        const response = await fetch(
            `https://gamma-api.polymarket.com/markets?slug=${slug}`
        );
        const markets = await response.json();
        
        if (!markets || markets.length === 0) {
            this.logger.warn(`Market not found: ${slug}`);
            return false;
        }

        const market = markets[0];
        await this.processMarket(market, { title: market.question });
        return true;
    } catch (error) {
        this.logger.error(`Failed to add market: ${error}`);
        return false;
    }
}
```

---

## Issue #5: Bookmark System Missing

### Fix: Add Bookmark Support
```typescript
// Add to class state
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
```

---

## Issue #6: Market Status Not Indicated

### Available Status Fields from API
```
"closed": false,
"active": true,
"acceptingOrders": true,
"archived": false,
"resolved": false,
"umaResolutionStatus": "proposed" | "resolved" | null
```

### Fix: Add Status to Interfaces
```typescript
// Update MarketOpportunity interface
export interface MarketOpportunity {
    // ... existing fields
    
    // NEW: Status fields
    status: 'active' | 'closed' | 'resolved' | 'paused';
    acceptingOrders: boolean;
    isBookmarked?: boolean;
}

// Update TrackedMarket interface
interface TrackedMarket {
    // ... existing fields
    
    // NEW: Status tracking
    status: 'active' | 'closed' | 'resolved' | 'paused';
    acceptingOrders: boolean;
}
```

### Fix: Compute Status
```typescript
private computeMarketStatus(market: any): 'active' | 'closed' | 'resolved' | 'paused' {
    if (market.closed === true) return 'closed';
    if (market.resolved === true || market.umaResolutionStatus === 'resolved') return 'resolved';
    if (market.acceptingOrders === false) return 'paused';
    return 'active';
}
```

---

## Complete Data Fields Available (from your logs)

### Event Level
| Field | Type | Use For |
|-------|------|---------|
| `title` | string | Event name |
| `slug` | string | URL identifier |
| `image` | string | Event image |
| `volume` | number | Total event volume |
| `liquidity` | number | Total event liquidity |
| `featured` | boolean | Highlight in UI |
| `competitive` | number | Competition score |

### Market Level
| Field | Type | Use For |
|-------|------|---------|
| `conditionId` | string | Unique market ID |
| `question` | string | Market question |
| `slug` | string | URL slug |
| `image` / `icon` | string | Market image |
| `volume` | string | Total volume (parse to number) |
| `volumeNum` | number | Volume as number |
| `volume24hr` | number | 24h volume |
| `liquidity` | string | Liquidity (parse to number) |
| `liquidityNum` | number | Liquidity as number |
| `clobTokenIds` | string (JSON) | Token IDs (PARSE THIS!) |
| `outcomes` | string (JSON) | ["Yes", "No"] |
| `outcomePrices` | string (JSON) | Current prices |
| `bestBid` | number | Best bid price |
| `bestAsk` | number | Best ask price |
| `spread` | number | Current spread |
| `closed` | boolean | Is closed |
| `active` | boolean | Is active |
| `acceptingOrders` | boolean | Can trade |
| `rewardsMaxSpread` | number | Max spread for rewards |
| `rewardsMinSize` | number | Min size for rewards |
| `orderMinSize` | number | Minimum order size |
| `orderPriceMinTickSize` | number | Tick size |
| `negRisk` | boolean | Negative risk market |

---

## Complete Fixed `discoverMarkets()` Method

```typescript
private async discoverMarkets() {
    this.logger.info('📡 Discovering markets from Gamma API...');
    
    try {
        // Fetch from multiple sources
        const endpoints = [
            // High volume
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=volume&ascending=false',
            // High liquidity
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&order=liquidity&ascending=false',
            // Sports
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&tag=sports&order=volume&ascending=false',
            // Trending (by 24h volume)
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&order=volume24hr&ascending=false',
        ];

        let addedCount = 0;
        const newTokenIds: string[] = [];
        const seenConditionIds = new Set<string>();

        for (const url of endpoints) {
            try {
                const response = await fetch(url);
                if (!response.ok) continue;
                
                const data = await response.json();
                const events = Array.isArray(data) ? data : (data.data || []);

                for (const event of events) {
                    const markets = event.markets || [];
                    
                    for (const market of markets) {
                        // Skip already processed
                        const conditionId = market.conditionId || market.condition_id;
                        if (!conditionId || seenConditionIds.has(conditionId)) continue;
                        seenConditionIds.add(conditionId);

                        // CRITICAL FILTER: Skip closed/inactive markets
                        if (market.closed === true) continue;
                        if (market.acceptingOrders === false) continue;
                        if (market.active === false) continue;

                        // Parse volume/liquidity (can be string or number)
                        const volume = parseFloat(market.volumeNum || market.volume || '0');
                        const liquidity = parseFloat(market.liquidityNum || market.liquidity || '0');
                        const volume24hr = parseFloat(market.volume24hr || market.volume24hrClob || '0');

                        // Apply filters
                        if (volume < this.config.minVolume) continue;
                        if (liquidity < this.config.minLiquidity) continue;

                        // FIX: Parse clobTokenIds (it's a JSON string!)
                        let tokenIds: string[] = [];
                        const rawTokenIds = market.clobTokenIds || market.clob_token_ids;
                        if (typeof rawTokenIds === 'string') {
                            try {
                                tokenIds = JSON.parse(rawTokenIds);
                            } catch (e) {
                                continue; // Skip if can't parse
                            }
                        } else if (Array.isArray(rawTokenIds)) {
                            tokenIds = rawTokenIds;
                        }
                        
                        // Binary markets only
                        if (tokenIds.length !== 2) continue;

                        // Parse outcomes
                        let outcomes: string[] = ['Yes', 'No'];
                        if (typeof market.outcomes === 'string') {
                            try {
                                outcomes = JSON.parse(market.outcomes);
                            } catch (e) {}
                        } else if (Array.isArray(market.outcomes)) {
                            outcomes = market.outcomes;
                        }

                        // Compute status
                        const status = this.computeMarketStatus(market);

                        for (let i = 0; i < tokenIds.length; i++) {
                            const tokenId = tokenIds[i];
                            
                            if (this.trackedMarkets.has(tokenId)) {
                                // Update existing
                                const existing = this.trackedMarkets.get(tokenId)!;
                                existing.volume = volume;
                                existing.liquidity = liquidity;
                                existing.bestBid = market.bestBid || existing.bestBid;
                                existing.bestAsk = market.bestAsk || existing.bestAsk;
                                existing.spread = market.spread || existing.spread;
                                continue;
                            }

                            const isYesToken = outcomes[i]?.toLowerCase() === 'yes' || i === 0;
                            const pairedTokenId = tokenIds[i === 0 ? 1 : 0];

                            this.trackedMarkets.set(tokenId, {
                                conditionId,
                                tokenId,
                                question: market.question || event.title || 'Unknown',
                                image: market.image || market.icon || event.image || '',
                                marketSlug: market.slug || '',
                                bestBid: market.bestBid || 0,
                                bestAsk: market.bestAsk || 0,
                                spread: market.spread || 0,
                                volume,
                                liquidity,
                                isNew: market.new === true,
                                discoveredAt: Date.now(),
                                rewardsMaxSpread: market.rewardsMaxSpread,
                                rewardsMinSize: market.rewardsMinSize,
                                isYesToken,
                                pairedTokenId,
                                // NEW fields
                                status,
                                acceptingOrders: market.acceptingOrders !== false
                            });

                            newTokenIds.push(tokenId);
                            addedCount++;
                        }
                    }
                }
            } catch (e) {
                // Continue to next endpoint
            }
        }

        this.logger.info(`✅ Tracking ${this.trackedMarkets.size} tokens (${addedCount} new) | Min volume: $${this.config.minVolume}`);

        if (newTokenIds.length > 0 && this.ws?.readyState === 1) {
            this.subscribeToTokens(newTokenIds);
        }

        // Trigger initial opportunity evaluation
        this.updateOpportunities();

    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error('❌ Failed to discover markets:', err);
    }
}

private computeMarketStatus(market: any): 'active' | 'closed' | 'resolved' | 'paused' {
    if (market.closed === true) return 'closed';
    if (market.umaResolutionStatus === 'resolved') return 'resolved';
    if (market.acceptingOrders === false) return 'paused';
    return 'active';
}
```

---

## Draft Email for Polymarket Support

```
Subject: Gamma API - Market Discovery Questions

Hi Polymarket Team,

We're building a market making bot using the Gamma API and have a few questions:

1. **Category/Tag Filtering**: What are all available `tag` values for the 
   `/events` endpoint? We've tried `sports`, `politics`, `crypto` but want 
   to ensure we're not missing any.

2. **Trending/Breaking Markets**: Is there an endpoint or parameter to fetch 
   "trending" or "breaking" markets specifically? We noticed these often have 
   great spreads.

3. **clobTokenIds Format**: We noticed `clobTokenIds` is returned as a JSON 
   string rather than an array. Is this intentional? Example:
   `"clobTokenIds": "[\"token1\", \"token2\"]"`

4. **Spread Data**: The `spread` field in market responses - is this the 
   current live spread or a historical average?

5. **Rate Limits**: What are the rate limits for the Gamma API?

Thank you!
```

---

## Summary of All Fixes

| Issue | File | Line | Fix |
|-------|------|------|-----|
| Zero markets | `market-making-scanner.ts` | ~150 | Parse `clobTokenIds` as JSON string |
| Missing categories | `market-making-scanner.ts` | ~130 | Add multi-endpoint fetching |
| Missing images | `market-making-scanner.ts` | ~170 | Use `image \|\| icon \|\| event.image` |
| No manual entry | `market-making-scanner.ts` | NEW | Add `addMarketManually()` method |
| No bookmarks | `market-making-scanner.ts` | NEW | Add bookmark methods |
| No status | `market-making-scanner.ts` | ~160 | Add `computeMarketStatus()` |
| Missing UI data | Interfaces | N/A | Add `volume24hr`, `status`, `acceptingOrders` |

The **#1 critical fix** is parsing `clobTokenIds` as a JSON string. This alone will fix your "0 tokens" issue.