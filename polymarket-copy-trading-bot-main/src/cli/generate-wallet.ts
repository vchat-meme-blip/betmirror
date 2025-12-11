import { Wallet } from 'ethers';
import fs from 'fs';
import path from 'path';

/**
 * Generates a fresh EVM wallet.
 * Usage: npm run generate:wallet
 */
function generate() {
    console.log('🔐 Generating Secure Proxy Wallet...');
    
    const wallet = Wallet.createRandom();
    
    const output = `
=========================================
   BET MIRROR PROXY WALLET GENERATED
=========================================

Public Address: ${wallet.address}
Private Key:    ${wallet.privateKey}

[INSTRUCTIONS]
1. Copy the Private Key.
2. Paste it into your .env file as PRIVATE_KEY.
3. Paste the Public Address as PUBLIC_KEY.
4. Send MATIC (for gas) and USDC (for trading) to the Public Address.

⚠️  DO NOT SHARE THIS KEY. SAVE IT NOW.
=========================================
`;

    console.log(output);

    // Optional: Save to a file (gitignored)
    try {
        const envPath = path.resolve(process.cwd(), '.env.generated');
        fs.appendFileSync(envPath, `\n# Generated ${new Date().toISOString()}\nPUBLIC_KEY=${wallet.address}\nPRIVATE_KEY=${wallet.privateKey}\n`);
        console.log(`(Saved backup to .env.generated)`);
    } catch (e) {
        console.warn('Could not save to file, please copy manually.');
    }
}

generate();