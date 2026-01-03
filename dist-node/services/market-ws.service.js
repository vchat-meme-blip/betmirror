import { EventEmitter } from 'events';
// FIX: Removed 'ws' package import as this service runs in the browser. 
// Using the global browser WebSocket API instead.
import { WS_URLS } from '../config/env.js';
export class MarketWebSocketService extends EventEmitter {
    logger;
    ws;
    reconnectAttempts = 0;
    maxReconnectAttempts = 5;
    reconnectDelay = 1000; // Start with 1 second
    maxReconnectDelay = 30000; // Max 30 seconds
    pingInterval;
    subscribedMarkets = new Set();
    callbacks = new Map();
    isConnected = false;
    constructor(logger) {
        super();
        this.logger = logger;
    }
    connect() {
        if (this.ws) {
            // FIX: Use standard close() instead of Node-specific methods
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            this.ws.close();
        }
        // FIX: Use global browser WebSocket constructor
        this.ws = new WebSocket(WS_URLS.CLOB);
        // FIX: Use standard event property handlers for browser WebSocket
        this.ws.onopen = () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.reconnectDelay = 1000;
            this.logger.info('🔌 Market WebSocket: Connected');
            // Resubscribe to all previously subscribed markets
            if (this.subscribedMarkets.size > 0) {
                this.logger.info(`🔁 Resubscribing to ${this.subscribedMarkets.size} markets`);
                this.subscribedMarkets.forEach(marketId => {
                    this.subscribeToMarket(marketId);
                });
            }
            // Set up interval to keep connection alive
            this.pingInterval = setInterval(() => {
                // FIX: Browser WebSocket doesn't have .ping(), sending a message-based ping if needed
                // Most servers handle connection health via standard TCP pings or idle timeouts
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send('ping');
                }
            }, 30000);
        };
        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleMessage(message);
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error : new Error(String(error));
                this.logger.error('Error parsing WebSocket message:', errorMessage);
            }
        };
        this.ws.onclose = () => {
            this.isConnected = false;
            this.logger.warn('🔌 Market WebSocket: Disconnected');
            this.handleReconnect();
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
                this.pingInterval = undefined;
            }
        };
        this.ws.onerror = (error) => {
            this.logger.error('WebSocket connection error occurred');
        };
    }
    handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max reconnection attempts reached. Giving up.');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
        this.logger.info(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        setTimeout(() => {
            this.connect();
        }, delay);
    }
    handleMessage(message) {
        // Handle different types of messages from the WebSocket
        if (message?.type === 'market_update' && message.data) {
            this.handleMarketUpdate(message.data);
        }
        // Add handling for other message types if needed
    }
    handleMarketUpdate(marketData) {
        if (!marketData?.id)
            return;
        const marketId = marketData.id;
        const callbacks = this.callbacks.get(marketId);
        if (!callbacks || callbacks.size === 0)
            return;
        const update = {
            marketId,
            resolved: marketData.closed === true ||
                marketData.archived === true ||
                marketData.status === 'resolved' ||
                (marketData.tokens && marketData.tokens.some((t) => t.winner === true)),
            closed: marketData.closed === true,
            archived: marketData.archived === true,
            status: marketData.status,
            winningOutcome: this.getWinningOutcome(marketData.tokens)
        };
        // Notify all callbacks for this market
        callbacks.forEach(callback => callback(update));
        // Also emit an event for any other listeners
        this.emit('marketUpdate', update);
    }
    getWinningOutcome(tokens) {
        if (!tokens || !Array.isArray(tokens))
            return undefined;
        const winningToken = tokens.find(t => t.winner === true);
        return winningToken?.outcome;
    }
    subscribeToMarket(marketId) {
        // FIX: Use static OPEN property on global WebSocket constructor
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.logger.warn('WebSocket not connected. Will subscribe when connected.');
            this.subscribedMarkets.add(marketId);
            return;
        }
        if (this.subscribedMarkets.has(marketId)) {
            return; // Already subscribed
        }
        const subscribeMessage = JSON.stringify({
            type: 'subscribe',
            channel: 'market',
            id: marketId
        });
        this.ws.send(subscribeMessage);
        this.subscribedMarkets.add(marketId);
        this.logger.debug(`Subscribed to market updates: ${marketId}`);
    }
    unsubscribeFromMarket(marketId) {
        // FIX: Use static OPEN property on global WebSocket constructor
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.subscribedMarkets.delete(marketId);
            return;
        }
        if (!this.subscribedMarkets.has(marketId)) {
            return; // Not subscribed
        }
        const unsubscribeMessage = JSON.stringify({
            type: 'unsubscribe',
            channel: 'market',
            id: marketId
        });
        this.ws.send(unsubscribeMessage);
        this.subscribedMarkets.delete(marketId);
        this.logger.debug(`Unsubscribed from market updates: ${marketId}`);
    }
    onMarketUpdate(marketId, callback) {
        if (!this.callbacks.has(marketId)) {
            this.callbacks.set(marketId, new Set());
        }
        const callbacks = this.callbacks.get(marketId);
        callbacks.add(callback);
        // Subscribe to market updates if not already subscribed
        if (!this.subscribedMarkets.has(marketId)) {
            this.subscribeToMarket(marketId);
        }
        // Return cleanup function
        return () => {
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                this.callbacks.delete(marketId);
                this.unsubscribeFromMarket(marketId);
            }
        };
    }
    disconnect() {
        if (this.ws) {
            // FIX: Use standard WebSocket closure and event removal
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close();
            }
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            this.ws = undefined;
        }
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
        this.subscribedMarkets.clear();
        this.callbacks.clear();
        this.isConnected = false;
        this.logger.info('Market WebSocket: Disconnected');
    }
    isConnectedToWebSocket() {
        // FIX: Use static OPEN property on global WebSocket constructor
        return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
    }
}
// Singleton instance
let marketWsService = null;
export const getMarketWebSocketService = (logger) => {
    if (!marketWsService) {
        marketWsService = new MarketWebSocketService(logger);
        marketWsService.connect();
    }
    return marketWsService;
};
