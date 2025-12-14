import 'dotenv/config';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { loadEnv, TOKENS } from '../config/env.js';
import { ConsoleLogger } from '../utils/logger.util.js';
import { Wallet, JsonRpcProvider, Contract, Interface, formatUnits } from 'ethers';
import { deriveSafe } from '@polymarket/builder-relayer-client/dist/builder/derive.js';
import { User } from '../database/index.js';
import readline from 'readline';
// LEGACY FACTORY (Used by standard Gnosis deployments)
const LEGACY_FACTORY = "0xa6b71e26c5e0845f74c812102ca7114b6a896ab2";
const SAFE_ABI = [
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
    "function nonce() view returns (uint256)",
    "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
    "function getOwners() view returns (address[])"
];
const USDC_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)"];
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const question = (query) => {
    return new Promise((resolve) => {
        rl.question(query, resolve);
    });
};
// --- Decryption Helper ---
function decrypt(encryptedTextStr, encryptionKey) {
    const textParts = encryptedTextStr.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const key = crypto.scryptSync(encryptionKey, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}
async function run() {
    const logger = new ConsoleLogger();
    const env = loadEnv();
    console.log("\n🚑 BET MIRROR | ADMIN USER RESCUE TOOL 🚑\n");
    // 1. Connect to DB
    console.log("🔌 Connecting to Database...");
    try {
        await mongoose.connect(env.mongoUri);
        console.log("   ✅ Connected.");
    }
    catch (e) {
        logger.error(`DB Connection Failed: ${e.message}`);
        process.exit(1);
    }
    // 2. Ask for User
    console.log("\nWho are we rescuing?");
    console.log("You can enter: Main Wallet, Signer Address, or Safe Address.");
    const targetInput = await question(`Search Address (or press ENTER to list all): `);
    const normAddr = targetInput.trim().toLowerCase();
    let user = null;
    if (normAddr) {
        // Search by ANY matching address field
        user = await User.findOne({
            $or: [
                { address: normAddr },
                { "tradingWallet.address": normAddr },
                { "tradingWallet.safeAddress": normAddr } // <-- Added searching by Safe Address
            ]
        });
    }
    // 2b. If not found or empty input, list all users
    if (!user) {
        if (normAddr)
            console.log(`\n❌ No user found for "${normAddr}".`);
        console.log("\n📋 Listing all users with Trading Wallets:");
        const users = await User.find({ "tradingWallet.encryptedPrivateKey": { $exists: true } });
        if (users.length === 0) {
            console.log("   (No users found in database. Did you wipe it?)");
            process.exit(1);
        }
        users.forEach((u, idx) => {
            console.log(`   [${idx + 1}] Main: ${u.address} | Signer: ${u.tradingWallet?.address?.slice(0, 6)}...`);
        });
        const choice = await question(`\nSelect User Number (1-${users.length}): `);
        const idx = parseInt(choice) - 1;
        if (isNaN(idx) || idx < 0 || idx >= users.length) {
            console.log("Invalid selection.");
            process.exit(1);
        }
        user = users[idx];
    }
    if (!user || !user.tradingWallet || !user.tradingWallet.encryptedPrivateKey) {
        logger.error("❌ Critical: User record found but has no wallet data.");
        process.exit(1);
    }
    console.log(`\n👤 SELECTED USER: ${user.address}`);
    console.log(`   Signer EOA:    ${user.tradingWallet.address}`);
    console.log(`   Expected Safe: ${user.tradingWallet.safeAddress || 'Unknown'}`);
    // 4. Decrypt Key
    let privateKey = "";
    try {
        privateKey = decrypt(user.tradingWallet.encryptedPrivateKey, env.mongoEncryptionKey);
    }
    catch (e) {
        logger.error("❌ Failed to decrypt key. Check MONGO_ENCRYPTION_KEY in .env");
        process.exit(1);
    }
    const provider = new JsonRpcProvider(env.rpcUrl);
    const signer = new Wallet(privateKey, provider);
    // 5. Determine Legacy Safe Address
    // We calculate where the safe *would* be if deployed with the OLD factory
    // We compare this with the DB safe address
    const legacySafeAddress = await deriveSafe(signer.address, LEGACY_FACTORY);
    console.log(`\n🔎 Legacy Safe Address (Factory 1.3.0): \x1b[33m${legacySafeAddress}\x1b[0m`);
    // Allow manual override if neither match
    let targetSafe = legacySafeAddress;
    const manualAddr = await question(`\nIs ${targetSafe} the address holding funds? [Y/n] (or paste address): `);
    if (manualAddr.trim().length > 40 && manualAddr.trim().startsWith('0x')) {
        targetSafe = manualAddr.trim();
        console.log(`\n🎯 Using Manual Target: \x1b[33m${targetSafe}\x1b[0m`);
    }
    // 6. Verify Ownership & Balance
    const safeContract = new Contract(targetSafe, SAFE_ABI, signer);
    const usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI, provider);
    try {
        // Check if deployed
        const code = await provider.getCode(targetSafe);
        if (code === '0x') {
            logger.warn("⚠️  Target Safe is NOT DEPLOYED on-chain.");
            console.log("   We cannot rescue funds from a non-existent contract.");
            process.exit(1);
        }
        const owners = await safeContract.getOwners();
        const isOwner = owners.map((o) => o.toLowerCase()).includes(signer.address.toLowerCase());
        if (!isOwner) {
            logger.error(`❌ CRITICAL: The user's Signer (${signer.address}) is NOT an owner of Safe ${targetSafe}.`);
            console.log(`   Safe Owners: ${owners.join(', ')}`);
            process.exit(1);
        }
        console.log("   ✅ Ownership Verified.");
        const balance = await usdcContract.balanceOf(targetSafe);
        const balanceFmt = formatUnits(balance, 6);
        console.log(`   💰 Balance: \x1b[32m$${balanceFmt} USDC\x1b[0m`);
        if (balance <= 0n) {
            logger.warn("   No funds to rescue in this Safe.");
            process.exit(0);
        }
        const confirm = await question(`\n⚠️  WITHDRAW $${balanceFmt} to SIGNER (${signer.address})? [y/N]: `);
        if (confirm.toLowerCase() !== 'y') {
            console.log("Cancelled.");
            process.exit(0);
        }
        // 7. Execute Rescue
        console.log("\n🚀 Broadcasting Rescue Transaction...");
        // Gas check
        const gasBal = await provider.getBalance(signer.address);
        if (gasBal < 10000000000000000n) {
            logger.error("❌ Insufficient POL (Matic) in Signer wallet to pay gas fees.");
            console.log(`   Address: ${signer.address}`);
            console.log(`   Please send ~0.2 POL to this address manually and try again.`);
            process.exit(1);
        }
        const nonce = await safeContract.nonce();
        const usdcInterface = new Interface(USDC_ABI);
        const data = usdcInterface.encodeFunctionData("transfer", [signer.address, balance]);
        const txHashBytes = await safeContract.getTransactionHash(TOKENS.USDC_BRIDGED, 0, data, 0, // Operation.Call
        0, 0, 0, // Gas parameters (0 for self-gas)
        "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", nonce);
        const signature = await signer.signMessage(Buffer.from(txHashBytes.slice(2), 'hex'));
        const tx = await safeContract.execTransaction(TOKENS.USDC_BRIDGED, 0, data, 0, 0, 0, 0, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", signature);
        console.log(`\n✅ \x1b[32mSUCCESS! Funds Rescued.\x1b[0m`);
        console.log(`   Tx Hash: https://polygonscan.com/tx/${tx.hash}`);
        console.log(`   Funds are now in the Signer EOA: ${signer.address}`);
        console.log(`   You can now transfer them to the new Safe via the Dashboard or Bridge.`);
    }
    catch (e) {
        logger.error(`Rescue Error: ${e.message}`);
    }
    await mongoose.disconnect();
    process.exit(0);
}
run().catch(console.error);
