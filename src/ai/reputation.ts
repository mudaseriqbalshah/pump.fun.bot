/**
 * Token Reputation Fetcher
 *
 * Fetches on-chain and market data for a token BEFORE making a buy decision:
 *   1. pump.fun coin info  — age, creator, market cap, community replies
 *   2. Dexscreener         — DEX trading data (volume, price change, buys/sells)
 *   3. Twitter / X API v2  — recent mentions, scam/rug keyword detection
 *
 * All three calls run in parallel and fail silently — any missing data is
 * reported as `null` so the AI advisor can note the uncertainty rather than
 * crashing. Twitter requires `TWITTER_BEARER_TOKEN`; omit it to disable.
 */

import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TwitterData {
  /** Total tweet count returned by the search (up to 100). */
  mentionCount: number;
  /** Tweets containing scam/rug/dump keywords. */
  scamMentions: number;
  /** Tweets containing bullish/hype keywords. */
  hypeMentions: number;
  /** Sample tweet texts (up to 5, truncated to 120 chars each). */
  sampleTweets: string[];
}

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
  /** Twitter/X mention data (null if bearer token not configured). */
  twitter: TwitterData | null;
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

interface TwitterSearchResponse {
  data?: Array<{ id: string; text: string }>;
  meta?: { result_count?: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PUMP_FUN_API = 'https://frontend-api.pump.fun/coins';
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';
const TWITTER_SEARCH_API = 'https://api.twitter.com/2/tweets/search/recent';

/** Rough SOL/USD rate used only for pump.fun market-cap conversion. */
const APPROX_SOL_USD = 150;

const FETCH_TIMEOUT_MS = 6_000;

/** Words in tweet text that suggest a rug/scam. */
const SCAM_KEYWORDS = ['rug', 'scam', 'honeypot', 'dump', 'fraud', 'avoid', 'fake', 'ponzi'];
/** Words in tweet text that suggest positive hype. */
const HYPE_KEYWORDS = ['moon', 'gem', 'alpha', 'buy', 'launch', '100x', '1000x', 'bullish'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch reputation data for `tokenAddress`.
 * Pass `twitterBearerToken` to enable Twitter search (leave empty/null to skip).
 * Never throws — always returns a (possibly sparse) `TokenReputation` object.
 */
export async function fetchTokenReputation(
  tokenAddress: string,
  ticker: string | null = null,
  twitterBearerToken: string | null = null,
): Promise<TokenReputation> {
  const [pumpResult, dexResult, twitterResult] = await Promise.allSettled([
    fetchPumpFun(tokenAddress),
    fetchDexScreener(tokenAddress),
    twitterBearerToken
      ? fetchTwitter(tokenAddress, ticker, twitterBearerToken)
      : Promise.resolve(null),
  ]);

  const pump = pumpResult.status === 'fulfilled' ? pumpResult.value : null;
  const dex = dexResult.status === 'fulfilled' ? dexResult.value : null;
  const twitter = twitterResult.status === 'fulfilled' ? twitterResult.value : null;

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

  // --- Twitter data ---
  if (twitter) {
    if (twitter.scamMentions > 0) {
      redFlags.push(
        `${twitter.scamMentions}/${twitter.mentionCount} tweets contain scam/rug keywords`,
      );
    }
    if (twitter.mentionCount === 0) {
      redFlags.push('No Twitter mentions found — zero social awareness');
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
    twitter,
    redFlags,
  };

  logger.debug(
    {
      tokenAddress,
      ageMinutes: ageMinutes?.toFixed(1),
      pumpFunMarketCapSol,
      dexListed,
      twitterMentions: twitter?.mentionCount ?? 'disabled',
      redFlags,
    },
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

async function fetchTwitter(
  tokenAddress: string,
  ticker: string | null,
  bearerToken: string,
): Promise<TwitterData | null> {
  try {
    // Build query: always search contract address; optionally add $TICKER
    let query = `"${tokenAddress}" -is:retweet lang:en`;
    if (ticker && ticker.length <= 10) {
      query += ` OR $${ticker} -is:retweet lang:en`;
    }

    const url = new URL(TWITTER_SEARCH_API);
    url.searchParams.set('query', query);
    url.searchParams.set('max_results', '100');
    url.searchParams.set('tweet.fields', 'created_at');

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'User-Agent': 'pump-fun-bot/1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.debug(
        { tokenAddress, status: res.status },
        'TokenReputation: Twitter API error (non-fatal)',
      );
      return null;
    }

    const body = (await res.json()) as TwitterSearchResponse;
    const tweets = body.data ?? [];
    const count = body.meta?.result_count ?? tweets.length;

    let scamMentions = 0;
    let hypeMentions = 0;
    const sampleTweets: string[] = [];

    for (const tweet of tweets) {
      const lower = tweet.text.toLowerCase();
      if (SCAM_KEYWORDS.some((kw) => lower.includes(kw))) scamMentions++;
      if (HYPE_KEYWORDS.some((kw) => lower.includes(kw))) hypeMentions++;
      if (sampleTweets.length < 5) {
        sampleTweets.push(tweet.text.slice(0, 120).replace(/\n/g, ' '));
      }
    }

    logger.debug(
      { tokenAddress, count, scamMentions, hypeMentions },
      'TokenReputation: Twitter data fetched',
    );

    return { mentionCount: count, scamMentions, hypeMentions, sampleTweets };
  } catch (err) {
    logger.debug({ tokenAddress, err }, 'TokenReputation: Twitter fetch failed (non-fatal)');
    return null;
  }
}
