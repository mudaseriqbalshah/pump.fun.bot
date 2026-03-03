import { readFileSync } from 'fs';
import { homedir } from 'os';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { createJupiterApiClient } from '@jup-ag/api';
import type { QuoteResponse, SwapApi } from '@jup-ag/api';
import type { RpcManager } from '../rpc/manager.js';
import type { DatabaseClient, PositionStatus } from '../db/client.js';
import type { TradingConfig } from '../config/schema.js';
import type { TradeAdvisor } from '../ai/advisor.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wrapped SOL mint address. */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const LAMPORTS_PER_SOL = 1e9;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type SellTrigger = 'profit_target' | 'stop_loss' | 'ai_early';

export type SellResult =
  | {
      success: true;
      signature: string;
      pnlSol: number;
      pnlPct: number;
      trigger: SellTrigger;
    }
  | { success: false; reason: string };

// ---------------------------------------------------------------------------
// Seller
// ---------------------------------------------------------------------------

export class Seller {
  private readonly wallet: Keypair;
  private readonly rpcManager: RpcManager;
  private readonly db: DatabaseClient;
  private readonly cfg: TradingConfig;
  private readonly jupApi: SwapApi;
  private readonly advisor: TradeAdvisor | null;

  constructor(
    cfg: TradingConfig,
    rpcManager: RpcManager,
    db: DatabaseClient,
    advisor?: TradeAdvisor,
  ) {
    this.cfg = cfg;
    this.rpcManager = rpcManager;
    this.db = db;
    this.advisor = advisor ?? null;
    this.wallet = loadKeypair(cfg.wallet_keypair_path);
    this.jupApi = createJupiterApiClient();
    logger.info({ pubkey: this.wallet.publicKey.toBase58() }, 'Seller wallet loaded');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Evaluate whether to sell the given token position and execute if so.
   *
   * Decision logic (applied to the *current* DEX price via Jupiter quote):
   *   - PnL ≥ profit_target_pct  → sell (profit target hit)
   *   - PnL ≤ stop_loss_pct      → sell (stop-loss hit)
   *   - Otherwise                → return `{ success: false, reason: 'thresholds not met' }`
   *
   * Call this whenever the position tracker detects DEX_LAUNCH or wants to
   * re-evaluate a held position.
   */
  async sell(tokenAddress: string): Promise<SellResult> {
    // 1. Verify an open position exists in the DB.
    const position = this.db.getPosition(tokenAddress);
    if (!position || (position.status !== 'open' && position.status !== 'dex_launched')) {
      return { success: false, reason: 'no sellable position in DB' };
    }

    // 2. Get actual on-chain token balance — safer than relying on the
    //    estimated token_amount stored at buy time.
    const tokenAmount = await this.fetchTokenBalance(tokenAddress);
    if (tokenAmount === 0n) {
      return { success: false, reason: 'token balance is zero — already sold or balance not found' };
    }

    // 3. Quote token → WSOL to determine current market price.
    const quote = await this.getQuote(tokenAddress, tokenAmount);
    if (!quote) {
      return { success: false, reason: 'Jupiter: no route found for token' };
    }

    // 4. Calculate PnL.
    const outLamports = Number(quote.outAmount);
    const receivedSol = outLamports / LAMPORTS_PER_SOL;
    const pnlSol = receivedSol - position.amount_sol;
    const pnlPct = (pnlSol / position.amount_sol) * 100;

    logger.info(
      {
        tokenAddress,
        pnlPct: pnlPct.toFixed(2),
        pnlSol: pnlSol.toFixed(6),
        receivedSol: receivedSol.toFixed(6),
        profitTarget: this.cfg.profit_target_pct,
        stopLoss: this.cfg.stop_loss_pct,
      },
      'Sell evaluation',
    );

    // 4.5 – Optional AI sell recommendation.
    //   urgency='immediate' → sell right now, bypassing profit/stop thresholds.
    //   urgency='normal'    → advisory; OR'd with hitProfit so thresholds still rule.
    //   Stop-loss always fires regardless of AI opinion (safety invariant).
    let aiImmediateSell = false;
    let aiNormalSell = false;

    if (this.advisor?.isEnabled) {
      const heldMinutes = (Date.now() - position.created_at) / 60_000;
      // Record price on every tick for velocity calculation (#2).
      // shouldSell is throttled internally; recordPrice is not.
      this.advisor.recordPrice(tokenAddress, pnlPct);
      const aiDecision = await this.advisor.shouldSell({
        tokenAddress,
        pnlPct,
        pnlSol,
        heldMinutes,
      });
      if (aiDecision.sell) {
        if (aiDecision.urgency === 'immediate') {
          aiImmediateSell = true;
        } else {
          aiNormalSell = true;
        }
      }
    }

    // 5. Check thresholds.
    const hitProfit = pnlPct >= this.cfg.profit_target_pct;
    const hitStop = pnlPct <= this.cfg.stop_loss_pct;
    const shouldSell = hitProfit || hitStop || aiImmediateSell || aiNormalSell;

    if (!shouldSell) {
      return {
        success: false,
        reason: `PnL ${pnlPct.toFixed(1)}% not at threshold (target: +${this.cfg.profit_target_pct}%, stop: ${this.cfg.stop_loss_pct}%)`,
      };
    }

    const trigger: SellTrigger = hitStop
      ? 'stop_loss'
      : hitProfit
        ? 'profit_target'
        : 'ai_early';

    // 6. Execute the swap with retry — each attempt gets a fresh Jupiter tx
    //    (fresh blockhash) and the next RPC endpoint from the pool.
    const signature = await this.executeWithRetry(tokenAddress, tokenAmount);
    if (!signature) {
      return { success: false, reason: `sell failed after ${this.cfg.buy_retry_count} attempt(s)` };
    }

    // 7. Persist results to DB.
    const sellPriceLamports = Math.round((outLamports * 1_000_000) / Number(tokenAmount));
    this.record(tokenAddress, position, sellPriceLamports, pnlSol, pnlPct, signature, trigger);

    logger.info(
      { tokenAddress, signature, trigger, pnlPct: pnlPct.toFixed(2), pnlSol: pnlSol.toFixed(6) },
      'Sell executed successfully',
    );

    return { success: true, signature, pnlSol, pnlPct, trigger };
  }

  // ---------------------------------------------------------------------------
  // Private — quote
  // ---------------------------------------------------------------------------

  private async getQuote(tokenAddress: string, tokenAmount: bigint): Promise<QuoteResponse | null> {
    try {
      const quote = await this.jupApi.quoteGet({
        inputMint: tokenAddress,
        outputMint: WSOL_MINT,
        amount: Number(tokenAmount),
        slippageBps: this.cfg.slippage_bps,
        onlyDirectRoutes: false,
        restrictIntermediateTokens: true,
      });

      if (!quote?.routePlan?.length) return null;
      return quote;
    } catch (err) {
      logger.warn({ tokenAddress, err }, 'Seller: failed to get Jupiter quote');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — swap execution with retry
  // ---------------------------------------------------------------------------

  private async executeWithRetry(tokenAddress: string, tokenAmount: bigint): Promise<string | null> {
    for (let attempt = 1; attempt <= this.cfg.buy_retry_count; attempt++) {
      const { connection, url } = this.rpcManager.getConnectionWithUrl();
      const t0 = Date.now();

      try {
        // Re-quote on each attempt: price may shift and we want a fresh blockhash
        // baked into the Jupiter-provided swap transaction.
        const quote = await this.getQuote(tokenAddress, tokenAmount);
        if (!quote) {
          logger.warn({ tokenAddress, attempt }, 'Seller: no quote on retry attempt');
          continue;
        }

        // Fetch swap transaction bytes from Jupiter.
        const swapResp = await this.jupApi.swapPost({
          swapRequest: {
            quoteResponse: quote,
            userPublicKey: this.wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: {
              priorityLevelWithMaxLamports: {
                priorityLevel: 'medium',
                maxLamports: 5_000_000, // cap at 0.005 SOL
              },
            },
          },
        });

        // Deserialize, sign, send.
        const txBytes = Buffer.from(swapResp.swapTransaction, 'base64');
        const tx = VersionedTransaction.deserialize(txBytes);
        tx.sign([this.wallet]);

        const { blockhash } = await connection.getLatestBlockhash('confirmed');

        const signature = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 0,
        });

        await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight: swapResp.lastValidBlockHeight },
          'confirmed',
        );

        this.rpcManager.recordSuccess(url, Date.now() - t0);
        return signature;
      } catch (err) {
        this.rpcManager.recordError(url);
        logger.warn({ tokenAddress, attempt, err }, 'Seller: swap attempt failed');
      }

      if (attempt < this.cfg.buy_retry_count) {
        await sleep(300 * attempt);
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Private — balance fetch
  // ---------------------------------------------------------------------------

  /**
   * Returns the actual on-chain token balance (base units) for the bot's wallet.
   * Uses `getParsedTokenAccountsByOwner` to avoid depending on `@solana/spl-token`.
   */
  private async fetchTokenBalance(tokenAddress: string): Promise<bigint> {
    try {
      const connection = this.rpcManager.getConnection();
      const accounts = await connection.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: new PublicKey(tokenAddress) },
        'confirmed',
      );

      const parsed = accounts.value[0]?.account.data;
      if (parsed && 'parsed' in parsed) {
        const amount = parsed.parsed?.info?.tokenAmount?.amount as string | undefined;
        if (amount) return BigInt(amount);
      }
    } catch (err) {
      logger.warn({ tokenAddress, err }, 'Seller: failed to fetch token balance');
    }
    return 0n;
  }

  // ---------------------------------------------------------------------------
  // Private — DB persistence
  // ---------------------------------------------------------------------------

  private record(
    tokenAddress: string,
    position: ReturnType<DatabaseClient['getPosition']>,
    sellPriceLamports: number,
    pnlSol: number,
    pnlPct: number,
    signature: string,
    trigger: SellTrigger,
  ): void {
    if (!position) return;

    // 'ai_early' maps to profit_target when PnL is positive, stop_loss otherwise.
    const positionStatus: PositionStatus =
      trigger === 'profit_target'
        ? 'profit_target'
        : trigger === 'stop_loss'
          ? 'stop_loss'
          : pnlPct > 0
            ? 'profit_target'
            : 'stop_loss';

    try {
      const trade = this.db.getTradeByToken(tokenAddress);
      if (trade) {
        this.db.updateTradeSold({
          id: trade.id,
          sell_price_lamports: sellPriceLamports,
          pnl_sol: pnlSol,
          pnl_pct: pnlPct,
          sell_tx: signature,
          status: 'closed',
        });
      }
      this.db.updatePositionStatus(tokenAddress, positionStatus);
    } catch (err) {
      logger.error(
        { tokenAddress, signature, err },
        'Seller: DB update failed — trade executed on-chain but not persisted',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function loadKeypair(filePath: string): Keypair {
  const expanded = filePath.startsWith('~') ? filePath.replace('~', homedir()) : filePath;
  const bytes = JSON.parse(readFileSync(expanded, 'utf8')) as number[];
  return Keypair.fromSecretKey(new Uint8Array(bytes));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
