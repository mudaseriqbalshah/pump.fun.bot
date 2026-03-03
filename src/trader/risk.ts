import type { TradingConfig } from '../config/schema.js';
import type { DatabaseClient } from '../db/client.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RiskCheckInput {
  tokenAddress: string;
  /** Current bonding curve completion percentage (0–100). */
  bondingPct: number;
  /** Aggregated confidence score (0–1) from the signal pipeline. */
  signalConfidence: number;
  /** Desired position size in SOL. If omitted, config max is used. */
  proposedSizeSol?: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  /** Human-readable denial reason; only present when allowed = false. */
  reason?: string;
  /** Final position size in SOL (0 when denied, clamped to max when allowed). */
  positionSizeSol: number;
}

// ---------------------------------------------------------------------------
// RiskManager
// ---------------------------------------------------------------------------

export class RiskManager {
  private readonly cfg: TradingConfig;
  private readonly db: DatabaseClient;

  constructor(config: TradingConfig, db: DatabaseClient) {
    this.cfg = config;
    this.db = db;
  }

  /**
   * Run all risk checks for a prospective buy.
   * Returns immediately on the first failure so the reason is unambiguous.
   */
  check(input: RiskCheckInput): RiskCheckResult {
    const { tokenAddress, bondingPct, signalConfidence, proposedSizeSol } = input;

    // 1. Signal confidence must meet minimum threshold.
    if (signalConfidence < this.cfg.min_signal_confidence) {
      return this.deny(
        tokenAddress,
        `signal confidence ${signalConfidence.toFixed(2)} < minimum ${this.cfg.min_signal_confidence}`,
      );
    }

    // 2. Bonding curve must not already be too close to completion.
    if (bondingPct >= this.cfg.max_bonding_curve_pct) {
      return this.deny(
        tokenAddress,
        `bonding curve ${bondingPct.toFixed(1)}% >= max ${this.cfg.max_bonding_curve_pct}%`,
      );
    }

    // 3. No duplicate position in the same token.
    const existing = this.db.getPosition(tokenAddress);
    if (existing && (existing.status === 'open' || existing.status === 'dex_launched')) {
      return this.deny(
        tokenAddress,
        `already have an open position (status=${existing.status})`,
      );
    }

    // 4. Max concurrent open positions.
    const openCount = this.db.getOpenPositions().length;
    if (openCount >= this.cfg.max_open_positions) {
      return this.deny(
        tokenAddress,
        `max open positions reached (${openCount}/${this.cfg.max_open_positions})`,
      );
    }

    // 5. Daily loss hard stop.
    const dailyPnl = this.db.getDailyPnlSol();
    if (dailyPnl <= -this.cfg.max_daily_loss_sol) {
      return this.deny(
        tokenAddress,
        `daily loss limit hit (${dailyPnl.toFixed(4)} SOL ≤ -${this.cfg.max_daily_loss_sol} SOL) — trading halted for today`,
      );
    }

    // All checks passed — clamp position size to configured maximum.
    const positionSizeSol = Math.min(
      proposedSizeSol ?? this.cfg.max_position_sol,
      this.cfg.max_position_sol,
    );

    logger.debug(
      { tokenAddress, positionSizeSol, openCount, dailyPnl, bondingPct, signalConfidence },
      'Risk check passed',
    );

    return { allowed: true, positionSizeSol };
  }

  /** Convenience: get the current daily PnL from the DB. */
  getDailyPnlSol(): number {
    return this.db.getDailyPnlSol();
  }

  /** Convenience: get the count of currently open positions. */
  getOpenPositionCount(): number {
    return this.db.getOpenPositions().length;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private deny(tokenAddress: string, reason: string): RiskCheckResult {
    logger.warn({ tokenAddress, reason }, 'Risk check denied');
    return { allowed: false, reason, positionSizeSol: 0 };
  }
}
