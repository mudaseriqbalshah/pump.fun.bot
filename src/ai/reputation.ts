/**
 * Token Reputation Fetcher
 *
 * Fetches on-chain and market data for a token BEFORE making a buy decision:
 *   1. pump.fun coin info  — age, creator, market cap, community replies
 *   2. Dexscreener         — DEX trading data (volume, price change, buys/sells)
 *
 * Both calls run in parallel and fail silently — any missing data is reported
 * as `null` so the AI advisor can note the uncertainty rather than crashing.
 */

import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TokenReputation {
  /** Token name as registered on pump.fun. */
  name: string | null;
  /** Token ticker symbol. */
  symbol: string | null;
  /** Creator wallet address (base58). */
  creator: string | null;
  /** How many minutes ago the token was created on pump.fun. */
  ageMinutes: number | null;
  /** pump.fun market cap in SOL (approximated from USD price). */
  pumpFunMarketCapSol: number | null;
  /** Community reply count on the pump.fun page. */
  pumpFunReplies: number | null;
  /** Whether the token already has a DEX pair (i.e., it has graduated). */
  dexListed: boolean;
  /** 24-hour DEX volume in USD (null if not listed). */
  dex24hVolumeUsd: number | null;
  /** 24-hour price change on DEX in percent (null if not listed). */
  dex24hPriceChangePct: number | null;
  /** 24-hour buy transaction count (null if not listed). */
  dexBuys24h: number | null;
  /** 24-hour sell transaction count (null if not listed). */
  dexSells24h: number | null;
  /** DEX liquidity in USD (null if not listed). */
  dexLiquidityUsd: number | null;
  /** Automatically detected risk signals. */
  redFlags: string[];
}

// ---------------------------------------------------------------------------
// Internal API response shapes
// ---------------------------------------------------------------------------

interface PumpFunCoin {
  name?: string;
  symbol?: string;
  creator?: string;
  /** Unix milliseconds. */
  created_timestamp?: number;
  /** USD market cap. */
  market_cap?: number;
  reply_count?: number;
  complete?: boolean;
}

interface DexPair {
  priceUsd?: string;
  txns?: { h24?: { buys?: number; sells?: number } };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
}

interface DexScreenerResponse {
  pairs?: DexPair[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PUMP_FUN_API = 'https://frontend-api.pump.fun/coins';
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';

/** Rough SOL/USD rate used only for pump.fun market-cap conversion. */
const APPROX_SOL_USD = 150;

const FETCH_TIMEOUT_MS = 6_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch reputation data for `tokenAddress`.
 * Never throws — always returns a (possibly sparse) `TokenReputation` object.
 */
export async function fetchTokenReputation(tokenAddress: string): Promise<TokenReputation> {
  const [pumpResult, dexResult] = await Promise.allSettled([
    fetchPumpFun(tokenAddress),
    fetchDexScreener(tokenAddress),
  ]);

  const pump = pumpResult.status === 'fulfilled' ? pumpResult.value : null;
  const dex = dexResult.status === 'fulfilled' ? dexResult.value : null;

  const redFlags: string[] = [];

  // --- pump.fun data ---
  let ageMinutes: number | null = null;
  if (pump?.created_timestamp) {
    ageMinutes = (Date.now() - pump.created_timestamp) / 60_000;
    if (ageMinutes < 1) {
      redFlags.push(`Token only ${(ageMinutes * 60).toFixed(0)}s old — possible front-run`);
    }
  }

  let pumpFunMarketCapSol: number | null = null;
  if (pump?.market_cap != null) {
    pumpFunMarketCapSol = pump.market_cap / APPROX_SOL_USD;
    if (pumpFunMarketCapSol > 70) {
      redFlags.push(`Already ${pumpFunMarketCapSol.toFixed(0)} SOL market cap — very late entry`);
    }
  }

  const replies = pump?.reply_count ?? null;
  if (replies === 0) {
    redFlags.push('Zero community replies on pump.fun — no social traction');
  }

  // --- Dexscreener data ---
  let dexListed = false;
  let dex24hVolumeUsd: number | null = null;
  let dex24hPriceChangePct: number | null = null;
  let dexBuys24h: number | null = null;
  let dexSells24h: number | null = null;
  let dexLiquidityUsd: number | null = null;

  const pair = dex?.pairs?.[0] ?? null;
  if (pair) {
    dexListed = true;
    dex24hVolumeUsd = pair.volume?.h24 ?? null;
    dex24hPriceChangePct = pair.priceChange?.h24 ?? null;
    dexBuys24h = pair.txns?.h24?.buys ?? null;
    dexSells24h = pair.txns?.h24?.sells ?? null;
    dexLiquidityUsd = pair.liquidity?.usd ?? null;

    if (dex24hPriceChangePct !== null && dex24hPriceChangePct < -60) {
      redFlags.push(`DEX price already down ${Math.abs(dex24hPriceChangePct).toFixed(0)}% — likely dumped`);
    }
    if (dexLiquidityUsd !== null && dexLiquidityUsd < 500) {
      redFlags.push(`Extremely low DEX liquidity ($${dexLiquidityUsd.toFixed(0)}) — slippage will be huge`);
    }
    if (dexBuys24h !== null && dexSells24h !== null && dexSells24h > dexBuys24h * 3) {
      redFlags.push(`Sell pressure: ${dexSells24h} sells vs ${dexBuys24h} buys in 24h`);
    }
  }

  const rep: TokenReputation = {
    name: pump?.name ?? null,
    symbol: pump?.symbol ?? null,
    creator: pump?.creator ?? null,
    ageMinutes,
    pumpFunMarketCapSol,
    pumpFunReplies: replies,
    dexListed,
    dex24hVolumeUsd,
    dex24hPriceChangePct,
    dexBuys24h,
    dexSells24h,
    dexLiquidityUsd,
    redFlags,
  };

  logger.debug(
    { tokenAddress, ageMinutes: ageMinutes?.toFixed(1), pumpFunMarketCapSol, dexListed, redFlags },
    'TokenReputation fetched',
  );

  return rep;
}

// ---------------------------------------------------------------------------
// Internal fetch helpers
// ---------------------------------------------------------------------------

async function fetchPumpFun(tokenAddress: string): Promise<PumpFunCoin | null> {
  try {
    const res = await fetch(`${PUMP_FUN_API}/${tokenAddress}`, {
      headers: { 'User-Agent': 'pump-fun-bot/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as PumpFunCoin;
  } catch (err) {
    logger.debug({ tokenAddress, err }, 'TokenReputation: pump.fun fetch failed (non-fatal)');
    return null;
  }
}

async function fetchDexScreener(tokenAddress: string): Promise<DexScreenerResponse | null> {
  try {
    const res = await fetch(`${DEXSCREENER_API}/${tokenAddress}`, {
      headers: { 'User-Agent': 'pump-fun-bot/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as DexScreenerResponse;
  } catch (err) {
    logger.debug({ tokenAddress, err }, 'TokenReputation: dexscreener fetch failed (non-fatal)');
    return null;
  }
}
