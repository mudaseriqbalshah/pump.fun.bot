export type SignalSource = 'telegram' | 'discord';

/**
 * A qualified token signal emitted by a channel monitor.
 * Passed through the aggregator before reaching the buyer pipeline.
 */
export interface Signal {
  source: SignalSource;
  /** Raw channel ID string (negative number for Telegram, snowflake for Discord). */
  channelId: string;
  /** Solana token mint address (base58, 43–44 chars). */
  tokenAddress: string;
  /** Ticker symbol parsed from the message, if present. */
  ticker?: string;
  /** First 500 chars of the original message text. */
  rawMessage: string;
  /**
   * Confidence score 0–1.
   * - Base: channel weight from config
   * - Boosted by hype keyword density in the message
   * - Further boosted by the aggregator when the same token appears across sources
   */
  confidence: number;
  /** Unix timestamp (ms) when the signal was first observed. */
  timestamp: number;
}
