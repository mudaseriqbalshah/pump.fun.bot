import { Connection, type Commitment } from '@solana/web3.js';
import { logger } from '../utils/logger.js';

export type RpcStrategy = 'round-robin' | 'fastest' | 'failover';

export interface EndpointStats {
  url: string;
  healthy: boolean;
  /** Exponential moving average of successful call latencies. */
  avgLatencyMs: number;
  requests: number;
  errors: number;
  lastChecked: number;
}

interface EndpointState extends EndpointStats {
  connection: Connection;
}

const COMMITMENT: Commitment = 'confirmed';
const EMA_ALPHA = 0.2; // weight for new latency samples

export class RpcManager {
  private readonly endpoints: EndpointState[];
  private readonly strategy: RpcStrategy;
  private rrIndex = 0;

  constructor(urls: string[], strategy: RpcStrategy = 'round-robin') {
    if (urls.length === 0) throw new Error('At least one RPC URL is required');

    this.strategy = strategy;
    this.endpoints = urls.map((url) => ({
      url,
      connection: new Connection(url, COMMITMENT),
      healthy: true,
      avgLatencyMs: 0,
      requests: 0,
      errors: 0,
      lastChecked: 0,
    }));

    logger.info({ count: urls.length, strategy }, 'RPC manager initialised');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Returns the next Connection according to the configured strategy. */
  getConnection(): Connection {
    const endpoint = this.pickEndpoint();
    return endpoint.connection;
  }

  /**
   * Returns the next Connection AND its URL — useful for retry logic so the
   * caller can pin retries to a *different* endpoint.
   */
  getConnectionWithUrl(): { connection: Connection; url: string } {
    const endpoint = this.pickEndpoint();
    return { connection: endpoint.connection, url: endpoint.url };
  }

  /** Call this after a successful RPC call to update latency stats. */
  recordSuccess(url: string, latencyMs: number): void {
    const ep = this.find(url);
    if (!ep) return;
    ep.requests++;
    ep.avgLatencyMs =
      ep.avgLatencyMs === 0
        ? latencyMs
        : ep.avgLatencyMs * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA;
  }

  /** Call this after a failed RPC call to increment the error counter. */
  recordError(url: string): void {
    const ep = this.find(url);
    if (!ep) return;
    ep.errors++;
    ep.requests++;
  }

  /** Mark an endpoint healthy or unhealthy (called by the health monitor). */
  setHealthy(url: string, healthy: boolean, latencyMs?: number): void {
    const ep = this.find(url);
    if (!ep) return;
    const changed = ep.healthy !== healthy;
    ep.healthy = healthy;
    ep.lastChecked = Date.now();
    if (healthy && latencyMs !== undefined) {
      ep.avgLatencyMs =
        ep.avgLatencyMs === 0
          ? latencyMs
          : ep.avgLatencyMs * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA;
    }
    if (changed) {
      logger.info({ url, healthy }, healthy ? 'RPC endpoint recovered' : 'RPC endpoint marked unhealthy');
    }
  }

  /** Snapshot of all endpoint stats (for the health monitor & CLI tool). */
  getStats(): EndpointStats[] {
    return this.endpoints.map(({ connection: _c, ...stats }) => ({ ...stats }));
  }

  /** All configured endpoint URLs. */
  get urls(): string[] {
    return this.endpoints.map((e) => e.url);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private pickEndpoint(): EndpointState {
    const healthy = this.endpoints.filter((e) => e.healthy);
    const pool = healthy.length > 0 ? healthy : this.endpoints; // fallback: use all

    if (pool.length === 0) throw new Error('No RPC endpoints available');

    switch (this.strategy) {
      case 'fastest':
        return this.pickFastest(pool);
      case 'failover':
        return pool[0]!;
      case 'round-robin':
      default:
        return this.pickRoundRobin(pool);
    }
  }

  private pickRoundRobin(pool: EndpointState[]): EndpointState {
    // Map the global rrIndex into the pool's index space.
    const idx = this.rrIndex % pool.length;
    this.rrIndex = (this.rrIndex + 1) % pool.length;
    return pool[idx]!;
  }

  private pickFastest(pool: EndpointState[]): EndpointState {
    // Prefer endpoints with measured latency; fall back to the first one.
    const withLatency = pool.filter((e) => e.avgLatencyMs > 0);
    const candidates = withLatency.length > 0 ? withLatency : pool;
    return candidates.reduce((best, ep) =>
      ep.avgLatencyMs < best.avgLatencyMs ? ep : best,
    );
  }

  private find(url: string): EndpointState | undefined {
    return this.endpoints.find((e) => e.url === url);
  }
}
