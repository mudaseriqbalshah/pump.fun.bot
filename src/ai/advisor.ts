import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { TradingConfig } from '../config/schema.js';
import type { Signal } from '../signals/types.js';
import type { BondingCurveInfo } from '../scanner/bonding.js';
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
// Context passed to shouldBuy
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
- Be CONSERVATIVE. Skip ambiguous trades; a missed opportunity is better than a loss.
- Look for red flags in the message: vague hype, no ticker, suspiciously round numbers, known rug-pull patterns.
- Prefer tokens early in their bonding curve (< 30% complete) with clear ticker symbols.
- If open positions are near the max, recommend skipping unless confidence is very high.`;

const SELL_SYSTEM_PROMPT = `You are a risk-aware trading advisor for an automated pump.fun Solana memecoin bot.
Your role is to decide whether to sell a position EARLY — before the configured profit/stop-loss thresholds are reached.

Guidelines:
- The bot will automatically sell at the profit target or stop-loss regardless of your answer.
- Only recommend an early sell if there is a STRONG reason: e.g., position held too long, PnL trending negative, or unusual risk.
- "immediate" urgency means: sell right now even if thresholds are not met. Use sparingly.
- "normal" urgency is advisory only and only acts if thresholds are also met.`;

// ---------------------------------------------------------------------------
// TradeAdvisor
// ---------------------------------------------------------------------------

/**
 * AI-powered trading advisor using the OpenAI API.
 *
 * Buy decisions  → gpt-4o with structured outputs (deep analysis, called infrequently).
 * Sell decisions → gpt-4o-mini with structured outputs (fast + cheap; throttled per token).
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
  // Buy decision — gpt-4o + structured output
  // ---------------------------------------------------------------------------

  /**
   * Ask the AI whether to buy a token.
   * Falls back to `{ buy: true, confidence: 0.5, positionSizeMult: 1.0 }` on any error
   * so existing risk checks still apply downstream.
   */
  async shouldBuy(
    signal: Signal,
    curve: BondingCurveInfo | null,
    ctx: BuyContext,
  ): Promise<BuyDecision> {
    if (!this.enabled) return defaultBuy();

    try {
      const completion = await this.client.beta.chat.completions.parse({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: BUY_SYSTEM_PROMPT },
          { role: 'user', content: buildBuyPrompt(signal, curve, ctx, this.cfg) },
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
      logger.warn(
        { token: signal.tokenAddress, err },
        'TradeAdvisor: buy API error — defaulting to buy=true',
      );
      return defaultBuy();
    }
  }

  // ---------------------------------------------------------------------------
  // Sell decision — gpt-4o-mini + structured output (throttled)
  // ---------------------------------------------------------------------------

  /**
   * Ask the AI whether to sell early.
   * Throttled to one API call per token per 5 minutes.
   * Falls back to `{ sell: false }` on error or during throttle window.
   */
  async shouldSell(params: {
    tokenAddress: string;
    pnlPct: number;
    pnlSol: number;
    heldMinutes: number;
  }): Promise<SellDecision> {
    if (!this.enabled) return defaultSell();

    // Throttle check
    const lastCheck = this.sellCheckAt.get(params.tokenAddress) ?? 0;
    if (Date.now() - lastCheck < TradeAdvisor.SELL_THROTTLE_MS) return defaultSell();
    this.sellCheckAt.set(params.tokenAddress, Date.now());

    try {
      const completion = await this.client.beta.chat.completions.parse({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SELL_SYSTEM_PROMPT },
          { role: 'user', content: buildSellPrompt(params, this.cfg) },
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
          reasoning: decision.reasoning,
        },
        'AI sell decision',
      );
      return decision;
    } catch (err) {
      logger.warn(
        { token: params.tokenAddress, err },
        'TradeAdvisor: sell API error — defaulting to hold',
      );
      return defaultSell();
    }
  }

  // ---------------------------------------------------------------------------
  // Clean up throttle map for closed positions
  // ---------------------------------------------------------------------------

  clearToken(tokenAddress: string): void {
    this.sellCheckAt.delete(tokenAddress);
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
): string {
  const lines: string[] = [
    '## Signal Data',
    `Source: ${signal.source}`,
    `Ticker: ${signal.ticker ?? '(not parsed)'}`,
    `Token address: ${signal.tokenAddress}`,
    `Aggregated confidence: ${(signal.confidence * 100).toFixed(0)}%`,
    `Message (truncated to 400 chars):`,
    signal.rawMessage.slice(0, 400),
    '',
    '## Bonding Curve',
  ];

  if (curve) {
    lines.push(
      `Progress: ${curve.percentComplete.toFixed(1)}% complete`,
      `Market cap: ${curve.marketCapSol.toFixed(2)} SOL`,
      `Graduated (done): ${curve.complete}`,
    );
  } else {
    lines.push('(Bonding curve data unavailable — treat as higher risk)');
  }

  lines.push(
    '',
    '## Portfolio State',
    `Open positions: ${ctx.openPositions} / ${cfg.max_open_positions}`,
    `Today\'s realised PnL: ${ctx.dailyPnlSol >= 0 ? '+' : ''}${ctx.dailyPnlSol.toFixed(4)} SOL`,
    `Daily loss limit: -${cfg.max_daily_loss_sol} SOL`,
    '',
    '## Bot Parameters',
    `Max position size: ${cfg.max_position_sol} SOL`,
    `Profit target: +${cfg.profit_target_pct}%`,
    `Stop-loss: ${cfg.stop_loss_pct}%`,
    `Max bonding curve allowed: ${cfg.max_bonding_curve_pct}%`,
    '',
    'Should the bot buy this token? Return your decision as JSON.',
  );

  return lines.join('\n');
}

function buildSellPrompt(
  params: { tokenAddress: string; pnlPct: number; pnlSol: number; heldMinutes: number },
  cfg: TradingConfig,
): string {
  return [
    '## Current Position',
    `Token: ${params.tokenAddress}`,
    `Current PnL: ${params.pnlPct >= 0 ? '+' : ''}${params.pnlPct.toFixed(2)}% (${params.pnlSol >= 0 ? '+' : ''}${params.pnlSol.toFixed(4)} SOL)`,
    `Hold time: ${params.heldMinutes.toFixed(0)} minutes`,
    '',
    '## Bot Thresholds (auto-execute)',
    `Profit target: +${cfg.profit_target_pct}% — bot sells automatically when hit`,
    `Stop-loss: ${cfg.stop_loss_pct}% — bot sells automatically when hit`,
    '',
    'Should the bot sell this position early? Return your decision as JSON.',
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
