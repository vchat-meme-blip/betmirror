import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { WS_URLS } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';

type MarketResolutionUpdate = {
    marketId: string;
    resolved: boolean;
    winningOutcome?: string;
    closed: boolean;
    archived: boolean;
    status?: string;
    tokens?: Array<{
        outcome: string;
        winner: boolean;
    }>;
};

type MarketResolutionCallback = (update: MarketResolutionUpdate) => void;

export class MarketWebSocketService extends EventEmitter {
    private ws?: WebSocket;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectDelay = 1000; // Start with 1 second
    private maxReconnectDelay = 30000; // Max 30 seconds
    private pingInterval?: NodeJS.Timeout;
    private subscribedMarkets = new Set<string>();
    private callbacks = new Map<string, Set<MarketResolutionCallback>>();
    private isConnected = false;

    constructor(private logger: Logger) {
        super();
    }

    public connect(): void {
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
        }

        this.ws = new WebSocket(WS_URLS.CLOB);

        this.ws.on('open', () => {
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

            // Set up ping-pong to keep connection alive
            this.pingInterval = setInterval(() => {
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.ping();
                }
            }, 30000); // Send ping every 30 seconds
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());
                this.handleMessage(message);
            } catch (error) {
                const errorMessage = error instanceof Error ? error : new Error(String(error));
                this.logger.error('Error parsing WebSocket message:', errorMessage);
            }
        });

        this.ws.on('close', () => {
            this.isConnected = false;
            this.logger.warn('🔌 Market WebSocket: Disconnected');
            this.handleReconnect();
            
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
                this.pingInterval = undefined;
            }
        });

        this.ws.on('error', (error: Error) => {
            this.logger.error(`WebSocket error: ${error.message}`, error);
        });
    }

    private handleReconnect(): void {
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

    private handleMessage(message: any): void {
        // Handle different types of messages from the WebSocket
        if (message?.type === 'market_update' && message.data) {
            this.handleMarketUpdate(message.data);
        }
        // Add handling for other message types if needed
    }

    private handleMarketUpdate(marketData: any): void {
        if (!marketData?.id) return;

        const marketId = marketData.id;
        const callbacks = this.callbacks.get(marketId);
        
        if (!callbacks || callbacks.size === 0) return;

        const update: MarketResolutionUpdate = {
            marketId,
            resolved: marketData.closed === true || 
                     marketData.archived === true || 
                     marketData.status === 'resolved' ||
                     (marketData.tokens && marketData.tokens.some((t: any) => t.winner === true)),
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

    private getWinningOutcome(tokens?: Array<{outcome: string, winner: boolean}>): string | undefined {
        if (!tokens || !Array.isArray(tokens)) return undefined;
        
        const winningToken = tokens.find(t => t.winner === true);
        return winningToken?.outcome;
    }

    public subscribeToMarket(marketId: string): void {
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

    public unsubscribeFromMarket(marketId: string): void {
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

    public onMarketUpdate(marketId: string, callback: MarketResolutionCallback): () => void {
        if (!this.callbacks.has(marketId)) {
            this.callbacks.set(marketId, new Set());
        }
        
        const callbacks = this.callbacks.get(marketId)!;
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

    public disconnect(): void {
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close();
            }
            this.ws.removeAllListeners();
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

    public isConnectedToWebSocket(): boolean {
        return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
    }
}

// Singleton instance
let marketWsService: MarketWebSocketService | null = null;

export const getMarketWebSocketService = (logger: Logger): MarketWebSocketService => {
    if (!marketWsService) {
        marketWsService = new MarketWebSocketService(logger);
        marketWsService.connect();
    }
    return marketWsService;
};
