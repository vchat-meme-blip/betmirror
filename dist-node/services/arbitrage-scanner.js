import { WS_URLS } from '../config/env.js';
import EventEmitter from 'events';
import WebSocket from 'ws';
export class ArbitrageScanner extends EventEmitter {
    adapter;
    logger;
    isScanning = false;
    // FIX: Type the websocket instance correctly using the Node.js implementation from 'ws'
    ws;
    priceMap = new Map();
    opportunities = [];
    auth;
    // TARGET: Fast-resolving crypto and price-action markets
    cryptoRegex = /\b(BTC|ETH|SOL|LINK|MATIC|DOGE|Price|climb|fall|above|below|closes|resolves)\b/i;
    constructor(adapter, logger) {
        super();
        this.adapter = adapter;
        this.logger = logger;
    }
    async start() {
        if (this.isScanning)
            return;
        this.isScanning = true;
        const client = this.adapter.getRawClient?.();
        if (!client) {
            this.logger.error("Arbitrage Scanner: Failed to get Raw CLOB Client for WSS (client uninitialized).");
            return;
        }
        const creds = client.getApiKey() || client.apiKeys;
        this.auth = creds;
        this.connect();
        this.logger.success(`🔍 ARB ENGINE: WebSocket Mode Active (Targeting New & Crypto Spreads)`);
    }
    connect() {
        if (!this.isScanning)
            return;
        // FIX: Create a new instance of Node.js WebSocket
        this.ws = new WebSocket(WS_URLS.CLOB);
        // FIX: Node.js WebSocket from 'ws' supports the 'on' method for event listening
        this.ws.on('open', () => {
            this.logger.info("📡 CLOB WSS: Connected. Subscribing to Market discovery channel...");
            this.subscribe();
        });
        // FIX: Node.js WebSocket from 'ws' supports the 'on' method for event listening
        this.ws.on('message', (data) => {
            try {
                // Ensure data is converted to string for JSON parsing
                const messageData = data.toString();
                const messages = JSON.parse(messageData);
                if (Array.isArray(messages)) {
                    messages.forEach(m => this.processMessage(m));
                }
                else {
                    this.processMessage(messages);
                }
            }
            catch (e) {
                this.logger.error("WSS Message Error", e);
            }
        });
        // FIX: Node.js WebSocket from 'ws' supports the 'on' method for event listening
        this.ws.on('close', () => {
            this.logger.warn("📡 CLOB WSS: Disconnected. Reconnecting...");
            if (this.isScanning)
                setTimeout(() => this.connect(), 5000);
        });
        // FIX: Node.js WebSocket from 'ws' supports the 'on' method for event listening
        this.ws.on('error', (e) => {
            this.logger.error("WSS Socket Error", e);
        });
        const pingInterval = setInterval(() => {
            // FIX: Use WebSocket.OPEN static property for readyState comparison
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send("PING");
            }
            else {
                clearInterval(pingInterval);
            }
        }, 20000);
    }
    subscribe() {
        // FIX: Use WebSocket.OPEN static property for readyState comparison
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        const subMsg = {
            type: "market",
            assets_ids: [],
            custom_feature_enabled: true
        };
        this.ws.send(JSON.stringify(subMsg));
    }
    processMessage(msg) {
        if (msg.event_type === "new_market") {
            this.handleNewMarket(msg);
            return;
        }
        if (msg.event_type === "best_bid_ask") {
            this.handlePriceUpdate(msg);
            return;
        }
    }
    handleNewMarket(msg) {
        const marketId = msg.market;
        const question = msg.question || "New Listing";
        const isCrypto = this.cryptoRegex.test(question);
        if (isCrypto) {
            this.logger.success(`✨ HIGH PRIORITY: New Crypto Market: ${question}`);
        }
        this.priceMap.set(marketId, {
            question,
            isNegRisk: msg.neg_risk || false,
            isCrypto,
            outcomes: {},
            totalLegsExpected: msg.asset_ids?.length || 2
        });
    }
    handlePriceUpdate(msg) {
        const marketId = msg.market;
        const tokenId = msg.asset_id;
        const bestAsk = parseFloat(msg.best_ask || "1.0");
        const askSize = parseFloat(msg.ask_size || "0");
        let market = this.priceMap.get(marketId);
        if (!market) {
            this.priceMap.set(marketId, {
                question: "Syncing...",
                isNegRisk: true,
                isCrypto: false,
                outcomes: {},
                totalLegsExpected: 2
            });
            market = this.priceMap.get(marketId);
        }
        market.outcomes[tokenId] = {
            tokenId,
            outcome: "UNK",
            price: bestAsk,
            size: askSize
        };
        if (Object.keys(market.outcomes).length >= market.totalLegsExpected) {
            this.analyzeMarketArb(marketId, market);
        }
    }
    analyzeMarketArb(marketId, market) {
        const legs = Object.values(market.outcomes);
        let combinedCost = 0;
        let minDepth = Infinity;
        for (const leg of legs) {
            if (leg.price >= 1.0 || leg.price <= 0)
                return;
            combinedCost += leg.price;
            minDepth = Math.min(minDepth, leg.size);
        }
        // Apply a strict ROI threshold to filter out noise
        // Fee threshold is approx 0.5% (Relayer + Spread)
        if (combinedCost < 0.995 && combinedCost > 0.01) {
            const profitPerShare = 1.0 - combinedCost;
            const roi = (profitPerShare / combinedCost) * 100;
            const minRoi = market.isCrypto ? 0.25 : 0.4;
            if (roi >= minRoi) {
                const opportunity = {
                    marketId,
                    question: market.question,
                    combinedCost,
                    potentialProfit: profitPerShare,
                    roi,
                    capacityUsd: minDepth * combinedCost,
                    legs: legs.map(l => ({
                        tokenId: l.tokenId,
                        outcome: l.outcome,
                        price: l.price,
                        depth: l.size
                    })),
                    timestamp: Date.now()
                };
                const existingIdx = this.opportunities.findIndex(o => o.marketId === marketId);
                if (existingIdx !== -1) {
                    // Update if significantly better (0.1% change) to prevent event spam
                    if (roi > this.opportunities[existingIdx].roi + 0.1) {
                        this.opportunities[existingIdx] = opportunity;
                        this.emit('opportunity', opportunity);
                    }
                }
                else {
                    this.opportunities.push(opportunity);
                    this.opportunities.sort((a, b) => b.roi - a.roi);
                    this.emit('opportunity', opportunity);
                    this.logger.success(`💎 ARB FOUND: ${market.question} | ROI: ${roi.toFixed(2)}%`);
                }
            }
        }
    }
    stop() {
        this.isScanning = false;
        if (this.ws) {
            // FIX: Use Node.js specific .terminate() for immediate closing of the connection
            this.ws.terminate();
            this.ws = undefined;
        }
        this.logger.warn('🛑 Arbitrage scanner stopped');
    }
    /**
     * Data Polishing for Frontend:
     * Filters for freshness (2 mins) and ensures the most profitable arbs are first.
     */
    getLatestOpportunities() {
        const now = Date.now();
        // Prune the main list
        this.opportunities = this.opportunities.filter(o => now - o.timestamp < 120000);
        return this.opportunities;
    }
}
