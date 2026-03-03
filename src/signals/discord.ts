import { EventEmitter } from 'events';
import { Client, Events, GatewayIntentBits, type Message } from 'discord.js';
import type { DiscordChannel } from '../config/schema.js';
import type { Signal } from './types.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Parsing constants  (identical logic to the Telegram monitor)
// ---------------------------------------------------------------------------

/** Solana public key: base58, 43–44 chars (no 0/O/I/l). */
const SOLANA_CA_RE = /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g;

/** Ticker patterns: $TICKER | ticker: TICKER | token: TICKER */
const TICKER_RE = /\$([A-Z]{2,10})|\bticker[:\s]+([A-Z]{2,10})|\btoken[:\s]+([A-Z]{2,10})/i;

/** Keywords that signal a genuine pump.fun call. */
const HYPE_KEYWORDS = [
  'pump', 'gem', 'moon', 'alpha', 'launch', 'call', 'buy', 'entry',
  'degen', 'ape', '100x', '1000x', 'stealth', 'low cap', 'fair launch',
  'trending', 'early', 'new token', 'just launched',
];

// ---------------------------------------------------------------------------
// DiscordMonitor
// ---------------------------------------------------------------------------

export interface DiscordMonitorOptions {
  token: string;
  channels: DiscordChannel[];
}

export class DiscordMonitor extends EventEmitter {
  private readonly token: string;
  private readonly channels: DiscordChannel[];

  /** channelId (snowflake string) → configured weight */
  private readonly channelWeightMap = new Map<string, number>();

  private client: Client | null = null;

  constructor(options: DiscordMonitorOptions) {
    super();
    this.token = options.token;
    this.channels = options.channels;

    for (const ch of options.channels) {
      this.channelWeightMap.set(ch.id, ch.weight ?? 1.0);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        // Required to receive message events in guild channels.
        GatewayIntentBits.GuildMessages,
        // Privileged intent — must be enabled in the Discord Developer Portal
        // (Bot → Privileged Gateway Intents → Message Content Intent).
        GatewayIntentBits.MessageContent,
      ],
    });

    // Register the ready listener BEFORE calling login so we don't miss the event.
    const ready = new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (c) => {
        logger.info(
          { tag: c.user.tag, channels: this.channels.map((ch) => ch.name) },
          'Discord monitor started — listening for signals',
        );
        resolve();
      });
    });

    this.client.on(Events.MessageCreate, (msg) => this.onMessage(msg));

    await this.client.login(this.token);
    await ready;
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      logger.info('Discord monitor stopped');
    }
  }

  // ---------------------------------------------------------------------------
  // Private — message handling
  // ---------------------------------------------------------------------------

  private onMessage(message: Message): void {
    // Ignore other bots (self included — discord.js filters that by default).
    if (message.author.bot) return;

    // Only act on configured channels.
    const weight = this.channelWeightMap.get(message.channelId);
    if (weight === undefined) return;

    const text = message.content;
    if (!text) return;

    const tokenAddress = this.extractSolanaAddress(text);
    if (!tokenAddress) return;

    const signal: Signal = {
      source: 'discord',
      channelId: message.channelId,
      tokenAddress,
      ticker: this.extractTicker(text),
      rawMessage: text.slice(0, 500),
      confidence: this.scoreConfidence(text, weight),
      timestamp: message.createdTimestamp,
    };

    logger.info(
      {
        tokenAddress,
        ticker: signal.ticker,
        confidence: signal.confidence.toFixed(2),
        channelId: message.channelId,
        author: message.author.tag,
      },
      'Discord signal',
    );

    this.emit('signal', signal);
  }

  // ---------------------------------------------------------------------------
  // Private — parsing  (mirrors TelegramMonitor's logic)
  // ---------------------------------------------------------------------------

  private extractSolanaAddress(text: string): string | undefined {
    SOLANA_CA_RE.lastIndex = 0; // reset stateful regex
    const matches = text.match(SOLANA_CA_RE);
    return matches?.find((m) => m.length >= 43 && m.length <= 44);
  }

  private extractTicker(text: string): string | undefined {
    const m = text.match(TICKER_RE);
    if (!m) return undefined;
    return (m[1] ?? m[2] ?? m[3])?.toUpperCase();
  }

  /**
   * Confidence = channel_weight × (0.70 base + up to 0.30 from keyword hits).
   * Clamped to [0, 1].
   */
  private scoreConfidence(text: string, weight: number): number {
    const lower = text.toLowerCase();
    const hits = HYPE_KEYWORDS.filter((kw) => lower.includes(kw)).length;
    return Math.min(1.0, Math.max(0, weight * (0.70 + Math.min(hits, 6) * 0.05)));
  }
}
