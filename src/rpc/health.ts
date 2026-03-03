import { Connection } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import type { RpcManager } from './manager.js';

const PING_TIMEOUT_MS = 5_000;

export class RpcHealthMonitor {
  private readonly manager: RpcManager;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(manager: RpcManager, intervalSeconds: number = 30) {
    this.manager = manager;
    this.intervalMs = intervalSeconds * 1000;
  }

  /** Start the periodic health-check loop. */
  start(): void {
    if (this.timer) return;
    logger.info({ intervalMs: this.intervalMs }, 'RPC health monitor started');
    // Run immediately, then on the interval.
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
    // Don't block Node from exiting.
    this.timer.unref();
  }

  /** Stop the health-check loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('RPC health monitor stopped');
    }
  }

  /**
   * Probe all endpoints once and update the manager.
   * Returns the result array — useful for the CLI check-rpc script.
   */
  async checkAll(): Promise<CheckResult[]> {
    const results = await Promise.all(this.manager.urls.map((url) => this.probe(url)));
    return results;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async probe(url: string): Promise<CheckResult> {
    const connection = new Connection(url, 'confirmed');
    const start = Date.now();
    try {
      const slotPromise = connection.getSlot('confirmed');
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), PING_TIMEOUT_MS),
      );
      const slot = await Promise.race([slotPromise, timeoutPromise]);
      const latencyMs = Date.now() - start;
      this.manager.setHealthy(url, true, latencyMs);
      logger.debug({ url, latencyMs, slot }, 'RPC ping ok');
      return { url, healthy: true, latencyMs, slot };
    } catch (err) {
      const latencyMs = Date.now() - start;
      this.manager.setHealthy(url, false);
      logger.warn({ url, latencyMs, err }, 'RPC ping failed');
      return { url, healthy: false, latencyMs, slot: null };
    }
  }
}

export interface CheckResult {
  url: string;
  healthy: boolean;
  latencyMs: number;
  slot: number | null;
}
