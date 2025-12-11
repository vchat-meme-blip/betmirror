import axios from 'axios';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Robust HTTP GET with Exponential Backoff
 * Handles ECONNRESET (Socket Hang Up), Timeouts, and 5xx errors automatically.
 */
export async function httpGet(url, config, retries = 3) {
    try {
        const res = await axios.get(url, {
            ...config,
            timeout: 10000 // 10s default timeout
        });
        return res.data;
    }
    catch (err) {
        const shouldRetry = retries > 0 &&
            (err.code === 'ECONNRESET' ||
                err.code === 'ETIMEDOUT' ||
                err.code === 'ERR_NETWORK' ||
                (err.response && err.response.status >= 500 && err.response.status < 600) ||
                (err.response && err.response.status === 429));
        if (shouldRetry) {
            const delay = (4 - retries) * 1000 + Math.random() * 500; // 1s, 2s, 3s + jitter
            // console.warn(`[HTTP] Retrying ${url} (${retries} left) after ${delay.toFixed(0)}ms due to ${err.code || err.response?.status}`);
            await sleep(delay);
            return httpGet(url, config, retries - 1);
        }
        throw err;
    }
}
/**
 * Robust HTTP POST
 */
export async function httpPost(url, body, config, retries = 2) {
    try {
        const res = await axios.post(url, body, {
            ...config,
            timeout: 15000
        });
        return res.data;
    }
    catch (err) {
        const shouldRetry = retries > 0 &&
            (err.code === 'ECONNRESET' ||
                err.code === 'ETIMEDOUT' ||
                err.response?.status === 429 ||
                err.response?.status >= 500);
        if (shouldRetry) {
            const delay = (3 - retries) * 1500;
            await sleep(delay);
            return httpPost(url, body, config, retries - 1);
        }
        throw err;
    }
}
