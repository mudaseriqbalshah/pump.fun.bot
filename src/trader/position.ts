import { EventEmitter } from 'events';
import type { BondingCurveTracker } from '../scanner/bonding.js';
import type { RaydiumDetector, PoolFoundPayload } from '../dex/raydium.js';
import type { JupiterDetector } from '../dex/jupiter.js';
import type { Seller } from './seller.js';
import type { DatabaseClient } from '../db/client.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * Per-position runtime state.  Lives in-memory only; the DB is the source of
 * truth for persistence across restarts.
 */
interface PositionState {
  tokenAddress: string;
  /** Current lifecycle phase. */
  phase: 'bonding' | 'dex_launched';
  /**
   * True once a Raydium pool or Jupiter route has been confirmed for this
   * token.  False on startup (re-verified on first tick).
   */
  dexLive: boolean;
  /**
   * Guards against concurrent `seller.sell()` calls for the same position.
   * Set to true before each sell attempt, reset on non-terminal failures.
   */
  sellInFlight: boolean;
  /** SOL spent at buy time — for log context only. */
  amountSol: number;
  /** Unix ms when the position was opened. */
  heldSinceMs: number;
}

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

export interface DexLaunchEvent {
  tokenAddress: string;
}

export interface PositionClosedEvent {
  tokenAddress: string;
  pnlSol: number;
  pnlPct: number;
  trigger: 'profit_target' | 'stop_loss' | 'ai_early';
}

// ---------------------------------------------------------------------------
// PositionTracker
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 10_000;

/**
 * Tracks all open positions from buy → bonding curve completion → DEX listing
 * → sell.
 *
 * State machine per position:
 *   bonding       — polls bonding curve % every `pollIntervalMs`
 *                   → transitions to `dex_launched` when curve.complete
 *   dex_launched  — watches for a Raydium CPMM pool (event) or falls back to
 *                   Jupiter polling; once DEX is confirmed live, evaluates sell
 *                   thresholds each tick until filled
 *
 * Emitted events:
 *   'dex_launch'       → DexLaunchEvent      (for notifications)
 *   'position_closed'  → PositionClosedEvent  (for notifications + daily PnL log)
 */
export class PositionTracker extends EventEmitter {
  private readonly bondingTracker: BondingCurveTracker;
  private readonly raydiumDetector: RaydiumDetector;
  private readonly jupiterDetector: JupiterDetector;
  private readonly seller: Seller;
  private readonly db: DatabaseClient;

  /** tokenAddress → live runtime state */
  private readonly positions = new Map<string, PositionState>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    bondingTracker: BondingCurveTracker,
    raydiumDetector: RaydiumDetector,
    jupiterDetector: JupiterDetector,
    seller: Seller,
    db: DatabaseClient,
  ) {
    super();
    this.bondingTracker = bondingTracker;
    this.raydiumDetector = raydiumDetector;
    this.jupiterDetector = jupiterDetector;
    this.seller = seller;
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start tracking.
   *
   * 1. Recovers any open/dex_launched positions from the DB (crash recovery).
   * 2. Wires `RaydiumDetector.pool_found` events.
   * 3. Starts the `RaydiumDetector` poller.
   * 4. Starts the main bonding-curve / sell-evaluation tick loop.
   */
  start(pollIntervalMs: number = DEFAULT_POLL_MS): void {
    this.syncFromDb();

    this.raydiumDetector.on('pool_found', (payload: PoolFoundPayload) => {
      void this.onRaydiumPool(payload);
    });
    this.raydiumDetector.start();

    this.pollTimer = setInterval(() => void this.tick(), pollIntervalMs);
    this.pollTimer.unref();

    logger.info(
      { pollIntervalMs, positions: this.positions.size },
      'PositionTracker started',
    );
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.raydiumDetector.stop();
    logger.info({ positions: this.positions.size }, 'PositionTracker stopped');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Register a newly purchased position.
   * Call this from the orchestrator immediately after `Buyer.buy()` succeeds.
   */
  addPosition(tokenAddress: string): void {
    if (this.positions.has(tokenAddress)) {
      logger.debug({ tokenAddress }, 'PositionTracker.addPosition: already tracked');
      return;
    }

    const row = this.db.getPosition(tokenAddress);
    if (!row) {
      logger.warn({ tokenAddress }, 'PositionTracker.addPosition: no DB row found');
      return;
    }

    const isDexLaunched = row.status === 'dex_launched';
    this.positions.set(tokenAddress, {
      tokenAddress,
      phase: isDexLaunched ? 'dex_launched' : 'bonding',
      dexLive: false,
      sellInFlight: false,
      amountSol: row.amount_sol,
      heldSinceMs: row.created_at,
    });

    if (isDexLaunched) {
      this.raydiumDetector.watch(tokenAddress);
    }

    logger.info(
      { tokenAddress, phase: isDexLaunched ? 'dex_launched' : 'bonding' },
      'Position registered with tracker',
    );
  }

  /** Number of positions currently under active management. */
  get positionCount(): number {
    return this.positions.size;
  }

  // ---------------------------------------------------------------------------
  // Private — tick loop
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    for (const state of this.positions.values()) {
      try {
        if (state.phase === 'bonding') {
          await this.checkBonding(state);
        } else if (!state.dexLive) {
          // Bonding curve complete but pool not yet confirmed — Jupiter fallback.
          await this.checkJupiterFallback(state);
        } else if (!state.sellInFlight) {
          // DEX confirmed live — evaluate profit/stop-loss thresholds.
          void this.attemptSell(state.tokenAddress);
        }
      } catch (err) {
        logger.error(
          { tokenAddress: state.tokenAddress, err },
          'PositionTracker: unhandled tick error',
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — bonding curve phase
  // ---------------------------------------------------------------------------

  private async checkBonding(state: PositionState): Promise<void> {
    const curve = await this.bondingTracker.fetch(state.tokenAddress);
    if (!curve) return;

    this.db.updatePositionBonding(state.tokenAddress, curve.percentComplete);

    logger.debug(
      {
        tokenAddress: state.tokenAddress,
        bondingPct: curve.percentComplete.toFixed(1),
        marketCapSol: curve.marketCapSol.toFixed(2),
      },
      'Bonding curve tick',
    );

    if (curve.complete) {
      state.phase = 'dex_launched';
      this.db.updatePositionStatus(state.tokenAddress, 'dex_launched');
      this.raydiumDetector.watch(state.tokenAddress);

      logger.info({ tokenAddress: state.tokenAddress }, 'Bonding curve complete — DEX launch imminent');
      this.emit('dex_launch', { tokenAddress: state.tokenAddress } satisfies DexLaunchEvent);
    }
  }

  // ---------------------------------------------------------------------------
  // Private — DEX detection phase
  // ---------------------------------------------------------------------------

  /** Jupiter fallback: polled each tick when we haven't yet confirmed a pool. */
  private async checkJupiterFallback(state: PositionState): Promise<void> {
    const isLive = await this.jupiterDetector.isLive(state.tokenAddress);
    if (!isLive) return;

    logger.info({ tokenAddress: state.tokenAddress }, 'Jupiter confirmed DEX live (fallback)');
    state.dexLive = true;
    // Raydium was watching too — stop it since Jupiter already confirmed.
    this.raydiumDetector.unwatch(state.tokenAddress);
    void this.attemptSell(state.tokenAddress);
  }

  /** Triggered by `RaydiumDetector.pool_found` event. */
  private async onRaydiumPool(payload: PoolFoundPayload): Promise<void> {
    const state = this.positions.get(payload.mintAddress);
    if (!state) return; // pool for a token we don't own

    logger.info(
      { tokenAddress: payload.mintAddress, poolAddress: payload.poolAddress },
      'Raydium CPMM pool confirmed — evaluating sell',
    );

    state.dexLive = true;
    void this.attemptSell(payload.mintAddress);
  }

  // ---------------------------------------------------------------------------
  // Private — sell evaluation
  // ---------------------------------------------------------------------------

  /**
   * Call `Seller.sell()` for the given token.
   *
   * - If the sell executes → remove position, emit `'position_closed'`.
   * - If thresholds not met / network error → reset `sellInFlight` so the
   *   next tick can evaluate again.
   */
  private async attemptSell(tokenAddress: string): Promise<void> {
    const state = this.positions.get(tokenAddress);
    if (!state || state.sellInFlight) return;

    state.sellInFlight = true;

    try {
      const result = await this.seller.sell(tokenAddress);

      if (result.success) {
        this.positions.delete(tokenAddress);
        this.raydiumDetector.unwatch(tokenAddress);

        const elapsed = ((Date.now() - state.heldSinceMs) / 60_000).toFixed(1);
        logger.info(
          {
            tokenAddress,
            pnlPct: result.pnlPct.toFixed(2),
            pnlSol: result.pnlSol.toFixed(6),
            trigger: result.trigger,
            heldMinutes: elapsed,
          },
          'Position closed',
        );

        this.emit('position_closed', {
          tokenAddress,
          pnlSol: result.pnlSol,
          pnlPct: result.pnlPct,
          trigger: result.trigger,
        } satisfies PositionClosedEvent);
      } else {
        // Not sold yet — keep watching and retry on the next tick.
        logger.debug({ tokenAddress, reason: result.reason }, 'Sell deferred');
        state.sellInFlight = false;
      }
    } catch (err) {
      logger.error({ tokenAddress, err }, 'PositionTracker: sell threw unexpectedly');
      state.sellInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — DB sync (startup recovery)
  // ---------------------------------------------------------------------------

  /**
   * Reload open and dex_launched positions from the DB.
   * Called once at `start()` to recover state across bot restarts.
   */
  private syncFromDb(): void {
    const rows = this.db.getOpenPositions();
    for (const row of rows) {
      const isDexLaunched = row.status === 'dex_launched';
      this.positions.set(row.token_address, {
        tokenAddress: row.token_address,
        phase: isDexLaunched ? 'dex_launched' : 'bonding',
        dexLive: false, // will re-verify on first tick / Raydium poll
        sellInFlight: false,
        amountSol: row.amount_sol,
        heldSinceMs: row.created_at,
      });

      if (isDexLaunched) {
        this.raydiumDetector.watch(row.token_address);
      }

      logger.debug(
        { tokenAddress: row.token_address, status: row.status },
        'Recovered position from DB',
      );
    }
    logger.info({ recovered: rows.length }, 'PositionTracker: DB sync complete');
  }
}
