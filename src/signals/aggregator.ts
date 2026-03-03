import { EventEmitter } from 'events';
import type { DatabaseClient } from '../db/client.js';
import type { Signal, SignalSource } from './types.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Internal state per token
// ---------------------------------------------------------------------------

interface SignalWindow {
  tokenAddress: string;
  firstTimestamp: number;
  /** Unique sources seen in this window — used to compute multi-source boost. */
  sources: Set<SignalSource>;
  /** All raw signals received in this window. */
  signals: Signal[];
  /** Highest individual confidence across all signals in this window. */
  maxConfidence: number;
  /** True after we've already emitted a qualified signal for this window. */
  emitted: boolean;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AggregatorConfig {
  /** Minimum aggregated confidence to forward to buyer (0–1). */
  minConfidence: number;
  /** Deduplication window length in milliseconds. */
  dedupWindowMs: number;
  /** Confidence boost per additional unique source (+0.2 per extra source, capped at 1). */
  multiSourceBoost?: number;
}

// ---------------------------------------------------------------------------
// SignalAggregator
// ---------------------------------------------------------------------------

export class SignalAggregator extends EventEmitter {
  private readonly cfg: Required<AggregatorConfig>;
  private readonly db: DatabaseClient;

  /** tokenAddress → active dedup window */
  private readonly windows = new Map<string, SignalWindow>();

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AggregatorConfig, db: DatabaseClient) {
    super();
    this.cfg = { multiSourceBoost: 0.2, ...config };
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    // Periodic GC of expired windows so the Map doesn't grow forever.
    this.cleanupTimer = setInterval(
      () => this.evictExpired(),
      this.cfg.dedupWindowMs,
    );
    this.cleanupTimer.unref();
    logger.info(
      { minConfidence: this.cfg.minConfidence, dedupWindowMs: this.cfg.dedupWindowMs },
      'Signal aggregator started',
    );
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.windows.clear();
    logger.info('Signal aggregator stopped');
  }

  /**
   * Subscribe to a monitor's `signal` events.
   * Call once for each TelegramMonitor / DiscordMonitor.
   */
  register(monitor: EventEmitter): void {
    monitor.on('signal', (signal: Signal) => this.ingest(signal));
  }

  // ---------------------------------------------------------------------------
  // Core ingestion logic
  // ---------------------------------------------------------------------------

  private ingest(signal: Signal): void {
    // 1. Persist every raw signal to the DB for auditing / replay.
    this.persistSignal(signal);

    const now = Date.now();

    // 2. Find or create a dedup window for this token.
    let win = this.windows.get(signal.tokenAddress);
    const expired = win !== undefined && now - win.firstTimestamp > this.cfg.dedupWindowMs;

    if (!win || expired) {
      // New token or stale window — start fresh.
      win = {
        tokenAddress: signal.tokenAddress,
        firstTimestamp: now,
        sources: new Set([signal.source]),
        signals: [signal],
        maxConfidence: signal.confidence,
        emitted: false,
      };
      this.windows.set(signal.tokenAddress, win);
    } else {
      // Active window — update state.
      win.sources.add(signal.source);
      win.signals.push(signal);
      if (signal.confidence > win.maxConfidence) {
        win.maxConfidence = signal.confidence;
      }
    }

    // 3. Compute boosted confidence.
    const boosted = this.computeConfidence(win);

    logger.debug(
      {
        tokenAddress: signal.tokenAddress,
        source: signal.source,
        rawConfidence: signal.confidence.toFixed(2),
        boostedConfidence: boosted.toFixed(2),
        sources: [...win.sources],
        signalsInWindow: win.signals.length,
        emitted: win.emitted,
      },
      'Signal ingested',
    );

    // 4. Emit at most ONCE per dedup window when confidence threshold is met.
    if (!win.emitted && boosted >= this.cfg.minConfidence) {
      win.emitted = true;

      // Use the signal with the highest individual confidence as the base;
      // override its confidence with the boosted value.
      const best = win.signals.reduce((a, b) => (a.confidence >= b.confidence ? a : b));

      const qualified: Signal = {
        ...best,
        confidence: boosted,
      };

      logger.info(
        {
          tokenAddress: qualified.tokenAddress,
          ticker: qualified.ticker,
          confidence: boosted.toFixed(2),
          sources: [...win.sources],
        },
        'Signal qualified — forwarding to buyer',
      );

      this.emit('signal', qualified);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Confidence = max individual score + multiSourceBoost × (unique sources − 1).
   * Clamped to [0, 1].
   */
  private computeConfidence(win: SignalWindow): number {
    const boost = this.cfg.multiSourceBoost * (win.sources.size - 1);
    return Math.min(1.0, win.maxConfidence + boost);
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.cfg.dedupWindowMs;
    let evicted = 0;
    for (const [addr, win] of this.windows) {
      if (win.firstTimestamp < cutoff) {
        this.windows.delete(addr);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.debug({ evicted, remaining: this.windows.size }, 'Evicted expired signal windows');
    }
  }

  private persistSignal(signal: Signal): void {
    try {
      this.db.insertSignal({
        source: signal.source,
        channel_id: signal.channelId,
        token_address: signal.tokenAddress,
        ticker: signal.ticker,
        confidence: signal.confidence,
        raw_message: signal.rawMessage,
      });
    } catch (err) {
      logger.warn({ err, tokenAddress: signal.tokenAddress }, 'Failed to persist signal to DB');
    }
  }

  // Expose for monitoring / testing.
  get activeWindowCount(): number {
    return this.windows.size;
  }
}
