-- ============================================================
-- Pump.fun Bot — SQLite Schema
-- All tables use CREATE TABLE IF NOT EXISTS so this file is
-- safe to re-run on every startup (idempotent migrations).
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- signals: raw signal events from Telegram / Discord
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT    NOT NULL CHECK(source IN ('telegram', 'discord')),
  channel_id    TEXT    NOT NULL,
  token_address TEXT    NOT NULL,
  ticker        TEXT,
  confidence    REAL    NOT NULL,
  raw_message   TEXT    NOT NULL,
  created_at    INTEGER NOT NULL   -- Unix ms
);

CREATE INDEX IF NOT EXISTS idx_signals_token   ON signals (token_address);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals (created_at);

-- ------------------------------------------------------------
-- trades: one row per buy; updated in-place when sold
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address         TEXT    NOT NULL,
  buy_price_lamports    INTEGER NOT NULL,
  sell_price_lamports   INTEGER,             -- NULL until sold
  amount_sol            REAL    NOT NULL,
  pnl_sol               REAL,                -- NULL until sold
  pnl_pct               REAL,                -- NULL until sold
  status                TEXT    NOT NULL DEFAULT 'open'
                          CHECK(status IN ('open', 'closed', 'failed')),
  buy_tx                TEXT    NOT NULL,
  sell_tx               TEXT,                -- NULL until sold
  signal_id             INTEGER REFERENCES signals(id),
  created_at            INTEGER NOT NULL,    -- Unix ms (buy time)
  closed_at             INTEGER             -- Unix ms (sell time)
);

CREATE INDEX IF NOT EXISTS idx_trades_token  ON trades (token_address);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);

-- ------------------------------------------------------------
-- positions: live tracking of open positions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS positions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address         TEXT    NOT NULL UNIQUE,
  entry_price_lamports  INTEGER NOT NULL,
  amount_sol            REAL    NOT NULL,
  token_amount          INTEGER NOT NULL,    -- raw token units held
  bonding_pct           REAL    NOT NULL DEFAULT 0,
  status                TEXT    NOT NULL DEFAULT 'open'
                          CHECK(status IN ('open', 'dex_launched', 'closed',
                                           'stop_loss', 'profit_target')),
  trade_id              INTEGER REFERENCES trades(id),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions (status);

-- ------------------------------------------------------------
-- rpc_stats: per-endpoint health metrics (upserted by monitor)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rpc_stats (
  endpoint        TEXT    PRIMARY KEY,
  requests        INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms  REAL    NOT NULL DEFAULT 0,
  last_checked    INTEGER NOT NULL DEFAULT 0  -- Unix ms
);
