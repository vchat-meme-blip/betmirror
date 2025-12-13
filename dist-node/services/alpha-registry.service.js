import axios from 'axios';
/**
 * Client-side/CLI service to talk to the Global Registry API via HTTP.
 * Used when no direct DB access is available (e.g. Browser or Headless CLI).
 */
export class AlphaRegistryService {
    apiUrl = '/api';
    constructor(apiUrl) {
        if (apiUrl)
            this.apiUrl = apiUrl;
    }
    setApiUrl(url) {
        this.apiUrl = url;
    }
    async getRegistry() {
        try {
            const res = await axios.get(`${this.apiUrl}/registry`);
            return res.data;
        }
        catch (error) {
            console.error('Failed to fetch registry:', error);
            return [];
        }
    }
    async getListerForWallet(walletAddress) {
        try {
            const res = await axios.get(`${this.apiUrl}/registry/${walletAddress}`);
            return res.data.listedBy;
        }
        catch (e) {
            return null;
        }
    }
    async addWallet(targetAddress, finderAddress) {
        try {
            const res = await axios.post(`${this.apiUrl}/registry`, {
                address: targetAddress,
                listedBy: finderAddress
            });
            return { success: true, message: 'Wallet Listed Successfully', profile: res.data.profile };
        }
        catch (error) {
            const msg = error.response?.data?.error || error.message;
            return { success: false, message: msg };
        }
    }
}
// Default export for backward compatibility if needed, but preferred to instantiate
export const alphaRegistry = new AlphaRegistryService();
