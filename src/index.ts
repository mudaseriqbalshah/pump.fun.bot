/**
 * Pump.fun trading bot — orchestrator entry point.
 *
 * Boot order:
 *   1. Database
 *   2. RPC Manager + Health Monitor
 *   3. PumpFun Scanner + Bonding Curve Tracker
 *   4. DEX detectors (Raydium + Jupiter)
 *   5. Risk Manager, Buyer, Seller
 *   6. Position Tracker
 *   7. Notifications
 *   8. Signal pipeline (Telegram + Discord → Aggregator)
 *
 * Signal flow:
 *   Monitor → Aggregator 'signal' → Buyer.buy()
 *     → on success → PositionTracker.addPosition() + notify
 *   PositionTracker 'position_closed' → TelegramNotifier.notifyPositionClosed()
 */

import { env, yamlConfig, rpcEndpoints, tradingConfig } from './config/index.js';
import { getDb } from './db/client.js';
import { RpcManager } from './rpc/manager.js';
import { RpcHealthMonitor } from './rpc/health.js';
import { PumpFunScanner } from './scanner/pumpfun.js';
import { BondingCurveTracker } from './scanner/bonding.js';
import { TelegramMonitor } from './signals/telegram.js';
import { DiscordMonitor } from './signals/discord.js';
import { SignalAggregator } from './signals/aggregator.js';
import { RiskManager } from './trader/risk.js';
import { Buyer } from './trader/buyer.js';
import { Seller } from './trader/seller.js';
import { PositionTracker } from './trader/position.js';
import { RaydiumDetector } from './dex/raydium.js';
import { JupiterDetector } from './dex/jupiter.js';
import { TelegramNotifier } from './notifications/telegram.js';
import { TradeAdvisor } from './ai/advisor.js';
import { logger } from './utils/logger.js';
import type { Signal } from './signals/types.js';
import type { PositionClosedEvent } from './trader/position.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('Pump.fun bot starting…');

  // 1. Database
  const db = getDb();

  // 2. RPC
  const rpcManager = new RpcManager(rpcEndpoints, yamlConfig.rpc.strategy);
  const rpcHealth = new RpcHealthMonitor(rpcManager, yamlConfig.rpc.health_check_interval_s);

  // 3. PumpFun scanner + bonding curve tracker.
  //    Scanner owns the shared AnchorProvider / PumpFunSDK; bonding tracker reuses it.
  const scanner = new PumpFunScanner(rpcManager.getConnection());
  const bondingTracker = new BondingCurveTracker(scanner.pumpSdk);

  // 4. DEX detectors
  const raydiumDetector = new RaydiumDetector(rpcManager);
  const jupiterDetector = new JupiterDetector();

  // 5. Trading components
  const riskManager = new RiskManager(tradingConfig, db);
  const buyer = new Buyer(tradingConfig, rpcManager, riskManager, bondingTracker, db);
  const advisor = new TradeAdvisor(env.OPENAI_API_KEY, tradingConfig);
  const seller = new Seller(tradingConfig, rpcManager, db, advisor);

  // 6. Position tracker — state machine: bonding → dex_launched → sell
  const positionTracker = new PositionTracker(
    bondingTracker,
    raydiumDetector,
    jupiterDetector,
    seller,
    db,
  );

  // 7. Notifications
  const notifier = new TelegramNotifier(
    env.NOTIFY_TELEGRAM_BOT_TOKEN,
    env.NOTIFY_TELEGRAM_CHAT_ID,
  );

  // 8. Signal pipeline
  const telegramMonitor = new TelegramMonitor({
    apiId: Number(env.TELEGRAM_API_ID),
    apiHash: env.TELEGRAM_API_HASH,
    phone: env.TELEGRAM_PHONE,
    channels: yamlConfig.telegram.channels,
  });

  const discordMonitor = new DiscordMonitor({
    token: env.DISCORD_BOT_TOKEN,
    channels: yamlConfig.discord.channels,
  });

  const aggregator = new SignalAggregator(
    {
      minConfidence: tradingConfig.min_signal_confidence,
      dedupWindowMs: tradingConfig.signal_dedup_window_s * 1_000,
    },
    db,
  );

  // ---------------------------------------------------------------------------
  // Wire events
  // ---------------------------------------------------------------------------

  // Monitors → aggregator
  aggregator.register(telegramMonitor);
  aggregator.register(discordMonitor);

  // Track when positions were opened so we can report hold time.
  const openedAt = new Map<string, number>();

  // Qualified signal → AI evaluation → buy → register position
  aggregator.on('signal', (signal: Signal) => {
    void (async () => {
      // AI buy evaluation (optional — falls back gracefully when disabled).
      if (advisor.isEnabled) {
        const openPositions = db.getOpenPositions().length;
        const dailyPnlSol = db.getDailyPnlSol();
        const curve = await bondingTracker.fetch(signal.tokenAddress);
        const aiDecision = await advisor.shouldBuy(signal, curve, { openPositions, dailyPnlSol });

        if (!aiDecision.buy) {
          logger.info(
            {
              tokenAddress: signal.tokenAddress,
              reasoning: aiDecision.reasoning,
              redFlags: aiDecision.redFlags,
            },
            'AI advisor blocked buy',
          );
          return;
        }

        // Scale position size by AI multiplier (clamp to [0.1, 1.0]).
        const mult = Math.min(1.0, Math.max(0.1, aiDecision.positionSizeMult));
        if (mult < 1.0) {
          logger.info(
            { tokenAddress: signal.tokenAddress, positionSizeMult: mult.toFixed(2) },
            'AI advisor reduced position size',
          );
          // Temporarily adjust signal confidence to propagate the sizing hint to buyer.
          signal = { ...signal, confidence: signal.confidence * mult };
        }
      }

      const result = await buyer.buy(signal);

      if (result.success) {
        openedAt.set(signal.tokenAddress, Date.now());
        positionTracker.addPosition(signal.tokenAddress);

        notifier.notifyBuyOpened({
          tokenAddress: signal.tokenAddress,
          ticker: signal.ticker ?? signal.tokenAddress.slice(0, 8),
          positionSizeSol: result.positionSizeSol,
          signature: result.signature,
        });
      } else {
        logger.debug({ tokenAddress: signal.tokenAddress, reason: result.reason }, 'Buy skipped');
      }
    })();
  });

  // Position closed → notify + clean up advisor state
  positionTracker.on('position_closed', (event: PositionClosedEvent) => {
    const openMs = openedAt.get(event.tokenAddress);
    const heldMinutes = openMs !== undefined ? (Date.now() - openMs) / 60_000 : undefined;
    openedAt.delete(event.tokenAddress);
    advisor.clearToken(event.tokenAddress);

    notifier.notifyPositionClosed({
      tokenAddress: event.tokenAddress,
      pnlSol: event.pnlSol,
      pnlPct: event.pnlPct,
      trigger: event.trigger,
      heldMinutes,
    });
  });

  // ---------------------------------------------------------------------------
  // Start services
  // ---------------------------------------------------------------------------

  rpcHealth.start();
  aggregator.start();
  positionTracker.start();
  scanner.start();

  // Telegram auth is interactive on first run (OTP prompt) — must be awaited.
  await telegramMonitor.start();
  await discordMonitor.start();

  logger.info('All services running — bot is live');

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutdown signal received — stopping services…');

    try {
      scanner.stop();
      positionTracker.stop();
      aggregator.stop();
      rpcHealth.stop();
      await discordMonitor.stop();
      await telegramMonitor.stop();
    } catch (err) {
      logger.warn({ err }, 'Error during shutdown (non-fatal)');
    }

    logger.info('Bot stopped cleanly');
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep the process alive (the setInterval timers are unref'd; this ref keeps Node running).
  process.stdin.resume();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Unhandled error in main — exiting');
  process.exit(1);
});
