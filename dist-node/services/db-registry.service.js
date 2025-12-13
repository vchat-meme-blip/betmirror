import { Registry } from '../database/index.js';
/**
 * Server-side service to talk to the Registry via Mongoose.
 * Used by the BotEngine to avoid internal HTTP calls.
 */
export class DbRegistryService {
    async getListerForWallet(walletAddress) {
        try {
            // Case-insensitive regex search for address
            const profile = await Registry.findOne({
                address: { $regex: new RegExp(`^${walletAddress}$`, "i") }
            });
            // Directly access properties. Mongoose types are tricky with Documents vs Interfaces.
            // profile is a HydratedDocument<IRegistry> which should have the fields.
            return profile ? profile.listedBy : null;
        }
        catch (e) {
            console.error("DbRegistry lookup failed", e);
            return null;
        }
    }
}
