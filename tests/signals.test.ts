import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { DatabaseClient } from '../src/db/client.js';
import { SignalAggregator } from '../src/signals/aggregator.js';
import type { Signal } from '../src/signals/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  minConfidence: 0.6,
  dedupWindowMs: 60_000,
  multiSourceBoost: 0.2,
};

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    source: 'telegram',
    channelId: '-1001234567890',
    tokenAddress: 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ticker: 'TKN',
    rawMessage: 'buy this gem',
    confidence: 0.75,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SignalAggregator', () => {
  let db: DatabaseClient;
  let aggregator: SignalAggregator;

  beforeEach(() => {
    db = new DatabaseClient(':memory:');
    aggregator = new SignalAggregator(BASE_CONFIG, db);
    aggregator.start();
  });

  afterEach(() => {
    aggregator.stop();
    db.close();
  });

  // ---- single source / threshold -------------------------------------------

  it('emits a qualified signal when confidence meets the minimum', () => {
    const emitted: Signal[] = [];
    aggregator.on('signal', (s) => emitted.push(s));

    const monitor = new EventEmitter();
    aggregator.register(monitor);
    monitor.emit('signal', makeSignal({ confidence: 0.8 }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.tokenAddress).toBe(makeSignal().tokenAddress);
    expect(emitted[0]!.confidence).toBe(0.8);
  });

  it('does not emit when confidence is below the minimum', () => {
    const emitted: Signal[] = [];
    aggregator.on('signal', (s) => emitted.push(s));

    const monitor = new EventEmitter();
    aggregator.register(monitor);
    monitor.emit('signal', makeSignal({ confidence: 0.4 }));

    expect(emitted).toHaveLength(0);
  });

  it('emits exactly once per dedup window even with multiple signals for the same token', () => {
    const emitted: Signal[] = [];
    aggregator.on('signal', (s) => emitted.push(s));

    const monitor = new EventEmitter();
    aggregator.register(monitor);

    monitor.emit('signal', makeSignal({ confidence: 0.7 }));
    monitor.emit('signal', makeSignal({ confidence: 0.9 }));
    monitor.emit('signal', makeSignal({ confidence: 0.8 }));

    expect(emitted).toHaveLength(1);
  });

  it('emits again for the same token after the dedup window expires', () => {
    const emitted: Signal[] = [];
    aggregator.on('signal', (s) => emitted.push(s));

    // Use a very short window (1 ms) so the second signal starts a new window.
    const shortAggregator = new SignalAggregator({ ...BASE_CONFIG, dedupWindowMs: 1 }, db);
    shortAggregator.start();
    shortAggregator.on('signal', (s) => emitted.push(s));

    const monitor = new EventEmitter();
    shortAggregator.register(monitor);

    monitor.emit('signal', makeSignal({ confidence: 0.8 }));

    // Simulate passage of time: override firstTimestamp to force expiry.
    // (We access the private map via a cast for testing purposes only.)
    const windows = (shortAggregator as unknown as { windows: Map<string, { firstTimestamp: number }> }).windows;
    for (const win of windows.values()) {
      win.firstTimestamp = 0; // epoch — guaranteed expired
    }

    monitor.emit('signal', makeSignal({ confidence: 0.75 }));

    expect(emitted).toHaveLength(2);
    shortAggregator.stop();
  });

  // ---- multi-source boost --------------------------------------------------

  it('boosts confidence when the same token arrives from a second source', () => {
    const emitted: Signal[] = [];
    aggregator.on('signal', (s) => emitted.push(s));

    const monitor = new EventEmitter();
    aggregator.register(monitor);

    // First signal just below threshold.
    monitor.emit('signal', makeSignal({ source: 'telegram', confidence: 0.5 }));
    expect(emitted).toHaveLength(0); // 0.5 < 0.6

    // Second signal from Discord → boost = 0.2, total = 0.5 + 0.2 = 0.7 ≥ 0.6
    monitor.emit('signal', makeSignal({ source: 'discord', confidence: 0.5 }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.confidence).toBeCloseTo(0.7);
  });

  it('uses the highest individual confidence as the base when boosting', () => {
    const emitted: Signal[] = [];
    aggregator.on('signal', (s) => emitted.push(s));

    const monitor = new EventEmitter();
    aggregator.register(monitor);

    monitor.emit('signal', makeSignal({ source: 'telegram', confidence: 0.5 }));
    // Second from Discord with higher base confidence (0.65 > threshold after boost).
    monitor.emit('signal', makeSignal({ source: 'discord', confidence: 0.65 }));

    // maxConfidence = 0.65, +0.2 boost = 0.85
    expect(emitted[0]!.confidence).toBeCloseTo(0.85);
  });

  it('does not boost beyond 1.0', () => {
    const emitted: Signal[] = [];
    aggregator.on('signal', (s) => emitted.push(s));

    const monitor = new EventEmitter();
    aggregator.register(monitor);

    // First signal is below threshold so it does NOT emit on its own.
    // Second signal from a different source triggers boost: max(0.5, 0.95)+0.2 = 1.15 → clamped to 1.0.
    monitor.emit('signal', makeSignal({ source: 'telegram', confidence: 0.5 }));
    monitor.emit('signal', makeSignal({ source: 'discord',  confidence: 0.95 }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.confidence).toBe(1.0); // clamped from 1.15
  });

  it('does not re-boost for repeated signals from the same source', () => {
    const emitted: Signal[] = [];
    aggregator.on('signal', (s) => emitted.push(s));

    const monitor = new EventEmitter();
    aggregator.register(monitor);

    // Two Telegram signals → only one unique source → no boost.
    monitor.emit('signal', makeSignal({ source: 'telegram', confidence: 0.75 }));
    monitor.emit('signal', makeSignal({ source: 'telegram', confidence: 0.75 }));

    expect(emitted).toHaveLength(1);
    // Confidence should be the raw 0.75 (no boost — only one source).
    expect(emitted[0]!.confidence).toBeCloseTo(0.75);
  });

  // ---- different tokens ----------------------------------------------------

  it('maintains separate windows for different token addresses', () => {
    const emitted: Signal[] = [];
    aggregator.on('signal', (s) => emitted.push(s));

    const tokenA = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
    const tokenB = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB1';

    const monitor = new EventEmitter();
    aggregator.register(monitor);

    monitor.emit('signal', makeSignal({ tokenAddress: tokenA, confidence: 0.8 }));
    monitor.emit('signal', makeSignal({ tokenAddress: tokenB, confidence: 0.9 }));

    expect(emitted).toHaveLength(2);
    expect(aggregator.activeWindowCount).toBe(2);
  });

  // ---- DB persistence ------------------------------------------------------

  it('persists each raw signal to the database regardless of threshold', () => {
    const monitor = new EventEmitter();
    aggregator.register(monitor);

    monitor.emit('signal', makeSignal({ confidence: 0.3 })); // below threshold
    monitor.emit('signal', makeSignal({ confidence: 0.9 })); // above threshold

    const rows = db.getRecentSignals(makeSignal().tokenAddress, 10_000);
    expect(rows).toHaveLength(2);
  });

  // ---- register multiple monitors ------------------------------------------

  it('accepts signals from multiple registered monitors', () => {
    const emitted: Signal[] = [];
    aggregator.on('signal', (s) => emitted.push(s));

    const tgMonitor = new EventEmitter();
    const dcMonitor = new EventEmitter();
    aggregator.register(tgMonitor);
    aggregator.register(dcMonitor);

    const tokenA = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
    const tokenB = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB1';

    tgMonitor.emit('signal', makeSignal({ tokenAddress: tokenA, source: 'telegram', confidence: 0.8 }));
    dcMonitor.emit('signal', makeSignal({ tokenAddress: tokenB, source: 'discord', confidence: 0.7 }));

    expect(emitted).toHaveLength(2);
  });

  // ---- active window count -------------------------------------------------

  it('tracks active window count correctly', () => {
    const monitor = new EventEmitter();
    aggregator.register(monitor);

    expect(aggregator.activeWindowCount).toBe(0);

    monitor.emit('signal', makeSignal({ tokenAddress: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1' }));
    monitor.emit('signal', makeSignal({ tokenAddress: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB1' }));

    expect(aggregator.activeWindowCount).toBe(2);
  });
});
