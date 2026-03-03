#!/usr/bin/env tsx
/**
 * scripts/check-rpc.ts
 *
 * CLI tool: probe all configured RPC endpoints and print a summary table.
 *
 * Usage:
 *   pnpm check-rpc
 *   pnpm check-rpc --rounds 3   # average over N rounds
 */
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { Connection } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Bootstrap env (before importing anything that reads it at module level)
// ---------------------------------------------------------------------------
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
loadDotenv({ path: resolve(ROOT, '.env') });

// ---------------------------------------------------------------------------
// Collect endpoint URLs from env
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  'RPC_URL_1', 'RPC_URL_2', 'RPC_URL_3', 'RPC_URL_4', 'RPC_URL_5',
  'RPC_URL_6', 'RPC_URL_7', 'RPC_URL_8', 'RPC_URL_9', 'RPC_URL_10',
] as const;

const endpoints = ENV_KEYS
  .map((key) => process.env[key])
  .filter((url): url is string => Boolean(url));

if (endpoints.length === 0) {
  console.error('No RPC URLs found. Set RPC_URL_1 ... RPC_URL_10 in .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse --rounds flag
// ---------------------------------------------------------------------------
const roundsArg = process.argv.indexOf('--rounds');
const ROUNDS = roundsArg !== -1 ? parseInt(process.argv[roundsArg + 1] ?? '1', 10) : 1;

// ---------------------------------------------------------------------------
// Probe helper
// ---------------------------------------------------------------------------
const TIMEOUT_MS = 5_000;

interface Result {
  url: string;
  healthy: boolean;
  avgLatencyMs: number;
  slot: number | null;
  errors: number;
}

async function probe(url: string): Promise<{ latencyMs: number; slot: number | null; ok: boolean }> {
  const conn = new Connection(url, 'confirmed');
  const start = Date.now();
  try {
    const slotPromise = conn.getSlot('confirmed');
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS),
    );
    const slot = await Promise.race([slotPromise, timeout]);
    return { latencyMs: Date.now() - start, slot, ok: true };
  } catch {
    return { latencyMs: Date.now() - start, slot: null, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log(`\nProbing ${endpoints.length} RPC endpoint(s), ${ROUNDS} round(s) each...\n`);

const results: Result[] = await Promise.all(
  endpoints.map(async (url) => {
    const samples: number[] = [];
    let slot: number | null = null;
    let errors = 0;

    for (let r = 0; r < ROUNDS; r++) {
      const res = await probe(url);
      if (res.ok) {
        samples.push(res.latencyMs);
        slot = res.slot;
      } else {
        errors++;
      }
    }

    const healthy = samples.length > 0;
    const avgLatencyMs = healthy
      ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
      : -1;

    return { url, healthy, avgLatencyMs, slot, errors };
  }),
);

// ---------------------------------------------------------------------------
// Print table
// ---------------------------------------------------------------------------
const STATUS_OK  = '\x1b[32m✓ OK   \x1b[0m';
const STATUS_ERR = '\x1b[31m✗ FAIL \x1b[0m';
const COL_URL    = 55;
const COL_STATUS =  8;
const COL_LAT    =  9;
const COL_SLOT   = 13;
const COL_ERR    =  6;

const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);

console.log(
  pad('Endpoint', COL_URL),
  pad('Status', COL_STATUS),
  pad('Avg ms', COL_LAT),
  pad('Slot', COL_SLOT),
  'Errors',
);
console.log('-'.repeat(COL_URL + COL_STATUS + COL_LAT + COL_SLOT + COL_ERR + 4));

let healthyCount = 0;
for (const r of results) {
  if (r.healthy) healthyCount++;
  // Redact the token portion of QuickNode URLs for display
  const displayUrl = r.url.replace(/\/[a-f0-9]{32,}\/?$/, '/***');
  console.log(
    pad(displayUrl, COL_URL),
    r.healthy ? STATUS_OK : STATUS_ERR,
    pad(r.healthy ? `${r.avgLatencyMs} ms` : '—', COL_LAT),
    pad(r.slot !== null ? String(r.slot) : '—', COL_SLOT),
    String(r.errors),
  );
}

console.log(
  `\nResult: ${healthyCount}/${results.length} healthy`,
  healthyCount === 0 ? '\x1b[31m(no healthy endpoints!)\x1b[0m' : '',
);

// Sort by latency and show recommendation
const healthy = results.filter((r) => r.healthy).sort((a, b) => a.avgLatencyMs - b.avgLatencyMs);
if (healthy.length > 0) {
  const best = healthy[0]!;
  const bestDisplay = best.url.replace(/\/[a-f0-9]{32,}\/?$/, '/***');
  console.log(`Fastest: ${bestDisplay} (${best.avgLatencyMs} ms)\n`);
}
