import { Wallet, JsonRpcProvider } from 'ethers';
import { ClobClient, Chain } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
export async function createPolymarketClient(input) {
    const provider = new JsonRpcProvider(input.rpcUrl);
    const wallet = new Wallet(input.privateKey, provider);
    let creds;
    if (input.apiKey && input.apiSecret && input.apiPassphrase) {
        creds = {
            key: input.apiKey,
            secret: input.apiSecret,
            passphrase: input.apiPassphrase,
        };
    }
    // Configure Builder SDK if credentials are present
    let builderConfig;
    if (input.builderApiKey && input.builderApiSecret && input.builderApiPassphrase) {
        const builderCreds = {
            key: input.builderApiKey,
            secret: input.builderApiSecret,
            passphrase: input.builderApiPassphrase
        };
        builderConfig = new BuilderConfig({ localBuilderCreds: builderCreds });
    }
    const client = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet, // Cast to any to bypass strict type check between ethers versions
    creds, undefined, // SignatureType
    undefined, // funderAddress
    undefined, // ...
    undefined, // ...
    builderConfig // Pass builder config for order attribution
    );
    return Object.assign(client, { wallet });
}
