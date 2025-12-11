import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { TraderProfile } from '../domain/alpha.types';

/**
 * THE GLOBAL REGISTRY SERVER
 * - Acts as the "Truth" for who listed which wallet.
 * - Persists data to 'registry.json' so data survives restarts.
 */

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(process.cwd(), 'registry.json');

app.use(cors());
app.use(express.json() as express.RequestHandler); // Use native express json parser

// --- PERSISTENCE LAYER ---

let WALLET_REGISTRY: TraderProfile[] = [];

// Load on startup
function loadRegistry() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf-8');
      WALLET_REGISTRY = JSON.parse(data);
      console.log(`[DB] Loaded ${WALLET_REGISTRY.length} wallets from disk.`);
    } else {
      // Seed Data if new
      WALLET_REGISTRY = [
        { address: '0x8894e0a0c962cb723c1976a4421c95949be2d4e3', ens: 'vitalik.eth', winRate: 82.5, totalPnl: 450200, tradesLast30d: 12, followers: 15400, isVerified: true, listedBy: '0xSatoshi', listedAt: '2023-01-01' },
        { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', ens: 'polymarket_whale', winRate: 78.2, totalPnl: 125000, tradesLast30d: 45, followers: 3200, isVerified: true, listedBy: '0xAdmin', listedAt: '2023-02-15' },
      ];
      saveRegistry();
    }
  } catch (e) {
    console.error('[DB] Failed to load registry:', e);
  }
}

function saveRegistry() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(WALLET_REGISTRY, null, 2));
  } catch (e) {
    console.error('[DB] Failed to save registry:', e);
  }
}

// Initialize DB
loadRegistry();

// --- ENDPOINTS ---

// 1. Get All Listed Wallets
app.get('/api/registry', (req, res) => {
  res.json(WALLET_REGISTRY);
});

// 2. Get Specific Wallet Info (including Lister)
app.get('/api/registry/:address', (req, res) => {
  const address = req.params.address.toLowerCase();
  const profile = WALLET_REGISTRY.find(w => w.address.toLowerCase() === address);
  
  if (profile) {
    res.json(profile);
  } else {
    res.status(404).json({ error: 'Wallet not found in registry' });
  }
});

// 3. List a New Wallet (The "Proof of Alpha")
app.post('/api/registry', (req, res) => {
  const { address, listedBy } = req.body;

  if (!address || !address.startsWith('0x') || !listedBy || !listedBy.startsWith('0x')) {
     res.status(400).json({ error: 'Invalid address format' });
     return;
  }

  const existing = WALLET_REGISTRY.find(w => w.address.toLowerCase() === address.toLowerCase());
  if (existing) {
     res.status(409).json({ error: 'Wallet already listed', profile: existing });
     return;
  }

  // In a real app, we would verify stats here via Polymarket API
  // For now, we accept the listing
  const newProfile: TraderProfile = {
    address,
    listedBy,
    listedAt: new Date().toISOString(),
    winRate: 0, // Placeholder, would be fetched
    totalPnl: 0,
    tradesLast30d: 0,
    followers: 0,
    isVerified: false
  };

  WALLET_REGISTRY.push(newProfile);
  saveRegistry(); // PERSIST
  
  console.log(`[REGISTRY] New wallet listed: ${address} by ${listedBy}`);
  res.status(201).json({ success: true, profile: newProfile });
});

app.listen(PORT, () => {
  console.log(`🌍 Bet Mirror Global Registry running on http://localhost:${PORT}`);
});