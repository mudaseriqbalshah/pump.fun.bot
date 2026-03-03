import Database, { type Database as DB } from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../../');

const DB_PATH = process.env.DB_PATH ?? resolve(ROOT, 'data/pumpbot.db');
const SCHEMA_PATH = resolve(ROOT, 'src/db/schema.sql');

// ---------------------------------------------------------------------------
// Row types  (mirror schema.sql column names)
// ---------------------------------------------------------------------------

export type SignalSource = 'telegram' | 'discord';
export type TradeStatus = 'open' | 'closed' | 'failed';
export type PositionStatus = 'open' | 'dex_launched' | 'closed' | 'stop_loss' | 'profit_target';

export interface SignalRow {
  id: number;
  source: SignalSource;
  channel_id: string;
  token_address: string;
  ticker: string | null;
  confidence: number;
  raw_message: string;
  created_at: number;
}

export interface TradeRow {
  id: number;
  token_address: string;
  buy_price_lamports: number;
  sell_price_lamports: number | null;
  amount_sol: number;
  pnl_sol: number | null;
  pnl_pct: number | null;
  status: TradeStatus;
  buy_tx: string;
  sell_tx: string | null;
  signal_id: number | null;
  created_at: number;
  closed_at: number | null;
}

export interface PositionRow {
  id: number;
  token_address: string;
  entry_price_lamports: number;
  amount_sol: number;
  token_amount: number;
  bonding_pct: number;
  status: PositionStatus;
  trade_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface RpcStatsRow {
  endpoint: string;
  requests: number;
  errors: number;
  avg_latency_ms: number;
  last_checked: number;
}

export interface ChannelStats {
  totalTrades: number;
  winRate: number;    // 0–1
  avgPnlPct: number;
  avgWinPct: number;
  avgLossPct: number;
}

export interface TradeStats {
  /** Aggregate stats across all closed trades. */
  overall: ChannelStats;
  /** Per-channel breakdown keyed by channel_id. */
  byChannel: Record<string, ChannelStats>;
  /**
   * Recent momentum: positive = N-trade winning streak,
   * negative = N-trade losing streak, 0 = mixed or no data.
   */
  recentStreak: number;
}

// ---------------------------------------------------------------------------
// Insert / update input types
// ---------------------------------------------------------------------------

export interface InsertSignal {
  source: SignalSource;
  channel_id: string;
  token_address: string;
  ticker?: string;
  confidence: number;
  raw_message: string;
}

export interface InsertTrade {
  token_address: string;
  buy_price_lamports: number;
  amount_sol: number;
  buy_tx: string;
  signal_id?: number;
}

export interface UpdateTradeSold {
  id: number;
  sell_price_lamports: number;
  pnl_sol: number;
  pnl_pct: number;
  sell_tx: string;
  status: TradeStatus;
}

export interface InsertPosition {
  token_address: string;
  entry_price_lamports: number;
  amount_sol: number;
  token_amount: number;
  trade_id?: number;
}

// ---------------------------------------------------------------------------
// DatabaseClient
// ---------------------------------------------------------------------------

export class DatabaseClient {
  readonly db: DB;

  constructor(dbPath: string = DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.configure();
    this.migrate();
    logger.info({ path: dbPath }, 'Database opened');
  }

  // ---------------------------------------------------------------------------
  // signals
  // ---------------------------------------------------------------------------

  insertSignal(row: InsertSignal): number {
    const result = this.db.prepare(`
      INSERT INTO signals (source, channel_id, token_address, ticker, confidence, raw_message, created_at)
      VALUES (@source, @channel_id, @token_address, @ticker, @confidence, @raw_message, @created_at)
    `).run({ ...row, ticker: row.ticker ?? null, created_at: Date.now() });
    return result.lastInsertRowid as number;
  }

  getRecentSignals(tokenAddress: string, windowMs: number): SignalRow[] {
    return this.db.prepare(`
      SELECT * FROM signals
      WHERE token_address = ? AND created_at >= ?
      ORDER BY created_at DESC
    `).all(tokenAddress, Date.now() - windowMs) as SignalRow[];
  }

  // ---------------------------------------------------------------------------
  // trades
  // ---------------------------------------------------------------------------

  insertTrade(row: InsertTrade): number {
    const result = this.db.prepare(`
      INSERT INTO trades
        (token_address, buy_price_lamports, amount_sol, buy_tx, signal_id, status, created_at)
      VALUES
        (@token_address, @buy_price_lamports, @amount_sol, @buy_tx, @signal_id, 'open', @created_at)
    `).run({ ...row, signal_id: row.signal_id ?? null, created_at: Date.now() });
    return result.lastInsertRowid as number;
  }

  updateTradeSold(row: UpdateTradeSold): void {
    this.db.prepare(`
      UPDATE trades
      SET sell_price_lamports = @sell_price_lamports,
          pnl_sol             = @pnl_sol,
          pnl_pct             = @pnl_pct,
          sell_tx             = @sell_tx,
          status              = @status,
          closed_at           = @closed_at
      WHERE id = @id
    `).run({ ...row, closed_at: Date.now() });
  }

  getOpenTrades(): TradeRow[] {
    return this.db.prepare(
      `SELECT * FROM trades WHERE status = 'open'`,
    ).all() as TradeRow[];
  }

  getTradeByToken(tokenAddress: string): TradeRow | undefined {
    return this.db.prepare(
      `SELECT * FROM trades WHERE token_address = ? AND status = 'open' LIMIT 1`,
    ).get(tokenAddress) as TradeRow | undefined;
  }

  // ---------------------------------------------------------------------------
  // positions
  // ---------------------------------------------------------------------------

  insertPosition(row: InsertPosition): number {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO positions
        (token_address, entry_price_lamports, amount_sol, token_amount, trade_id, status, created_at, updated_at)
      VALUES
        (@token_address, @entry_price_lamports, @amount_sol, @token_amount, @trade_id, 'open', @now, @now)
    `).run({ ...row, trade_id: row.trade_id ?? null, now });
    return result.lastInsertRowid as number;
  }

  updatePositionBonding(tokenAddress: string, bondingPct: number): void {
    this.db.prepare(`
      UPDATE positions SET bonding_pct = ?, updated_at = ? WHERE token_address = ?
    `).run(bondingPct, Date.now(), tokenAddress);
  }

  updatePositionStatus(tokenAddress: string, status: PositionStatus): void {
    this.db.prepare(`
      UPDATE positions SET status = ?, updated_at = ? WHERE token_address = ?
    `).run(status, Date.now(), tokenAddress);
  }

  getOpenPositions(): PositionRow[] {
    return this.db.prepare(
      `SELECT * FROM positions WHERE status IN ('open', 'dex_launched')`,
    ).all() as PositionRow[];
  }

  getPosition(tokenAddress: string): PositionRow | undefined {
    return this.db.prepare(
      `SELECT * FROM positions WHERE token_address = ? LIMIT 1`,
    ).get(tokenAddress) as PositionRow | undefined;
  }

  deletePosition(tokenAddress: string): void {
    this.db.prepare(`DELETE FROM positions WHERE token_address = ?`).run(tokenAddress);
  }

  /**
   * Returns trading performance stats for use by the AI advisor.
   * Includes overall win rate, per-channel breakdown, and recent win/loss streak.
   * All queries are read-only and safe to call frequently.
   */
  getTradeStats(): TradeStats {
    // Overall aggregate
    const overall = this.db.prepare(`
      SELECT
        COUNT(*)                                                   AS total,
        SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END)             AS wins,
        AVG(pnl_pct)                                               AS avg_pnl,
        AVG(CASE WHEN pnl_pct > 0 THEN pnl_pct ELSE NULL END)     AS avg_win,
        AVG(CASE WHEN pnl_pct <= 0 THEN pnl_pct ELSE NULL END)    AS avg_loss
      FROM trades
      WHERE status = 'closed'
    `).get() as { total: number; wins: number; avg_pnl: number; avg_win: number; avg_loss: number };

    // Per-channel breakdown
    const channelRows = this.db.prepare(`
      SELECT
        s.channel_id,
        COUNT(*)                                                    AS total,
        SUM(CASE WHEN t.pnl_pct > 0 THEN 1 ELSE 0 END)            AS wins,
        AVG(t.pnl_pct)                                              AS avg_pnl,
        AVG(CASE WHEN t.pnl_pct > 0 THEN t.pnl_pct ELSE NULL END)  AS avg_win,
        AVG(CASE WHEN t.pnl_pct <= 0 THEN t.pnl_pct ELSE NULL END) AS avg_loss
      FROM trades t
      JOIN signals s ON t.signal_id = s.id
      WHERE t.status = 'closed' AND s.channel_id IS NOT NULL
      GROUP BY s.channel_id
      ORDER BY total DESC
      LIMIT 20
    `).all() as {
      channel_id: string;
      total: number;
      wins: number;
      avg_pnl: number;
      avg_win: number;
      avg_loss: number;
    }[];

    // Recent streak — last 8 closed trades
    const recent = this.db.prepare(`
      SELECT pnl_pct FROM trades
      WHERE status = 'closed'
      ORDER BY closed_at DESC
      LIMIT 8
    `).all() as { pnl_pct: number }[];

    let recentStreak = 0;
    if (recent.length > 0) {
      const firstIsWin = recent[0].pnl_pct > 0;
      for (const t of recent) {
        if ((t.pnl_pct > 0) === firstIsWin) recentStreak += firstIsWin ? 1 : -1;
        else break;
      }
    }

    function toChannelStats(row: {
      total: number;
      wins: number;
      avg_pnl: number;
      avg_win: number;
      avg_loss: number;
    }): ChannelStats {
      return {
        totalTrades: row.total,
        winRate: row.total > 0 ? row.wins / row.total : 0,
        avgPnlPct: row.avg_pnl ?? 0,
        avgWinPct: row.avg_win ?? 0,
        avgLossPct: row.avg_loss ?? 0,
      };
    }

    return {
      overall: toChannelStats(overall),
      byChannel: Object.fromEntries(channelRows.map((r) => [r.channel_id, toChannelStats(r)])),
      recentStreak,
    };
  }

  /**
   * Sum of pnl_sol for all closed trades since midnight today (local time).
   * Returns a negative number when there are net losses, 0 when no closed trades.
   */
  getDailyPnlSol(): number {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(pnl_sol), 0) AS total
      FROM trades
      WHERE closed_at >= ? AND status = 'closed'
    `).get(startOfDay.getTime()) as { total: number };
    return row.total;
  }

  // ---------------------------------------------------------------------------
  // rpc_stats
  // ---------------------------------------------------------------------------

  upsertRpcStats(row: RpcStatsRow): void {
    this.db.prepare(`
      INSERT INTO rpc_stats (endpoint, requests, errors, avg_latency_ms, last_checked)
      VALUES (@endpoint, @requests, @errors, @avg_latency_ms, @last_checked)
      ON CONFLICT(endpoint) DO UPDATE SET
        requests       = excluded.requests,
        errors         = excluded.errors,
        avg_latency_ms = excluded.avg_latency_ms,
        last_checked   = excluded.last_checked
    `).run(row);
  }

  getRpcStats(): RpcStatsRow[] {
    return this.db.prepare(`SELECT * FROM rpc_stats ORDER BY avg_latency_ms ASC`).all() as RpcStatsRow[];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** List all table names — useful for verifying setup. */
  tables(): string[] {
    const rows = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  close(): void {
    this.db.close();
    logger.info('Database closed');
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private configure(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
  }

  private migrate(): void {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    this.db.exec(schema);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

let _db: DatabaseClient | null = null;

export function getDb(): DatabaseClient {
  if (!_db) _db = new DatabaseClient();
  return _db;
}
