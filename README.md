# pump-fun-bot

A TypeScript trading bot that monitors Discord and Telegram channels for pump.fun token signals, buys before the bonding curve completes, and sells on DEX launch. Designed to run 24/7 on a Mac Mini via launchd.

---

## How it works

1. **Signal detection** — Monitors configured Telegram channels (via MTProto user account) and Discord channels (via bot token) for pump.fun token contract addresses. Each message is scored for confidence based on keyword hype and channel weight.
2. **Aggregation** — Signals for the same token within a 60-second window are deduplicated. Multi-source signals (seen on both Telegram and Discord) get a +0.2 confidence boost.
3. **Risk checks** — Before buying, the bot checks: minimum signal confidence, bonding curve completion %, max open positions, daily loss limit, and duplicate position guard.
4. **Buy** — Executes via `pumpdotfun-sdk` on the bonding curve, with retry across multiple RPC endpoints.
5. **Position tracking** — Polls the bonding curve every 10 seconds. When graduation is detected, switches to watching for a Raydium CPMM pool (event-driven) with Jupiter as a fallback.
6. **Sell** — Once the DEX is live, quotes token → WSOL via Jupiter on every tick. Sells when PnL hits profit target (+200% default) or stop-loss (−30% default).
7. **Notifications** — Sends Telegram alerts for buys, sells, and risk denials.

---

## Prerequisites

- **Node.js** v20+ (v24 recommended)
- **pnpm** (`npm install -g pnpm`)
- **QuickNode** Solana mainnet endpoint(s)
- **Solana wallet** with SOL funded for trading
- **Telegram API credentials** — from [my.telegram.org/apps](https://my.telegram.org/apps)
- **Discord bot token** — from [discord.com/developers](https://discord.com/developers/applications)

---

## Installation

```bash
# 1. Install dependencies
pnpm install

# 2. Copy and fill in environment variables
cp .env.example .env

# 3. Configure channels and trading params
nano config.yaml

# 4. Initialise the database
pnpm setup-db
```

### First run (interactive Telegram auth)

The first time the bot starts, gramjs will prompt you for a one-time Telegram OTP. After entering it, the session is saved to `data/telegram.session` and all future starts are non-interactive.

```bash
pnpm dev   # runs via tsx — hot reload, shows OTP prompt in terminal
```

---

## Configuration

### `.env`

| Variable | Required | Description |
|---|---|---|
| `WALLET_PRIVATE_KEY` | Yes | Base58 private key of the trading wallet |
| `RPC_URL_1` … `RPC_URL_10` | At least 1 | QuickNode (or other) Solana RPC URLs |
| `TELEGRAM_API_ID` | Yes | From my.telegram.org/apps |
| `TELEGRAM_API_HASH` | Yes | From my.telegram.org/apps |
| `TELEGRAM_PHONE` | Yes | Phone number linked to your Telegram account |
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token |
| `NOTIFY_TELEGRAM_BOT_TOKEN` | No | Bot token for trade alert notifications |
| `NOTIFY_TELEGRAM_CHAT_ID` | No | Chat/channel ID to receive alerts |

### `config.yaml`

| Setting | Default | Description |
|---|---|---|
| `rpc.strategy` | `round-robin` | `round-robin` / `fastest` / `failover` |
| `rpc.health_check_interval_s` | `30` | How often to ping RPC endpoints |
| `trading.max_position_sol` | `0.5` | Max SOL per trade |
| `trading.max_open_positions` | `5` | Max concurrent positions |
| `trading.max_daily_loss_sol` | `3.0` | Daily loss hard stop |
| `trading.max_bonding_curve_pct` | `50` | Skip buy if bonding curve ≥ this % |
| `trading.min_signal_confidence` | `0.6` | Minimum confidence score (0–1) |
| `trading.profit_target_pct` | `200` | Sell at +200% PnL |
| `trading.stop_loss_pct` | `-30` | Sell at −30% PnL |
| `trading.slippage_bps` | `1000` | Slippage tolerance (10%) |
| `trading.buy_retry_count` | `3` | RPC retries on buy failure |
| `trading.signal_dedup_window_s` | `60` | Dedup window per token |

**Adding signal channels** — edit `config.yaml`:

```yaml
telegram:
  channels:
    - id: -1001234567890     # channel numeric ID
      name: "alpha-calls"
      weight: 1.0            # 0.0–1.0, scales confidence score

discord:
  channels:
    - id: "1234567890123456789"   # channel snowflake ID
      name: "pump-calls"
      weight: 0.9
```

---

## Running

### Development (hot reload)

```bash
pnpm dev
```

### Production (manual)

```bash
pnpm build
pnpm start
```

### Production (launchd — auto-start on boot, auto-restart on crash)

```bash
./scripts/install-service.sh
```

This builds the project, installs a LaunchAgent to `~/Library/LaunchAgents/com.pumpbot.plist`, and starts the bot immediately.

```bash
# View logs
tail -f data/logs/stdout.log
tail -f data/logs/stderr.log

# Check service status
launchctl print gui/$(id -u)/com.pumpbot

# Restart
launchctl kickstart -k gui/$(id -u)/com.pumpbot

# Stop
launchctl kill TERM gui/$(id -u)/com.pumpbot

# Remove service
./scripts/uninstall-service.sh
```

---

## Project structure

```
pump-fun-bot/
├── src/
│   ├── index.ts                  # Orchestrator — wires all services
│   ├── config/
│   │   ├── index.ts              # Loads .env + config.yaml, exports typed config
│   │   └── schema.ts             # Zod schemas for env and YAML
│   ├── rpc/
│   │   ├── manager.ts            # Round-robin / fastest / failover across RPC pool
│   │   └── health.ts             # Periodic getSlot pings, marks unhealthy endpoints
│   ├── signals/
│   │   ├── types.ts              # Signal interface
│   │   ├── telegram.ts           # Telegram user account monitor (gramjs MTProto)
│   │   ├── discord.ts            # Discord bot monitor (discord.js)
│   │   └── aggregator.ts         # Dedup, confidence boosting, threshold gating
│   ├── scanner/
│   │   ├── pumpfun.ts            # WebSocket listener for createEvent / completeEvent
│   │   └── bonding.ts            # Fetches bonding curve state (%, market cap, complete)
│   ├── trader/
│   │   ├── risk.ts               # 5 ordered risk checks before every buy
│   │   ├── buyer.ts              # Buy on bonding curve via pumpdotfun-sdk
│   │   ├── seller.ts             # Sell via Jupiter swap (threshold-gated)
│   │   └── position.ts           # State machine: bonding → dex_launched → sold
│   ├── dex/
│   │   ├── raydium.ts            # Polls Raydium CPMM program for pool detection
│   │   └── jupiter.ts            # Jupiter v6 quote API (DEX liveness + sell routing)
│   ├── db/
│   │   ├── schema.sql            # Tables: signals, trades, positions, rpc_stats
│   │   └── client.ts             # better-sqlite3 singleton + typed query methods
│   ├── notifications/
│   │   └── telegram.ts           # Telegram Bot API notifier (buy / sell / risk alerts)
│   └── utils/
│       ├── logger.ts             # pino (pretty in dev, JSON in prod)
│       └── retry.ts              # Exponential backoff helper
├── scripts/
│   ├── setup-db.ts               # Initialise DB and verify schema
│   ├── check-rpc.ts              # CLI: probe all endpoints, print latency table
│   ├── install-service.sh        # Build + register launchd agent
│   └── uninstall-service.sh      # Stop + remove launchd agent
├── launchd/
│   └── com.pumpbot.plist         # LaunchAgent template
├── tests/
│   ├── risk.test.ts              # 17 unit tests for RiskManager
│   └── signals.test.ts           # 12 unit tests for SignalAggregator
├── data/                         # Runtime data (gitignored)
│   ├── pumpbot.db                # SQLite database
│   ├── telegram.session          # gramjs session (created on first auth)
│   └── logs/                     # stdout.log / stderr.log (launchd only)
├── config.yaml                   # Trading params and channel lists
└── .env.example                  # Environment variable template
```

---

## CLI tools

```bash
# Verify RPC endpoints and print latency
pnpm check-rpc

# Run tests
pnpm test

# Type-check without emitting
pnpm typecheck
```

---

## Signal scoring

Each incoming message is scored 0–1:

- **Base score** — 0.5 if a Solana contract address is found, 0.3 otherwise
- **Keyword boost** — +0.05 per hype keyword (`pump`, `gem`, `moon`, `alpha`, `launch`, …), capped
- **Channel weight** — score multiplied by the channel's configured weight (0–1)
- **Multi-source boost** — +0.2 per additional unique source (Telegram + Discord = +0.2)

Only signals that reach `min_signal_confidence` after aggregation are forwarded to the buyer.

---

## Database schema

| Table | Purpose |
|---|---|
| `signals` | Every raw signal received (auditing / replay) |
| `trades` | One row per buy+sell cycle with entry/exit prices and PnL |
| `positions` | Open position state (`open` → `dex_launched` → `profit_target` / `stop_loss`) |
| `rpc_stats` | Per-endpoint success/error counts and average latency |

---

## Risk management

Checks run in order before every buy — first failure stops the buy:

1. Signal confidence ≥ `min_signal_confidence`
2. Bonding curve < `max_bonding_curve_pct`
3. Open positions < `max_open_positions`
4. Daily realised loss < `max_daily_loss_sol`
5. No existing open position for this token

---

## Disclaimer

This software is for educational purposes. Automated trading on pump.fun carries significant financial risk. Tokens can lose all value instantly. Never trade with funds you cannot afford to lose.
