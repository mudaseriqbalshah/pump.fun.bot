import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline/promises';
import { TelegramClient, Api, sessions } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events';

// StringSession is accessed through the `sessions` namespace re-exported by the
// main telegram entry — gives us the fully-typed gramjs class without a sub-path
// import that NodeNext rejects for CJS packages with no `exports` field.
const StringSession = sessions.StringSession;
type StringSession = InstanceType<typeof sessions.StringSession>;
import type { TelegramChannel } from '../config/schema.js';
import type { Signal } from './types.js';
import { logger } from '../utils/logger.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../../');

// ---------------------------------------------------------------------------
// Parsing constants
// ---------------------------------------------------------------------------

/**
 * Solana public key: base58-encoded, 43–44 characters.
 * Excludes 0, O, I, l (base58 alphabet).
 */
const SOLANA_CA_RE = /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g;

/**
 * Ticker patterns:
 *   $TICKER  |  ticker: TICKER  |  token: TICKER
 */
const TICKER_RE = /\$([A-Z]{2,10})|\bticker[:\s]+([A-Z]{2,10})|\btoken[:\s]+([A-Z]{2,10})/i;

/** Keywords that indicate a genuine pump.fun call — each hit boosts confidence. */
const HYPE_KEYWORDS = [
  'pump', 'gem', 'moon', 'alpha', 'launch', 'call', 'buy', 'entry',
  'degen', 'ape', '100x', '1000x', 'stealth', 'low cap', 'fair launch',
  'trending', 'early', 'new token', 'just launched',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramMonitorOptions {
  apiId: number;
  apiHash: string;
  phone: string;
  channels: TelegramChannel[];
  /** Path to persist the MTProto session string. Default: data/telegram.session */
  sessionPath?: string;
}

// ---------------------------------------------------------------------------
// TelegramMonitor
// ---------------------------------------------------------------------------

export class TelegramMonitor extends EventEmitter {
  private readonly apiId: number;
  private readonly apiHash: string;
  private readonly phone: string;
  private readonly channels: TelegramChannel[];
  private readonly sessionPath: string;

  /** channel.id → channel.weight for fast O(1) lookup per message. */
  private readonly channelWeightMap = new Map<number, number>();

  /** Held so we can call session.save() after auth (StringSession returns string). */
  private session: StringSession | null = null;
  private client: TelegramClient | null = null;

  constructor(options: TelegramMonitorOptions) {
    super();
    this.apiId = options.apiId;
    this.apiHash = options.apiHash;
    this.phone = options.phone;
    this.channels = options.channels;
    this.sessionPath = options.sessionPath ?? resolve(ROOT, 'data/telegram.session');

    for (const ch of options.channels) {
      this.channelWeightMap.set(ch.id, ch.weight ?? 1.0);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    const sessionString = existsSync(this.sessionPath)
      ? readFileSync(this.sessionPath, 'utf8').trim()
      : '';

    this.session = new StringSession(sessionString);

    this.client = new TelegramClient(this.session, this.apiId, this.apiHash, {
      connectionRetries: 5,
    });

    logger.info({ channelCount: this.channels.length }, 'Connecting to Telegram...');

    await this.client.start({
      phoneNumber: () => Promise.resolve(this.phone),
      // First-run interactive prompts; subsequent runs use the saved session.
      phoneCode: () => this.prompt('Enter the Telegram verification code you received: '),
      password: () => this.prompt('Enter your 2FA password (press Enter if none): '),
      onError: (err) => logger.error({ err }, 'Telegram auth error'),
    });

    this.persistSession();

    // Subscribe to configured channel IDs.
    // PeerID (number) is a valid EntityLike in gramjs.
    const channelIds = this.channels.map((ch) => ch.id);

    this.client.addEventHandler(
      (event: NewMessageEvent) => void this.handleMessage(event),
      // Cast needed: our ambient NewMessage declaration omits gramjs's internal
      // EventBuilder properties (blacklistChats, build, resolve, etc.).
      // The actual runtime class satisfies the constraint; this is a type-only cast.
      new NewMessage({ chats: channelIds }) as never,
    );

    logger.info(
      { channels: this.channels.map((c) => c.name) },
      'Telegram monitor started — listening for signals',
    );
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
      logger.info('Telegram monitor stopped');
    }
  }

  // ---------------------------------------------------------------------------
  // Private — message handling
  // ---------------------------------------------------------------------------

  private async handleMessage(event: NewMessageEvent): Promise<void> {
    const text = event.message.text;
    if (!text) return;

    // Resolve the full negative channel ID (e.g. -1001234567890).
    const channelId = this.resolveChannelId(event.message.peerId);
    if (channelId === null) return; // not a channel message

    const weight = this.channelWeightMap.get(channelId) ?? 1.0;
    const tokenAddress = this.extractSolanaAddress(text);
    if (!tokenAddress) return;

    const signal: Signal = {
      source: 'telegram',
      channelId: String(channelId),
      tokenAddress,
      ticker: this.extractTicker(text),
      rawMessage: text.slice(0, 500),
      confidence: this.scoreConfidence(text, weight),
      timestamp: Date.now(),
    };

    logger.info(
      { tokenAddress, ticker: signal.ticker, confidence: signal.confidence.toFixed(2), channelId },
      'Telegram signal',
    );

    this.emit('signal', signal);
  }

  /**
   * Convert gramjs PeerChannel to the full negative channel ID that matches
   * what the user configures in config.yaml (e.g. -1001234567890).
   */
  private resolveChannelId(peer: Api.TypePeer): number | null {
    if (peer instanceof Api.PeerChannel) {
      // peer.channelId is big-integer BigInteger
      return -(1_000_000_000_000 + peer.channelId.toJSNumber());
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Private — parsing
  // ---------------------------------------------------------------------------

  private extractSolanaAddress(text: string): string | undefined {
    SOLANA_CA_RE.lastIndex = 0; // reset stateful regex
    const matches = text.match(SOLANA_CA_RE);
    // Return the first match; filter out common false positives (all-digit, too long).
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

  // ---------------------------------------------------------------------------
  // Private — session & auth
  // ---------------------------------------------------------------------------

  private persistSession(): void {
    if (!this.session) return;
    const saved = this.session.save(); // StringSession.save() → string
    if (!saved) return;
    mkdirSync(dirname(this.sessionPath), { recursive: true });
    writeFileSync(this.sessionPath, saved, 'utf8');
    logger.info({ sessionPath: this.sessionPath }, 'Telegram session saved');
  }

  private async prompt(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(question);
    rl.close();
    return answer.trim();
  }
}
