import { OrderType, Side } from '@polymarket/clob-client';
export async function postOrder(input) {
    const { client, marketId, tokenId, outcome, side, sizeUsd, maxAcceptablePrice } = input;
    // 1. Pre-Check: Ensure Market is Active
    if (marketId) {
        try {
            const market = await client.getMarket(marketId);
            if (!market) {
                throw new Error(`Market not found: ${marketId}`);
            }
            // Check if market is closed/resolved to avoid 404 on Orderbook
            // Polymarket API typically returns 'closed' boolean or 'active' boolean
            if (market.closed || market.active === false || market.enable_order_book === false) {
                throw new Error(`Market ${marketId} is closed or resolved. Cannot trade.`);
            }
        }
        catch (e) {
            // If getMarket fails, we probably can't trade anyway
            throw new Error(`Failed to validate market status: ${e.message}`);
        }
    }
    let orderBook;
    try {
        orderBook = await client.getOrderBook(tokenId);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('No orderbook exists') || errorMessage.includes('404')) {
            // This is an expected condition for old/resolved markets
            throw new Error(`Market ${marketId} is closed or resolved - no orderbook available for token ${tokenId}`);
        }
        throw error;
    }
    if (!orderBook) {
        throw new Error(`Failed to fetch orderbook for token ${tokenId}`);
    }
    const isBuy = side === 'BUY';
    const levels = isBuy ? orderBook.asks : orderBook.bids;
    if (!levels || levels.length === 0) {
        throw new Error(`No ${isBuy ? 'asks' : 'bids'} available for token ${tokenId} - market may be closed or have no liquidity`);
    }
    const bestPrice = parseFloat(levels[0].price);
    if (maxAcceptablePrice && ((isBuy && bestPrice > maxAcceptablePrice) || (!isBuy && bestPrice < maxAcceptablePrice))) {
        throw new Error(`Price protection: best price ${bestPrice} exceeds max acceptable ${maxAcceptablePrice}`);
    }
    const orderSide = isBuy ? Side.BUY : Side.SELL;
    let remaining = sizeUsd;
    let retryCount = 0;
    const maxRetries = 3;
    while (remaining > 0.01 && retryCount < maxRetries) {
        const currentOrderBook = await client.getOrderBook(tokenId);
        const currentLevels = isBuy ? currentOrderBook.asks : currentOrderBook.bids;
        if (!currentLevels || currentLevels.length === 0) {
            break;
        }
        const level = currentLevels[0];
        const levelPrice = parseFloat(level.price);
        const levelSize = parseFloat(level.size);
        let orderSize;
        let orderValue;
        if (isBuy) {
            const levelValue = levelSize * levelPrice;
            orderValue = Math.min(remaining, levelValue);
            orderSize = orderValue / levelPrice;
        }
        else {
            const levelValue = levelSize * levelPrice;
            orderValue = Math.min(remaining, levelValue);
            orderSize = orderValue / levelPrice;
        }
        const orderArgs = {
            side: orderSide,
            tokenID: tokenId,
            amount: orderSize,
            price: levelPrice,
        };
        try {
            const signedOrder = await client.createMarketOrder(orderArgs);
            const response = await client.postOrder(signedOrder, OrderType.FOK);
            if (response.success) {
                remaining -= orderValue;
                retryCount = 0;
            }
            else {
                retryCount++;
            }
        }
        catch (error) {
            retryCount++;
            if (retryCount >= maxRetries) {
                throw error;
            }
        }
    }
}
