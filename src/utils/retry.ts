import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Total number of attempts (including the first). */
  attempts: number;
  /** Delay before the second attempt, in ms. Doubles on each subsequent retry. */
  initialDelayMs?: number;
  /** Backoff multiplier (default 2 = exponential doubling). */
  factor?: number;
  /** Called on every failed attempt before the next delay. */
  onError?: (err: unknown, attempt: number, delayMs: number) => void;
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

/**
 * Calls `fn` up to `opts.attempts` times with exponential backoff between
 * failures.  Throws the last error if all attempts are exhausted.
 *
 * @example
 * const result = await withRetry(() => rpcCall(), { attempts: 3 });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { attempts, initialDelayMs = 200, factor = 2 } = opts;
  let delayMs = initialDelayMs;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = i === attempts;

      if (opts.onError) {
        opts.onError(err, i, isLast ? 0 : delayMs);
      } else {
        logger.warn({ attempt: i, totalAttempts: attempts, delayMs: isLast ? 0 : delayMs, err }, 'Retryable error');
      }

      if (isLast) throw err;

      await sleep(delayMs);
      delayMs = Math.round(delayMs * factor);
    }
  }

  // Unreachable — TypeScript needs this.
  throw new Error('withRetry: unreachable');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
