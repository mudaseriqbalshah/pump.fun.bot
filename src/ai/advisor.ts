import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { TradingConfig } from '../config/schema.js';
import type { Signal } from '../signals/types.js';
import type { BondingCurveInfo } from '../scanner/bonding.js';
import type { TokenReputation } from './reputation.js';
import type { TradeStats } from '../db/client.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Decision schemas (structured output contracts)
// ---------------------------------------------------------------------------

const BuyDecisionSchema = z.object({
  buy: z.boolean().describe('Whether to buy this token'),
  confidence: z
    .number()
    .describe('Revised confidence score 0–1 for this trade (used to scale position size)'),
  positionSizeMult: z
    .number()
    .describe('Position size multiplier 0.1–1.0 applied to max_position_sol; use 1.0 for full size'),
  reasoning: z.string().describe('Brief one-sentence reasoning for the decision'),
  redFlags: z.array(z.string()).describe('Risk factors detected; empty array if none'),
});

const SellDecisionSchema = z.object({
  sell: z.boolean().describe('Whether to sell the position early (before thresholds are hit)'),
  urgency: z
    .enum(['normal', 'immediate'])
    .describe(
      '"immediate" bypasses profit/stop thresholds — sell right now. "normal" is advisory only.',
    ),
  reasoning: z.string().describe('Brief one-sentence reasoning for the decision'),
});

export type BuyDecision = z.infer<typeof BuyDecisionSchema>;
export type SellDecision = z.infer<typeof SellDecisionSchema>;

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

export interface BuyContext {
  openPositions: number;
  dailyPnlSol: number;
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const BUY_SYSTEM_PROMPT = `You are a risk-aware trading advisor for an automated pump.fun Solana memecoin bot.
Your role is to evaluate whether to buy a newly signalled token based on the available data.

Guidelines:
- Be CONSERVATIVE. A missed opportunity is better than a loss.
- Weigh reputation data heavily: red flags from pump.fun / Dexscreener are strong negative signals.
- Prefer tokens that are very new (<5 min), have low market cap, and some community activity.
- Tokens already listed on DEX (graduated) at a low price change can be good; those already dumped are not.
- Account for the bot's historical channel performance — avoid channels with poor track records.
- If the bot is on a losing streak, recommend smaller position sizes (positionSizeMult 0.3–0.5).
- If open positions are near the max, recommend skipping unless confidence is very high.`;

const SELL_SYSTEM_PROMPT = `You are a risk-aware trading advisor for an automated pump.fun Solana memecoin bot.
Your role is to decide whether to sell a position EARLY — before the configured profit/stop-loss thresholds.

Guidelines:
- The bot sells automatically at the profit target or stop-loss — you only add early exits.
- "immediate" urgency: sell right now, even if thresholds are not met. Use sparingly.
- "normal" urgency: advisory only; only acts if thresholds are also met.
- Recommend immediate sell if: price velocity is falling fast (< -5% per minute), or
  the position has been held >30 min with no progress, or PnL is trending strongly negative.
- Recommend normal sell if: PnL has been positive and is now fading toward zero.`;

// ---------------------------------------------------------------------------
// TradeAdvisor
// ---------------------------------------------------------------------------

/**
 * AI-powered trading advisor using the OpenAI API.
 *
 * Buy decisions  → gpt-4o with structured outputs.
 *   Receives: signal, bonding curve, token reputation (#1), trade stats (#3).
 * Sell decisions → gpt-4o-mini with structured outputs (throttled per token).
 *   Receives: PnL, hold time, price velocity (#2).
 *
 * When `OPENAI_API_KEY` is not set, both methods return permissive defaults so
 * the existing threshold-based logic remains the sole decision maker.
 */
export class TradeAdvisor {
  private readonly client: OpenAI;
  private readonly cfg: TradingConfig;
  private readonly enabled: boolean;

  /** Tracks last sell-check timestamp per token to avoid excessive API calls. */
  private readonly sellCheckAt = new Map<string, number>();
  private static readonly SELL_THROTTLE_MS = 5 * 60 * 1_000; // 5 minutes

  /**
   * Price history for velocity calculation (#2).
   * Stores (pnlPct, timestamp) pairs per token; older than 10 min are dropped.
   */
  private readonly priceHistory = new Map<string, Array<{ pnlPct: number; ts: number }>>();
  private static readonly PRICE_HISTORY_WINDOW_MS = 10 * 60 * 1_000;
  private static readonly VELOCITY_WINDOW_MS = 2 * 60 * 1_000;

  constructor(apiKey: string, cfg: TradingConfig) {
    this.cfg = cfg;
    this.enabled = apiKey.trim().length > 0;
    this.client = new OpenAI({ apiKey: this.enabled ? apiKey : 'disabled-placeholder' });

    if (this.enabled) {
      logger.info('TradeAdvisor: enabled — buy=gpt-4o, sell=gpt-4o-mini');
    } else {
      logger.info('TradeAdvisor: OPENAI_API_KEY not set — AI advisor disabled, thresholds only');
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  // ---------------------------------------------------------------------------
  // Price velocity tracking (#2)
  // ---------------------------------------------------------------------------

  /**
   * Record the current PnL% for a token at this point in time.
   * Called by Seller on every evaluation tick.
   */
  recordPrice(tokenAddress: string, pnlPct: number): void {
    const now = Date.now();
    const history = this.priceHistory.get(tokenAddress) ?? [];
    history.push({ pnlPct, ts: now });

    // Trim entries older than the window
    const cutoff = now - TradeAdvisor.PRICE_HISTORY_WINDOW_MS;
    this.priceHistory.set(
      tokenAddress,
      history.filter((p) => p.ts >= cutoff),
    );
  }

  /**
   * Returns the rate of PnL change over the last 2 minutes in units of
   * "%  per minute". Null if there's insufficient history.
   */
  private getPriceVelocity(tokenAddress: string): number | null {
    const history = this.priceHistory.get(tokenAddress);
    if (!history || history.length < 2) return null;

    const now = Date.now();
    const cutoff = now - TradeAdvisor.VELOCITY_WINDOW_MS;
    const baseline = history.find((p) => p.ts >= cutoff);
    const latest = history[history.length - 1];

    if (!baseline || baseline === latest) return null;

    const minutesDiff = (latest.ts - baseline.ts) / 60_000;
    if (minutesDiff < 0.1) return null;

    return (latest.pnlPct - baseline.pnlPct) / minutesDiff;
  }

  // ---------------------------------------------------------------------------
  // Buy decision — gpt-4o + structured output
  // ---------------------------------------------------------------------------

  /**
   * Ask the AI whether to buy a token.
   * Accepts token reputation (#1) and historical trade stats (#3).
   * Falls back to `{ buy: true, ... }` on any error.
   */
  async shouldBuy(
    signal: Signal,
    curve: BondingCurveInfo | null,
    ctx: BuyContext,
    reputation: TokenReputation | null,
    tradeStats: TradeStats | null,
  ): Promise<BuyDecision> {
    if (!this.enabled) return defaultBuy();

    try {
      const completion = await this.client.beta.chat.completions.parse({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: BUY_SYSTEM_PROMPT },
          { role: 'user', content: buildBuyPrompt(signal, curve, ctx, this.cfg, reputation, tradeStats) },
        ],
        response_format: zodResponseFormat(BuyDecisionSchema, 'buy_decision'),
        temperature: 0.2,
      });

      const decision = completion.choices[0].message.parsed;
      if (!decision) {
        logger.warn({ token: signal.tokenAddress }, 'TradeAdvisor: buy response unparseable — defaulting to buy=true');
        return defaultBuy();
      }

      logger.info(
        {
          token: signal.tokenAddress,
          ticker: signal.ticker,
          buy: decision.buy,
          confidence: decision.confidence.toFixed(2),
          positionSizeMult: decision.positionSizeMult.toFixed(2),
          reasoning: decision.reasoning,
          redFlags: decision.redFlags,
        },
        'AI buy decision',
      );
      return decision;
    } catch (err) {
      logger.warn({ token: signal.tokenAddress, err }, 'TradeAdvisor: buy API error — defaulting to buy=true');
      return defaultBuy();
    }
  }

  // ---------------------------------------------------------------------------
  // Sell decision — gpt-4o-mini + structured output (throttled)
  // ---------------------------------------------------------------------------

  /**
   * Ask the AI whether to sell early.
   * Throttled to one API call per token per 5 minutes.
   * Includes price velocity (#2) for momentum-aware decisions.
   * Falls back to `{ sell: false }` on error or during throttle window.
   */
  async shouldSell(params: {
    tokenAddress: string;
    pnlPct: number;
    pnlSol: number;
    heldMinutes: number;
  }): Promise<SellDecision> {
    if (!this.enabled) return defaultSell();

    // Record latest price first (always, regardless of throttle)
    this.recordPrice(params.tokenAddress, params.pnlPct);

    // Throttle check
    const lastCheck = this.sellCheckAt.get(params.tokenAddress) ?? 0;
    if (Date.now() - lastCheck < TradeAdvisor.SELL_THROTTLE_MS) return defaultSell();
    this.sellCheckAt.set(params.tokenAddress, Date.now());

    const velocityPctPerMin = this.getPriceVelocity(params.tokenAddress);

    try {
      const completion = await this.client.beta.chat.completions.parse({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SELL_SYSTEM_PROMPT },
          { role: 'user', content: buildSellPrompt({ ...params, velocityPctPerMin }, this.cfg) },
        ],
        response_format: zodResponseFormat(SellDecisionSchema, 'sell_decision'),
        temperature: 0.2,
      });

      const decision = completion.choices[0].message.parsed;
      if (!decision) {
        logger.warn({ token: params.tokenAddress }, 'TradeAdvisor: sell response unparseable — defaulting to hold');
        return defaultSell();
      }

      logger.info(
        {
          token: params.tokenAddress,
          sell: decision.sell,
          urgency: decision.urgency,
          pnlPct: params.pnlPct.toFixed(2),
          velocityPctPerMin: velocityPctPerMin?.toFixed(2) ?? 'n/a',
          reasoning: decision.reasoning,
        },
        'AI sell decision',
      );
      return decision;
    } catch (err) {
      logger.warn({ token: params.tokenAddress, err }, 'TradeAdvisor: sell API error — defaulting to hold');
      return defaultSell();
    }
  }

  // ---------------------------------------------------------------------------
  // Clean up per-token state for closed positions
  // ---------------------------------------------------------------------------

  clearToken(tokenAddress: string): void {
    this.sellCheckAt.delete(tokenAddress);
    this.priceHistory.delete(tokenAddress);
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildBuyPrompt(
  signal: Signal,
  curve: BondingCurveInfo | null,
  ctx: BuyContext,
  cfg: TradingConfig,
  reputation: TokenReputation | null,
  tradeStats: TradeStats | null,
): string {
  const lines: string[] = [
    '## Signal',
    `Source: ${signal.source}`,
    `Ticker: ${signal.ticker ?? '(not parsed)'}`,
    `Token: ${signal.tokenAddress}`,
    `Confidence: ${(signal.confidence * 100).toFixed(0)}%`,
    `Message (first 400 chars):`,
    signal.rawMessage.slice(0, 400),
    '',
    '## Bonding Curve',
  ];

  if (curve) {
    lines.push(
      `Progress: ${curve.percentComplete.toFixed(1)}% complete`,
      `Market cap: ${curve.marketCapSol.toFixed(2)} SOL`,
      `Graduated: ${curve.complete}`,
    );
  } else {
    lines.push('(Bonding curve data unavailable — treat as higher risk)');
  }

  // #1 — Token Reputation
  lines.push('', '## Token Reputation');
  if (reputation) {
    lines.push(
      `Name: ${reputation.name ?? '(unknown)'}  Symbol: ${reputation.symbol ?? '(unknown)'}`,
      `Creator: ${reputation.creator ?? '(unknown)'}`,
      `Age: ${reputation.ageMinutes != null ? `${reputation.ageMinutes.toFixed(1)} minutes` : '(unknown)'}`,
      `pump.fun market cap: ${reputation.pumpFunMarketCapSol != null ? `${reputation.pumpFunMarketCapSol.toFixed(1)} SOL` : '(unknown)'}`,
      `Community replies: ${reputation.pumpFunReplies ?? '(unknown)'}`,
      `DEX listed: ${reputation.dexListed}`,
    );
    if (reputation.dexListed) {
      lines.push(
        `DEX 24h volume: $${reputation.dex24hVolumeUsd?.toFixed(0) ?? '?'}`,
        `DEX 24h price change: ${reputation.dex24hPriceChangePct != null ? `${reputation.dex24hPriceChangePct.toFixed(1)}%` : '?'}`,
        `DEX buys/sells 24h: ${reputation.dexBuys24h ?? '?'} buys / ${reputation.dexSells24h ?? '?'} sells`,
        `DEX liquidity: $${reputation.dexLiquidityUsd?.toFixed(0) ?? '?'}`,
      );
    }
    if (reputation.twitter) {
      const tw = reputation.twitter;
      lines.push(
        '',
        '### Twitter / X',
        `Recent mentions: ${tw.mentionCount}`,
        `Hype tweets: ${tw.hypeMentions}  |  Scam/rug tweets: ${tw.scamMentions}`,
      );
      if (tw.sampleTweets.length > 0) {
        lines.push('Sample tweets:');
        tw.sampleTweets.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
      }
    } else {
      lines.push('Twitter: not configured (no TWITTER_BEARER_TOKEN)');
    }
    if (reputation.gmgn) {
      const g = reputation.gmgn;
      lines.push(
        '',
        '### GMGN Smart Money',
        `Holders: ${g.holderCount ?? '?'}`,
        `Smart buys 24h: ${g.smartBuy24h ?? '?'}  |  Smart sells 24h: ${g.smartSell24h ?? '?'}`,
        `Risk score: ${g.riskScore != null ? `${(g.riskScore * 100).toFixed(0)}/100` : '?'}`,
        `Honeypot: ${g.isHoneypot === true ? '⚠ YES' : g.isHoneypot === false ? 'No' : 'Unknown'}`,
      );
    } else {
      lines.push('GMGN: data unavailable (endpoint may require whitelisting)');
    }
    if (reputation.redFlags.length > 0) {
      lines.push(`⚠ Red flags: ${reputation.redFlags.join(' | ')}`);
    } else {
      lines.push('No automated red flags detected.');
    }
  } else {
    lines.push('(Reputation data unavailable — treat as uncertain)');
  }

  // #3 — Historical trade stats
  lines.push('', '## Bot Historical Performance');
  if (tradeStats && tradeStats.overall.totalTrades > 0) {
    const o = tradeStats.overall;
    lines.push(
      `Total closed trades: ${o.totalTrades}`,
      `Overall win rate: ${(o.winRate * 100).toFixed(0)}%  Avg PnL: ${o.avgPnlPct.toFixed(1)}%`,
      `Avg winning trade: +${o.avgWinPct.toFixed(1)}%  Avg losing trade: ${o.avgLossPct.toFixed(1)}%`,
    );

    const streak = tradeStats.recentStreak;
    if (streak > 1) lines.push(`Recent streak: ${streak} wins in a row ✅`);
    else if (streak < -1) lines.push(`Recent streak: ${Math.abs(streak)} losses in a row ⚠`);

    const channelId = signal.channelId;
    const ch = channelId ? tradeStats.byChannel[channelId] : null;
    if (ch && ch.totalTrades >= 3) {
      lines.push(
        `This channel (${channelId}): ${ch.totalTrades} trades, ${(ch.winRate * 100).toFixed(0)}% win rate, avg ${ch.avgPnlPct.toFixed(1)}% PnL`,
      );
    } else {
      lines.push(`This channel: insufficient history (< 3 trades)`);
    }
  } else {
    lines.push('No trade history yet — no statistical basis for channel performance.');
  }

  lines.push(
    '',
    '## Portfolio State',
    `Open positions: ${ctx.openPositions} / ${cfg.max_open_positions}`,
    `Today\'s realised PnL: ${ctx.dailyPnlSol >= 0 ? '+' : ''}${ctx.dailyPnlSol.toFixed(4)} SOL`,
    `Daily loss limit: -${cfg.max_daily_loss_sol} SOL`,
    '',
    '## Bot Parameters',
    `Max position: ${cfg.max_position_sol} SOL`,
    `Profit target: +${cfg.profit_target_pct}%  Stop-loss: ${cfg.stop_loss_pct}%`,
    `Max bonding curve allowed at buy: ${cfg.max_bonding_curve_pct}%`,
    '',
    'Should the bot buy this token? Return your JSON decision.',
  );

  return lines.join('\n');
}

function buildSellPrompt(
  params: {
    tokenAddress: string;
    pnlPct: number;
    pnlSol: number;
    heldMinutes: number;
    velocityPctPerMin: number | null;
  },
  cfg: TradingConfig,
): string {
  const velocityStr =
    params.velocityPctPerMin != null
      ? `${params.velocityPctPerMin >= 0 ? '+' : ''}${params.velocityPctPerMin.toFixed(2)}% per minute`
      : 'insufficient data';

  return [
    '## Current Position',
    `Token: ${params.tokenAddress}`,
    `Current PnL: ${params.pnlPct >= 0 ? '+' : ''}${params.pnlPct.toFixed(2)}% (${params.pnlSol >= 0 ? '+' : ''}${params.pnlSol.toFixed(4)} SOL)`,
    `Hold time: ${params.heldMinutes.toFixed(0)} minutes`,
    `Price velocity (last 2 min): ${velocityStr}`,
    '',
    '## Bot Thresholds (auto-execute regardless of your answer)',
    `Profit target: +${cfg.profit_target_pct}%`,
    `Stop-loss: ${cfg.stop_loss_pct}%`,
    '',
    'Should the bot sell this position early? Return your JSON decision.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Fallback defaults
// ---------------------------------------------------------------------------

function defaultBuy(): BuyDecision {
  return {
    buy: true,
    confidence: 0.5,
    positionSizeMult: 1.0,
    reasoning: 'AI advisor disabled or unavailable — passing through to risk checks',
    redFlags: [],
  };
}

function defaultSell(): SellDecision {
  return {
    sell: false,
    urgency: 'normal',
    reasoning: 'AI advisor disabled, throttled, or unavailable — rely on thresholds',
  };
}
