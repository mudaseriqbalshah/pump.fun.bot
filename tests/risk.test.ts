import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseClient } from '../src/db/client.js';
import { RiskManager } from '../src/trader/risk.js';
import type { TradingConfig } from '../src/config/schema.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_CONFIG: TradingConfig = {
  wallet_keypair_path: '~/.config/solana/id.json',
  max_position_sol: 0.5,
  max_open_positions: 3,
  max_daily_loss_sol: 2.0,
  max_bonding_curve_pct: 50,
  min_signal_confidence: 0.6,
  profit_target_pct: 200,
  stop_loss_pct: -30,
  slippage_bps: 1000,
  buy_retry_count: 3,
  signal_dedup_window_s: 60,
};

const VALID: Parameters<RiskManager['check']>[0] = {
  tokenAddress: 'TOKEN_GOOD',
  bondingPct: 25,
  signalConfidence: 0.8,
};

// ---------------------------------------------------------------------------
// Helper: insert a closed trade with an explicit PnL value
// ---------------------------------------------------------------------------
function insertClosedTrade(
  db: DatabaseClient,
  tokenAddress: string,
  pnlSol: number,
): void {
  const tradeId = db.insertTrade({
    token_address: tokenAddress,
    buy_price_lamports: 1_000_000,
    amount_sol: 1.0,
    buy_tx: `buy_tx_${tokenAddress}`,
  });
  db.updateTradeSold({
    id: tradeId,
    sell_price_lamports: pnlSol >= 0 ? 1_500_000 : 700_000,
    pnl_sol: pnlSol,
    pnl_pct: pnlSol * 100,
    sell_tx: `sell_tx_${tokenAddress}`,
    status: 'closed',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RiskManager.check()', () => {
  let db: DatabaseClient;
  let risk: RiskManager;

  beforeEach(() => {
    db = new DatabaseClient(':memory:');
    risk = new RiskManager(TEST_CONFIG, db);
  });

  afterEach(() => {
    db.close();
  });

  // ---- confidence ----------------------------------------------------------

  it('denies when signal confidence is below the minimum', () => {
    const result = risk.check({ ...VALID, signalConfidence: 0.5 });

    expect(result.allowed).toBe(false);
    expect(result.positionSizeSol).toBe(0);
    expect(result.reason).toMatch(/confidence/i);
  });

  it('allows when signal confidence equals the minimum exactly', () => {
    const result = risk.check({ ...VALID, signalConfidence: TEST_CONFIG.min_signal_confidence });

    expect(result.allowed).toBe(true);
  });

  // ---- bonding curve -------------------------------------------------------

  it('denies when bonding curve % equals the maximum', () => {
    const result = risk.check({ ...VALID, bondingPct: TEST_CONFIG.max_bonding_curve_pct });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/bonding/i);
  });

  it('denies when bonding curve % exceeds the maximum', () => {
    const result = risk.check({ ...VALID, bondingPct: 75 });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/bonding/i);
  });

  it('allows when bonding curve % is just below the maximum', () => {
    const result = risk.check({ ...VALID, bondingPct: TEST_CONFIG.max_bonding_curve_pct - 1 });

    expect(result.allowed).toBe(true);
  });

  // ---- duplicate position --------------------------------------------------

  it('denies when an open position already exists for the token', () => {
    const tradeId = db.insertTrade({
      token_address: VALID.tokenAddress,
      buy_price_lamports: 1_000_000,
      amount_sol: 0.5,
      buy_tx: 'some_tx',
    });
    db.insertPosition({
      token_address: VALID.tokenAddress,
      entry_price_lamports: 1_000_000,
      amount_sol: 0.5,
      token_amount: 500_000,
      trade_id: tradeId,
    });

    const result = risk.check({ ...VALID });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/position/i);
  });

  it('allows when a position for the same token is already closed', () => {
    const tradeId = db.insertTrade({
      token_address: VALID.tokenAddress,
      buy_price_lamports: 1_000_000,
      amount_sol: 0.5,
      buy_tx: 'some_tx',
    });
    db.insertPosition({
      token_address: VALID.tokenAddress,
      entry_price_lamports: 1_000_000,
      amount_sol: 0.5,
      token_amount: 500_000,
      trade_id: tradeId,
    });
    db.updatePositionStatus(VALID.tokenAddress, 'closed');

    const result = risk.check({ ...VALID });

    expect(result.allowed).toBe(true);
  });

  // ---- max open positions --------------------------------------------------

  it('denies when max open positions is reached', () => {
    // Fill up to the limit.
    for (let i = 0; i < TEST_CONFIG.max_open_positions; i++) {
      const addr = `TOKEN_SLOT_${i}`;
      const tradeId = db.insertTrade({
        token_address: addr,
        buy_price_lamports: 1_000_000,
        amount_sol: 0.5,
        buy_tx: `buy_${i}`,
      });
      db.insertPosition({
        token_address: addr,
        entry_price_lamports: 1_000_000,
        amount_sol: 0.5,
        token_amount: 500_000,
        trade_id: tradeId,
      });
    }

    const result = risk.check({ ...VALID });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/max open positions/i);
  });

  it('allows when one position slot is still available', () => {
    // One fewer than the limit.
    for (let i = 0; i < TEST_CONFIG.max_open_positions - 1; i++) {
      const addr = `TOKEN_SLOT_${i}`;
      const tradeId = db.insertTrade({
        token_address: addr,
        buy_price_lamports: 1_000_000,
        amount_sol: 0.5,
        buy_tx: `buy_${i}`,
      });
      db.insertPosition({
        token_address: addr,
        entry_price_lamports: 1_000_000,
        amount_sol: 0.5,
        token_amount: 500_000,
        trade_id: tradeId,
      });
    }

    const result = risk.check({ ...VALID });

    expect(result.allowed).toBe(true);
  });

  // ---- daily loss ----------------------------------------------------------

  it('denies when daily loss exactly equals the limit', () => {
    insertClosedTrade(db, 'TOKEN_LOSS_A', -TEST_CONFIG.max_daily_loss_sol);

    const result = risk.check({ ...VALID });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily loss/i);
  });

  it('denies when daily loss exceeds the limit across multiple trades', () => {
    insertClosedTrade(db, 'TOKEN_LOSS_A', -1.2);
    insertClosedTrade(db, 'TOKEN_LOSS_B', -0.9); // total = -2.1 > -2.0

    const result = risk.check({ ...VALID });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily loss/i);
  });

  it('allows when daily losses are below the limit', () => {
    insertClosedTrade(db, 'TOKEN_LOSS_A', -1.0); // -1.0 < -2.0 limit

    const result = risk.check({ ...VALID });

    expect(result.allowed).toBe(true);
  });

  it('does not count winning trades against the daily loss limit', () => {
    insertClosedTrade(db, 'TOKEN_WIN_A', +2.5);
    insertClosedTrade(db, 'TOKEN_LOSS_A', -1.9); // net = +0.6

    const result = risk.check({ ...VALID });

    expect(result.allowed).toBe(true);
  });

  // ---- position sizing -----------------------------------------------------

  it('clamps position size to config max when proposed size is larger', () => {
    const result = risk.check({ ...VALID, proposedSizeSol: 5.0 });

    expect(result.allowed).toBe(true);
    expect(result.positionSizeSol).toBe(TEST_CONFIG.max_position_sol);
  });

  it('uses proposed size when it is within the config max', () => {
    const result = risk.check({ ...VALID, proposedSizeSol: 0.2 });

    expect(result.allowed).toBe(true);
    expect(result.positionSizeSol).toBe(0.2);
  });

  it('defaults to config max when no proposed size is given', () => {
    const result = risk.check({ ...VALID });

    expect(result.allowed).toBe(true);
    expect(result.positionSizeSol).toBe(TEST_CONFIG.max_position_sol);
  });

  // ---- full happy-path -----------------------------------------------------

  it('allows a valid trade and returns 0 denied fields', () => {
    const result = risk.check(VALID);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.positionSizeSol).toBeGreaterThan(0);
  });
});
