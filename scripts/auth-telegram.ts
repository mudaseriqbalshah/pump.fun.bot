#!/usr/bin/env tsx
/**
 * scripts/auth-telegram.ts
 *
 * One-time interactive Telegram authentication.
 * Run this BEFORE starting the bot for the first time.
 *
 * What it does:
 *   1. Prompts for the OTP sent to your Telegram account.
 *   2. Optionally prompts for your 2FA password.
 *   3. Saves the session to data/telegram.session.
 *
 * After this script completes successfully, `pnpm dev` / `pnpm start`
 * will start without any interactive prompts.
 *
 * Usage:
 *   pnpm auth-telegram
 */

import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
loadDotenv({ path: resolve(ROOT, '.env') });

import { TelegramMonitor } from '../src/signals/telegram.js';

// ---------------------------------------------------------------------------
// Validate required env vars
// ---------------------------------------------------------------------------

const apiId = process.env.TELEGRAM_API_ID;
const apiHash = process.env.TELEGRAM_API_HASH;
const phone = process.env.TELEGRAM_PHONE;

if (!apiId || !apiHash || !phone) {
  console.error('\n❌  Missing required env vars in .env:');
  if (!apiId)   console.error('    TELEGRAM_API_ID  — get from https://my.telegram.org/apps');
  if (!apiHash) console.error('    TELEGRAM_API_HASH — get from https://my.telegram.org/apps');
  if (!phone)   console.error('    TELEGRAM_PHONE   — your phone number, e.g. +12025551234');
  console.error('');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Authenticate
// ---------------------------------------------------------------------------

console.log('\n=== Telegram Authentication ===');
console.log(`Phone: ${phone}`);
console.log('A verification code will be sent to your Telegram account.\n');

const monitor = new TelegramMonitor({
  apiId: Number(apiId),
  apiHash,
  phone,
  channels: [], // no channels needed for auth-only
});

try {
  await monitor.start();
  await monitor.stop();

  console.log('\n✅  Authentication successful!');
  console.log('    Session saved to data/telegram.session');
  console.log('    You can now run the bot with: pnpm dev\n');
} catch (err) {
  console.error('\n❌  Authentication failed:', err);
  process.exit(1);
}
