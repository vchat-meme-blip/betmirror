
import { Wallet, JsonRpcProvider } from 'ethers';
import { ClobClient, Chain } from '@polymarket/clob-client';
import type { ApiKeyCreds } from '@polymarket/clob-client';
import { BuilderConfig, BuilderApiKeyCreds } from '@polymarket/builder-signing-sdk';

export type CreateClientInput = {
  rpcUrl: string;
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  // Builder Program Creds
  builderApiKey?: string;
  builderApiSecret?: string;
  builderApiPassphrase?: string;
};

export async function createPolymarketClient(
  input: CreateClientInput,
): Promise<ClobClient & { wallet: Wallet }> {
  const provider = new JsonRpcProvider(input.rpcUrl);
  const wallet = new Wallet(input.privateKey, provider);
  
  let creds: ApiKeyCreds | undefined;
  if (input.apiKey && input.apiSecret && input.apiPassphrase) {
    creds = {
      key: input.apiKey,
      secret: input.apiSecret,
      passphrase: input.apiPassphrase,
    };
  }

  // Configure Builder SDK if credentials are present
  let builderConfig: BuilderConfig | undefined;
  if (input.builderApiKey && input.builderApiSecret && input.builderApiPassphrase) {
      const builderCreds: BuilderApiKeyCreds = {
          key: input.builderApiKey,
          secret: input.builderApiSecret,
          passphrase: input.builderApiPassphrase
      };
      builderConfig = new BuilderConfig({ localBuilderCreds: builderCreds });
  }

  // Casting wallet as any to bypass type mismatch between ethers v6 Wallet and ClobClient (v5) expectation
  const client = new ClobClient(
    'https://clob.polymarket.com',
    Chain.POLYGON,
    wallet as any,
    creds,
    undefined, // SignatureType
    undefined, // funderAddress
    undefined, // ...
    undefined, // ...
    builderConfig // Pass builder config for order attribution
  );
  return Object.assign(client, { wallet });
}
