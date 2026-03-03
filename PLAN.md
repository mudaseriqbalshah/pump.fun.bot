# Pump.fun Day Trading Bot — TypeScript Implementation Plan

## Overview

A TypeScript-based automated trading bot that monitors Discord and Telegram channels for
pump.fun token signals, buys before the bonding curve completes, and sells upon DEX launch
for 2–5x profit. Runs 24/7 on a Mac Mini with 10 QuickNode RPC endpoints.

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20 LTS | Stable, wide ecosystem |
| Language | TypeScript 5.x (strict mode) | Type safety for financial logic |
| Package manager | pnpm | Fast, disk-efficient |
| Solana SDK | `@solana/web3.js` v2 + `@coral-xyz/anchor` | Official Solana SDKs |
| Pump.fun | `@pumpdotfun-sdk` + direct RPC calls | Token buy/sell on bonding curve |
| DEX | Raydium SDK + Jupiter aggregator | Sell on DEX launch |
| Telegram | `gramjs` (MTProto user account) | Read channels without bot token |
| Discord | `discord.js` v14 | Bot token listener |
| Database | SQLite via `better-sqlite3` | Zero-infra, fast local writes |
| Config | `dotenv` + `zod` validation | Type-safe env parsing |
| Logging | `pino` (JSON structured logs) | Fast, low-overhead logging |
| Process mgmt | launchd plist | Mac Mini auto-restart on boot |
| Testing | Vitest | Fast TypeScript-native test runner |

---

## Project Structure

```
pump-fun-bot/
├── src/
│   ├── config/
│   │   ├── index.ts           # Zod-validated env + config loader
│   │   └── schema.ts          # Config schema definitions
│   ├── rpc/
│   │   ├── manager.ts         # Round-robin across 10 QuickNode RPCs
│   │   └── health.ts          # RPC health checks + failover
│   ├── signals/
│   │   ├── types.ts           # Signal interface definitions
│   │   ├── telegram.ts        # Telegram channel monitor (gramjs)
│   │   ├── discord.ts         # Discord channel monitor (discord.js)
│   │   └── aggregator.ts      # Merge + deduplicate signals from all sources
│   ├── scanner/
│   │   ├── pumpfun.ts         # WebSocket subscription for new token events
│   │   └── bonding.ts         # Track bonding curve progress %
│   ├── trader/
│   │   ├── buyer.ts           # Buy logic (pre-bonding-curve)
│   │   ├── seller.ts          # Sell logic (on DEX launch)
│   │   ├── position.ts        # Open positions tracker
│   │   └── risk.ts            # Stop-loss, max position size, daily limits
│   ├── dex/
│   │   ├── raydium.ts         # Raydium pool detection + swap
│   │   └── jupiter.ts         # Jupiter aggregator fallback swap
│   ├── db/
│   │   ├── client.ts          # SQLite connection singleton
│   │   └── schema.sql         # Table definitions
│   ├── notifications/
│   │   └── telegram.ts        # Send trade alerts to your own Telegram
│   ├── utils/
│   │   ├── logger.ts          # Pino logger instance
│   │   ├── retry.ts           # Exponential backoff helper
│   │   └── math.ts            # Safe decimal math helpers
│   └── index.ts               # Main entry point — starts all services
├── scripts/
│   ├── setup-db.ts            # Initialize SQLite tables
│   └── check-rpc.ts           # Test all 10 RPC endpoints
├── tests/
│   ├── rpc.test.ts
│   ├── signals.test.ts
│   └── risk.test.ts
├── launchd/
│   └── com.pumpbot.plist      # Mac Mini auto-start launchd service
├── .env.example
├── config.yaml
├── package.json
├── tsconfig.json
└── PLAN.md
```

---

## Phase-by-Phase Implementation

### Phase 1 — Project Scaffold
- [ ] `pnpm init`, install all dependencies
- [ ] `tsconfig.json` (strict, ESNext, path aliases)
- [ ] `src/utils/logger.ts` — pino logger singleton
- [ ] `src/config/schema.ts` — Zod schema for all env vars + config
- [ ] `src/config/index.ts` — load `.env`, validate, export typed config
- [ ] `.env.example` with all required keys documented

### Phase 2 — RPC Manager
- [ ] `src/rpc/manager.ts`
  - Store 10 QuickNode URLs from config
  - Round-robin `Connection` selection per request
  - Track per-endpoint latency + error count
- [ ] `src/rpc/health.ts`
  - Ping all endpoints every 30s
  - Mark unhealthy endpoints, skip in rotation
  - Auto-recover when endpoint comes back online
- [ ] `scripts/check-rpc.ts` — CLI tool to test + benchmark all 10 endpoints

### Phase 3 — Telegram Signal Monitor
- [ ] `src/signals/telegram.ts`
  - Use `gramjs` (MTProto user account — reads public + private channels)
  - Auth with phone number + 2FA session saved to disk
  - Subscribe to configured channel IDs from config
  - Parse messages for: token contract address (Solana CA), ticker, hype keywords
  - Emit typed `Signal` events to aggregator

### Phase 4 — Discord Signal Monitor
- [ ] `src/signals/discord.ts`
  - Use `discord.js` v14 with a bot token
  - Add bot to each alpha server
  - Listen to configured channel IDs
  - Same parsing: extract CA, ticker, keywords
  - Emit typed `Signal` events to aggregator

### Phase 5 — Signal Aggregator
- [ ] `src/signals/types.ts`
  ```ts
  interface Signal {
    source: 'telegram' | 'discord'
    channelId: string
    tokenAddress: string    // Solana CA extracted from message
    ticker?: string
    rawMessage: string
    confidence: number      // 0–1 score based on source weight + keyword hits
    timestamp: number
  }
  ```
- [ ] `src/signals/aggregator.ts`
  - Collect signals from all sources via EventEmitter
  - Deduplicate by `tokenAddress` within configurable 60s window
  - Boost confidence when same token appears in multiple sources
  - Filter: only emit signals above min confidence threshold (default 0.6)
  - Pass qualifying signals to buyer pipeline

### Phase 6 — Pump.fun Scanner
- [ ] `src/scanner/pumpfun.ts`
  - WebSocket subscription to pump.fun program logs via RPC `logsSubscribe`
  - Detect `create` instruction → new token minted on pump.fun
  - Cross-reference token mint with any pending signals
  - If match found → trigger buyer
- [ ] `src/scanner/bonding.ts`
  - Fetch bonding curve account data for a token mint
  - Calculate % complete: `virtualSolReserves / targetSolReserves * 100`
  - Return `{ percentComplete, virtualSolReserves, marketCapUSD }`

### Phase 7 — Risk Manager
- [ ] `src/trader/risk.ts`
  - Max SOL per trade (default 0.5 SOL)
  - Max simultaneous open positions (default 5)
  - Max daily loss in SOL (default 3 SOL) — hard stop
  - Max bonding curve % to enter (default < 50% complete)
  - Minimum signal confidence score (default 0.6)
  - Slippage tolerance (default 10%)
  - All limits configurable via `config.yaml`

### Phase 8 — Buyer
- [ ] `src/trader/buyer.ts`
  - Triggered when: signal received + token exists on bonding curve + risk checks pass
  - Calculate position size from risk manager
  - Build buy transaction using `@pumpdotfun-sdk`
  - Sign with wallet keypair loaded from file
  - Send via RPC manager (round-robin endpoint)
  - Retry with next RPC endpoint on failure (up to 3 retries)
  - On success: record in SQLite `{ tokenAddress, buyPriceLamports, amountSOL, txSignature, timestamp }`

### Phase 9 — Position Tracker
- [ ] `src/trader/position.ts`
  - In-memory Map + SQLite-backed open positions
  - For each open position, poll bonding curve % every 10s
  - When bonding curve hits ~100% → token graduates → emit `DEX_LAUNCH` event
  - Track unrealized PnL, time held

### Phase 10 — DEX Detector
- [ ] `src/dex/raydium.ts`
  - Poll Raydium liquidity pools every 5s for newly added pools
  - Match pool base mint against our open position token addresses
  - On pool found → emit pool address + initial DEX price
- [ ] `src/dex/jupiter.ts`
  - Fallback: query Jupiter quote API for the token mint
  - If quote returns a valid route → DEX is live
  - Used when Raydium polling misses the pool

### Phase 11 — Seller
- [ ] `src/trader/seller.ts`
  - Triggered by `DEX_LAUNCH` event from position tracker
  - Fetch current token price on DEX
  - Calculate PnL: `(currentPrice - entryPrice) / entryPrice * 100`
  - Sell all if PnL >= profit target (default 200% = 2x)
  - Sell all if PnL <= stop-loss (default -30%)
  - Build swap via Raydium SDK or Jupiter aggregator
  - Send via RPC manager, retry on failure
  - Record to SQLite: `{ tokenAddress, sellPrice, pnlPercent, pnlSOL, txSignature }`

### Phase 12 — Database Layer
- [ ] `src/db/schema.sql`
  ```sql
  CREATE TABLE signals (
    id INTEGER PRIMARY KEY,
    source TEXT, token_address TEXT, confidence REAL,
    raw_message TEXT, created_at INTEGER
  );
  CREATE TABLE trades (
    id INTEGER PRIMARY KEY,
    token_address TEXT, buy_price_lamports INTEGER,
    sell_price_lamports INTEGER, amount_sol REAL,
    pnl_sol REAL, pnl_pct REAL, status TEXT,
    buy_tx TEXT, sell_tx TEXT, created_at INTEGER
  );
  CREATE TABLE positions (
    id INTEGER PRIMARY KEY,
    token_address TEXT, entry_price_lamports INTEGER,
    amount_sol REAL, bonding_pct REAL,
    status TEXT, created_at INTEGER
  );
  CREATE TABLE rpc_stats (
    endpoint TEXT PRIMARY KEY,
    requests INTEGER, errors INTEGER,
    avg_latency_ms REAL, last_checked INTEGER
  );
  ```
- [ ] `src/db/client.ts` — `better-sqlite3` singleton
- [ ] `scripts/setup-db.ts` — run schema migrations

### Phase 13 — Notifications
- [ ] `src/notifications/telegram.ts`
  - Telegram bot sends YOU real-time alerts:
    - Trade opened: token, entry price, SOL amount
    - Trade closed: PnL %, SOL profit/loss, tx link
    - Risk limit hit (daily loss, position count)
    - RPC endpoint down/recovered

### Phase 14 — Main Orchestrator
- [ ] `src/index.ts`
  - Start RPC health monitor
  - Start Telegram signal monitor
  - Start Discord signal monitor
  - Start pump.fun WebSocket scanner
  - Start position tracker polling loop
  - Wire: signal aggregator → risk check → buyer
  - Wire: position tracker `DEX_LAUNCH` → seller
  - Graceful shutdown: SIGINT/SIGTERM → close DB, disconnect sockets

### Phase 15 — Mac Mini Deployment
- [ ] `launchd/com.pumpbot.plist`
  - Run at login/boot
  - Auto-restart on crash (5s delay)
  - Stdout/stderr → `~/Library/Logs/pumpbot/`
- [ ] `scripts/install-service.sh` — `launchctl load` the plist
- [ ] `scripts/uninstall-service.sh` — `launchctl unload`

---

## Key Config (config.yaml)

```yaml
rpc:
  strategy: round-robin     # round-robin | fastest | failover
  health_check_interval_s: 30
  endpoints:
    - https://your-quicknode-1.solana-mainnet.quiknode.pro/TOKEN/
    - https://your-quicknode-2.solana-mainnet.quiknode.pro/TOKEN/
    # ... 10 total

telegram:
  channels:
    - id: -1001234567890
      name: "alpha-calls"
      weight: 1.0
    - id: -1009876543210
      name: "gem-calls"
      weight: 0.8

discord:
  channels:
    - id: "1234567890123456789"
      name: "pump-calls"
      weight: 0.9

trading:
  wallet_keypair_path: ~/.config/solana/id.json
  max_position_sol: 0.5
  max_open_positions: 5
  max_daily_loss_sol: 3.0
  max_bonding_curve_pct: 50
  min_signal_confidence: 0.6
  profit_target_pct: 200        # sell at 2x
  stop_loss_pct: -30
  slippage_bps: 1000            # 10%
  buy_retry_count: 3
  signal_dedup_window_s: 60

notifications:
  telegram_bot_token: ""
  telegram_chat_id: ""
```

---

## Environment Variables (.env.example)

```
# Solana Wallet
WALLET_PRIVATE_KEY=

# QuickNode RPC endpoints
RPC_URL_1=
RPC_URL_2=
RPC_URL_3=
RPC_URL_4=
RPC_URL_5=
RPC_URL_6=
RPC_URL_7=
RPC_URL_8=
RPC_URL_9=
RPC_URL_10=

# Telegram (gramjs user auth — for reading channels)
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_PHONE=

# Discord bot token
DISCORD_BOT_TOKEN=

# Your notification Telegram bot
NOTIFY_TELEGRAM_BOT_TOKEN=
NOTIFY_TELEGRAM_CHAT_ID=

NODE_ENV=production
```

---

## Risk & Limitations

| Risk | Mitigation |
|---|---|
| Rug pulls / honeypots | Check token metadata, enforce bonding % cap |
| Bonding curve already completed | Enforce `max_bonding_curve_pct` check before buy |
| Transaction failure / slippage | Retry with next RPC, configurable slippage |
| False signals from channels | Multi-source confidence scoring + threshold |
| Daily loss exceeds limit | Hard stop in risk manager, alert via Telegram |
| Mac Mini power/network outage | launchd auto-restart; use UPS + stable internet |
| Private key exposure | Key loaded from file path only, never logged |

---

## Implementation Order

1. Phase 1 — Scaffold + config + logger
2. Phase 2 — RPC manager + health checks
3. Phase 12 — DB setup
4. Phase 7 — Risk manager (write unit tests first)
5. Phase 3 — Telegram monitor
6. Phase 4 — Discord monitor
7. Phase 5 — Signal aggregator
8. Phase 6 — Pump.fun scanner + bonding curve tracker
9. Phase 8 — Buyer
10. Phase 10 — DEX detector (Raydium + Jupiter)
11. Phase 11 — Seller
12. Phase 9 — Position tracker
13. Phase 13 — Notifications
14. Phase 14 — Main orchestrator
15. Phase 15 — launchd deployment

---

> **Ready to build?** Say `build phase 1` and I'll generate all the TypeScript code for that phase.
