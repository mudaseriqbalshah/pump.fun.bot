import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import type { RpcManager } from '../rpc/manager.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Raydium CPMM program — the variant used when pump.fun tokens graduate.
 * https://solscan.io/account/CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 */
const RAYDIUM_CPMM_PROGRAM = new PublicKey(
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
);

/**
 * Byte offsets of `token_0_mint` and `token_1_mint` inside a Raydium CPMM
 * PoolState account:
 *   8  bytes  — Anchor discriminator
 *   32 bytes  — amm_config        (offset  8)
 *   32 bytes  — pool_creator      (offset 40)
 *   32 bytes  — token_0_vault     (offset 72)
 *   32 bytes  — token_1_vault     (offset 104)
 *   32 bytes  — lp_mint           (offset 136)
 *   32 bytes  — token_0_mint      (offset 168)  ← TOKEN_0_OFFSET
 *   32 bytes  — token_1_mint      (offset 200)  ← TOKEN_1_OFFSET
 */
const TOKEN_0_OFFSET = 168;
const TOKEN_1_OFFSET = 200;

const DEFAULT_POLL_MS = 5_000;

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface PoolFoundPayload {
  /** Token mint (base58). */
  mintAddress: string;
  /** Raydium CPMM pool account (base58). */
  poolAddress: string;
  /** Unix ms when the pool was first detected. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// RaydiumDetector
// ---------------------------------------------------------------------------

/**
 * Watches a set of token mints and polls the Raydium CPMM program every
 * `intervalMs` milliseconds for a matching liquidity pool.
 *
 * Emits `'pool_found'` → PoolFoundPayload when a pool is detected, then
 * automatically stops watching that mint.
 *
 * Usage in the position tracker:
 *   detector.watch(mintAddress);
 *   detector.on('pool_found', ({ mintAddress, poolAddress }) => { ... });
 */
export class RaydiumDetector extends EventEmitter {
  private readonly rpcManager: RpcManager;
  /** Mints we're actively polling for. */
  private readonly watching = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(rpcManager: RpcManager) {
    super();
    this.rpcManager = rpcManager;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(intervalMs: number = DEFAULT_POLL_MS): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);
    this.pollTimer.unref();
    logger.info({ intervalMs }, 'RaydiumDetector started');
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('RaydiumDetector stopped');
  }

  // ---------------------------------------------------------------------------
  // Watch management
  // ---------------------------------------------------------------------------

  /** Begin polling for a Raydium pool containing `mintAddress`. */
  watch(mintAddress: string): void {
    if (this.watching.has(mintAddress)) return;
    this.watching.add(mintAddress);
    logger.debug({ mintAddress }, 'RaydiumDetector: watching mint');
  }

  /** Remove a mint from the watch set (called automatically on detection). */
  unwatch(mintAddress: string): void {
    this.watching.delete(mintAddress);
  }

  get watchCount(): number {
    return this.watching.size;
  }

  // ---------------------------------------------------------------------------
  // Private — polling
  // ---------------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (this.watching.size === 0) return;

    for (const mintAddress of [...this.watching]) {
      try {
        const payload = await this.findPool(mintAddress);
        if (payload) {
          this.watching.delete(mintAddress);
          this.emit('pool_found', payload);
        }
      } catch (err) {
        // Expected: RPC errors, account-not-found, timeouts — just retry next tick.
        logger.debug({ mintAddress, err }, 'RaydiumDetector: poll tick error');
      }
    }
  }

  /**
   * Query the Raydium CPMM program for a pool whose `token_0_mint` or
   * `token_1_mint` matches `mintAddress`.
   *
   * We request only account keys (dataSlice length = 0) to minimise bandwidth.
   */
  private async findPool(mintAddress: string): Promise<PoolFoundPayload | null> {
    const connection = this.rpcManager.getConnection();

    for (const offset of [TOKEN_0_OFFSET, TOKEN_1_OFFSET]) {
      const accounts = await connection.getProgramAccounts(RAYDIUM_CPMM_PROGRAM, {
        filters: [{ memcmp: { offset, bytes: mintAddress } }],
        commitment: 'confirmed',
        // Fetch zero bytes of account data — we only need the public key.
        dataSlice: { offset: 0, length: 0 },
      });

      if (accounts.length > 0) {
        const poolAddress = accounts[0]!.pubkey.toBase58();
        logger.info(
          { mintAddress, poolAddress, mintSlot: offset === TOKEN_0_OFFSET ? 'token_0' : 'token_1' },
          'Raydium CPMM pool detected',
        );
        return { mintAddress, poolAddress, timestamp: Date.now() };
      }
    }

    return null;
  }
}
