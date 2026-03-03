#!/usr/bin/env tsx
/**
 * scripts/setup-db.ts
 *
 * Initialise (or migrate) the SQLite database.
 * Safe to run multiple times — all DDL uses CREATE TABLE IF NOT EXISTS.
 *
 * Usage:
 *   pnpm setup-db
 *   DB_PATH=./custom/path/bot.db pnpm setup-db
 */
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
loadDotenv({ path: resolve(__dirname, '../.env') });

// Import AFTER dotenv is loaded so DB_PATH env var is available.
import { DatabaseClient } from '../src/db/client.js';

const dbPath = process.env.DB_PATH ?? resolve(__dirname, '../data/pumpbot.db');

console.log(`\nSetting up database at: ${dbPath}\n`);

const client = new DatabaseClient(dbPath);
const tables = client.tables();

console.log('Tables created / verified:');
for (const table of tables) {
  console.log(`  ✓ ${table}`);
}

// Quick smoke-test: insert and rollback a signal row.
const tx = client.db.transaction(() => {
  client.insertSignal({
    source: 'telegram',
    channel_id: 'smoke-test',
    token_address: 'smoke_test_address',
    confidence: 1.0,
    raw_message: 'setup-db smoke test',
  });
  // Roll back so we don't leave garbage in the DB.
  throw new Error('rollback');
});

try { tx(); } catch { /* expected */ }

client.close();
console.log('\nDatabase setup complete.\n');
