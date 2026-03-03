import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Telegram Bot API — sendMessage
// ---------------------------------------------------------------------------

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

interface SendMessagePayload {
  chat_id: string;
  text: string;
  parse_mode: 'HTML';
  disable_web_page_preview?: boolean;
}

// ---------------------------------------------------------------------------
// TelegramNotifier
// ---------------------------------------------------------------------------

/**
 * Sends formatted HTML messages to a Telegram chat via the Bot API.
 *
 * All methods are fire-and-forget: failures are logged as warnings and never
 * propagate to the caller.  The notifier is silently disabled when
 * `botToken` or `chatId` are empty strings (default when not configured).
 */
export class TelegramNotifier {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly enabled: boolean;

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.enabled = botToken.length > 0 && chatId.length > 0;

    if (this.enabled) {
      logger.info({ chatId }, 'TelegramNotifier enabled');
    } else {
      logger.info('TelegramNotifier disabled — NOTIFY_TELEGRAM_BOT_TOKEN or NOTIFY_TELEGRAM_CHAT_ID not set');
    }
  }

  // ---------------------------------------------------------------------------
  // Public notification methods
  // ---------------------------------------------------------------------------

  /**
   * Notify that a buy order was successfully executed.
   */
  notifyBuyOpened(opts: {
    tokenAddress: string;
    ticker: string;
    positionSizeSol: number;
    entryPriceLamports?: number;
    bondingPct?: number;
    signature: string;
  }): void {
    const lines = [
      '🟢 <b>Buy opened</b>',
      '',
      `Token: <code>${opts.ticker}</code>`,
      `Mint: <code>${opts.tokenAddress}</code>`,
      `Size: <b>${opts.positionSizeSol.toFixed(4)} SOL</b>`,
    ];
    if (opts.entryPriceLamports !== undefined) {
      lines.push(`Entry: ${opts.entryPriceLamports.toLocaleString()} lamports/token`);
    }
    if (opts.bondingPct !== undefined) {
      lines.push(`Bonding: ${opts.bondingPct.toFixed(1)}%`);
    }
    lines.push(`Tx: <code>${opts.signature}</code>`);
    const text = lines.join('\n');

    void this.send(text);
  }

  /**
   * Notify that a position was closed (profit target or stop-loss).
   */
  notifyPositionClosed(opts: {
    tokenAddress: string;
    pnlSol: number;
    pnlPct: number;
    trigger: 'profit_target' | 'stop_loss';
    heldMinutes?: number;
  }): void {
    const isProfit = opts.trigger === 'profit_target';
    const emoji = isProfit ? '💰' : '🔴';
    const triggerLabel = isProfit ? 'Profit target hit' : 'Stop-loss hit';
    const pnlSign = opts.pnlSol >= 0 ? '+' : '';

    const lines = [
      `${emoji} <b>${triggerLabel}</b>`,
      '',
      `Mint: <code>${opts.tokenAddress}</code>`,
      `PnL: <b>${pnlSign}${opts.pnlSol.toFixed(6)} SOL (${pnlSign}${opts.pnlPct.toFixed(1)}%)</b>`,
    ];
    if (opts.heldMinutes !== undefined) {
      lines.push(`Held: ${opts.heldMinutes.toFixed(1)} min`);
    }
    const text = lines.join('\n');

    void this.send(text);
  }

  /**
   * Notify that a risk check blocked a trade.
   */
  notifyRiskLimit(opts: {
    tokenAddress: string;
    reason: string;
  }): void {
    const text = [
      '⚠️ <b>Risk limit — trade blocked</b>',
      '',
      `Mint: <code>${opts.tokenAddress}</code>`,
      `Reason: ${opts.reason}`,
    ].join('\n');

    void this.send(text);
  }

  /**
   * Notify about an RPC health-check failure or recovery.
   *
   * `rpcUrl` is automatically redacted to hide QuickNode tokens.
   */
  notifyRpcStatus(opts: {
    url: string;
    status: 'degraded' | 'recovered';
    consecutiveErrors?: number;
  }): void {
    const emoji = opts.status === 'degraded' ? '🔶' : '✅';
    const label = opts.status === 'degraded' ? 'RPC degraded' : 'RPC recovered';

    const lines = [
      `${emoji} <b>${label}</b>`,
      '',
      `Endpoint: <code>${redactUrl(opts.url)}</code>`,
    ];

    if (opts.status === 'degraded' && opts.consecutiveErrors !== undefined) {
      lines.push(`Consecutive errors: ${opts.consecutiveErrors}`);
    }

    void this.send(lines.join('\n'));
  }

  // ---------------------------------------------------------------------------
  // Private — HTTP send
  // ---------------------------------------------------------------------------

  private async send(text: string): Promise<void> {
    if (!this.enabled) return;

    const payload: SendMessagePayload = {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };

    try {
      const url = `${TELEGRAM_API_BASE}${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '(unreadable)');
        logger.warn(
          { status: response.status, body: body.slice(0, 200) },
          'TelegramNotifier: sendMessage failed',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'TelegramNotifier: network error sending message');
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Replace QuickNode (and similar) API tokens embedded in RPC URLs with `***`.
 *
 * QuickNode URLs look like:
 *   https://<name>.solana-mainnet.quiknode.pro/<TOKEN>/
 *
 * We redact any path segment that is 32+ hex characters.
 */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.pathname = u.pathname.replace(/\/[0-9a-f]{32,}(\/|$)/gi, '/***$1');
    u.password = '';
    return u.toString();
  } catch {
    return raw.replace(/[0-9a-f]{32,}/gi, '***');
  }
}
