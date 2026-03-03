import { createJupiterApiClient } from '@jup-ag/api';
import type { QuoteResponse, RoutePlanStep, SwapApi } from '@jup-ag/api';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wrapped SOL mint — used as the quote currency when pricing a token. */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Tiny probe amount: 1,000 token base units (6-decimal token → 0.001 full tokens).
 * Small enough to avoid meaningful price impact, large enough for Jupiter to route.
 */
const PROBE_AMOUNT = 1_000;

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface JupiterQuote {
  /** Token mint that was queried (base58). */
  mintAddress: string;
  /**
   * Quoted WSOL lamports out for `PROBE_AMOUNT` base units of the token in.
   * Divide by PROBE_AMOUNT to get lamports-per-base-unit price.
   */
  outAmountLamports: number;
  /** Price impact as a percentage string (e.g. "0.01"). */
  priceImpactPct: string;
  /** Route steps Jupiter will use for the swap. */
  routePlan: RoutePlanStep[];
  /** Full raw Jupiter response for callers that need more detail. */
  raw: QuoteResponse;
}

// ---------------------------------------------------------------------------
// JupiterDetector
// ---------------------------------------------------------------------------

/**
 * Queries the Jupiter v6 Quote API to determine whether a given pump.fun
 * token is available on any DEX.  A successful quote means liquidity exists.
 *
 * Used as the fallback (and sometimes primary) DEX detection mechanism
 * alongside `RaydiumDetector`.
 */
export class JupiterDetector {
  private readonly api: SwapApi;

  /**
   * @param basePath Override the Jupiter API base URL. Defaults to the public
   *   Jupiter v6 API (`https://quote-api.jup.ag/v6`). Useful for staging or
   *   self-hosted instances.
   */
  constructor(basePath?: string) {
    this.api = createJupiterApiClient(basePath ? { basePath } : undefined);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Attempt to get a Jupiter quote selling `mintAddress` for WSOL.
   *
   * Returns `null` when:
   *   - No route exists (token not yet listed on any DEX).
   *   - The Jupiter API returns an error (network issue, rate-limit, etc.).
   *
   * A non-null result is your signal that the DEX is live.
   */
  async check(mintAddress: string): Promise<JupiterQuote | null> {
    try {
      const quote = await this.api.quoteGet({
        inputMint: mintAddress,
        outputMint: WSOL_MINT,
        amount: PROBE_AMOUNT,
        slippageBps: 500,
        onlyDirectRoutes: false,
        restrictIntermediateTokens: true,
      });

      if (!quote?.routePlan?.length) return null;

      logger.debug(
        {
          mintAddress,
          outAmount: quote.outAmount,
          priceImpactPct: quote.priceImpactPct,
          routes: quote.routePlan.length,
        },
        'Jupiter quote received — DEX is live',
      );

      return {
        mintAddress,
        outAmountLamports: Number(quote.outAmount),
        priceImpactPct: quote.priceImpactPct,
        routePlan: quote.routePlan,
        raw: quote,
      };
    } catch (err) {
      // 404 / "no routes found" — entirely expected while the pool is warming up.
      logger.debug({ mintAddress, err }, 'Jupiter: no route (DEX not yet live)');
      return null;
    }
  }

  /**
   * Returns `true` if Jupiter has at least one route for the token.
   * Convenience wrapper for polling loops in the position tracker.
   */
  async isLive(mintAddress: string): Promise<boolean> {
    return (await this.check(mintAddress)) !== null;
  }

  /**
   * Convert a `JupiterQuote` (for `PROBE_AMOUNT` base units in) to an
   * approximate SOL price per *full* token (1 token = 1_000_000 base units).
   *
   * `pricePerTokenSol = outAmountLamports / PROBE_AMOUNT * 1_000_000 / 1e9`
   */
  static pricePerTokenSol(quote: JupiterQuote): number {
    return (quote.outAmountLamports / PROBE_AMOUNT) * 1_000_000 / 1e9;
  }
}
