import { z } from 'zod';

// ---------------------------------------------------------------------------
// Environment variables schema
// ---------------------------------------------------------------------------

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Solana wallet
  WALLET_PRIVATE_KEY: z.string().min(1, 'WALLET_PRIVATE_KEY is required'),

  // QuickNode RPC endpoints (at least 1 required, up to 10)
  RPC_URL_1: z.string().url(),
  RPC_URL_2: z.string().url().optional(),
  RPC_URL_3: z.string().url().optional(),
  RPC_URL_4: z.string().url().optional(),
  RPC_URL_5: z.string().url().optional(),
  RPC_URL_6: z.string().url().optional(),
  RPC_URL_7: z.string().url().optional(),
  RPC_URL_8: z.string().url().optional(),
  RPC_URL_9: z.string().url().optional(),
  RPC_URL_10: z.string().url().optional(),

  // Telegram user account (gramjs / MTProto)
  TELEGRAM_API_ID: z.string().min(1, 'TELEGRAM_API_ID is required'),
  TELEGRAM_API_HASH: z.string().min(1, 'TELEGRAM_API_HASH is required'),
  TELEGRAM_PHONE: z.string().min(1, 'TELEGRAM_PHONE is required'),

  // Discord bot
  DISCORD_BOT_TOKEN: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),

  // Notification Telegram bot (optional — omit to disable notifications)
  NOTIFY_TELEGRAM_BOT_TOKEN: z.string().default(''),
  NOTIFY_TELEGRAM_CHAT_ID: z.string().default(''),

  // OpenAI API (optional — omit to disable AI advisor)
  OPENAI_API_KEY: z.string().default(''),

  // Twitter / X API v2 bearer token (optional — enables Twitter reputation check)
  // Get yours at: https://developer.twitter.com/en/portal/dashboard
  TWITTER_BEARER_TOKEN: z.string().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

// ---------------------------------------------------------------------------
// config.yaml schema
// ---------------------------------------------------------------------------

const RpcConfigSchema = z.object({
  strategy: z.enum(['round-robin', 'fastest', 'failover']).default('round-robin'),
  health_check_interval_s: z.number().positive().default(30),
  // endpoints injected from env at runtime
});

const TelegramChannelSchema = z.object({
  id: z.number(),
  name: z.string(),
  weight: z.number().min(0).max(1).default(1.0),
});

const DiscordChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  weight: z.number().min(0).max(1).default(1.0),
});

const TradingConfigSchema = z.object({
  wallet_keypair_path: z.string().default('~/.config/solana/id.json'),
  max_position_sol: z.number().positive().default(0.5),
  max_open_positions: z.number().int().positive().default(5),
  max_daily_loss_sol: z.number().positive().default(3.0),
  max_bonding_curve_pct: z.number().min(0).max(100).default(50),
  min_signal_confidence: z.number().min(0).max(1).default(0.6),
  profit_target_pct: z.number().positive().default(200),
  stop_loss_pct: z.number().negative().default(-30),
  slippage_bps: z.number().int().positive().default(1000),
  buy_retry_count: z.number().int().positive().default(3),
  signal_dedup_window_s: z.number().positive().default(60),
});

const NotificationsConfigSchema = z.object({
  telegram_bot_token: z.string().default(''),
  telegram_chat_id: z.string().default(''),
});

export const YamlConfigSchema = z.object({
  rpc: RpcConfigSchema,
  telegram: z.object({
    channels: z.array(TelegramChannelSchema).default([]),
  }),
  discord: z.object({
    channels: z.array(DiscordChannelSchema).default([]),
  }),
  trading: TradingConfigSchema,
  notifications: NotificationsConfigSchema,
});

export type YamlConfig = z.infer<typeof YamlConfigSchema>;
export type TradingConfig = z.infer<typeof TradingConfigSchema>;
export type TelegramChannel = z.infer<typeof TelegramChannelSchema>;
export type DiscordChannel = z.infer<typeof DiscordChannelSchema>;
