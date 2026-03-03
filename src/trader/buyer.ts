import { readFileSync } from 'fs';
import { homedir } from 'os';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import type { Signal } from '../signals/types.js';
import type { RpcManager } from '../rpc/manager.js';
import type { RiskManager } from './risk.js';
import type { BondingCurveTracker } from '../scanner/bonding.js';
import type { DatabaseClient } from '../db/client.js';
import type { TradingConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Compute priority fees.  A modest unit limit + small tip keeps us competitive
 * without burning excessive SOL.  Configurable via env in a future phase.
 */
const PRIORITY_FEES = { unitLimit: 300_000, unitPrice: 50_000 } as const;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type BuyResult =
  | {
      success: true;
      signature: string;
      positionSizeSol: number;
      /** Approximate token units received (6-decimal base units). */
      tokenAmount: number;
    }
  | { success: false; reason: string };

// ---------------------------------------------------------------------------
// Buyer
// ---------------------------------------------------------------------------

export class Buyer {
  private readonly wallet: Keypair;
  private readonly rpcManager: RpcManager;
  private readonly riskManager: RiskManager;
  private readonly bondingTracker: BondingCurveTracker;
  private readonly db: DatabaseClient;
  private readonly cfg: TradingConfig;

  constructor(
    cfg: TradingConfig,
    rpcManager: RpcManager,
    riskManager: RiskManager,
    bondingTracker: BondingCurveTracker,
    db: DatabaseClient,
  ) {
    this.cfg = cfg;
    this.rpcManager = rpcManager;
    this.riskManager = riskManager;
    this.bondingTracker = bondingTracker;
    this.db = db;
    this.wallet = loadKeypair(cfg.wallet_keypair_path);
    logger.info({ pubkey: this.wallet.publicKey.toBase58() }, 'Buyer wallet loaded');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Attempt to buy a token after a qualified signal fires.
   *
   * Flow:
   *   1. Fetch current bonding curve state.
   *   2. Run all risk checks (confidence, bonding %, positions, daily loss).
   *   3. Send the buy transaction, retrying up to `buy_retry_count` times on
   *      failure, each time using the next RPC endpoint from the manager.
   *   4. Record the trade + position in the DB on success.
   */
  async buy(signal: Signal): Promise<BuyResult> {
    const { tokenAddress } = signal;

    // 1. Fetch bonding curve — we need current % and reserves for price calc.
    const curve = await this.bondingTracker.fetch(tokenAddress);
    if (!curve) {
      return { success: false, reason: 'bonding curve account not found — token may not be on pump.fun' };
    }
    if (curve.complete) {
      return { success: false, reason: 'bonding curve already complete — token graduated before buy' };
    }

    // 2. Risk check.
    const risk = this.riskManager.check({
      tokenAddress,
      bondingPct: curve.percentComplete,
      signalConfidence: signal.confidence,
    });
    if (!risk.allowed) {
      return { success: false, reason: risk.reason ?? 'risk check denied' };
    }

    const buyLamports = BigInt(Math.round(risk.positionSizeSol * Number(LAMPORTS_PER_SOL)));
    const mint = new PublicKey(tokenAddress);

    // 3. Retry loop — each attempt uses a fresh connection from the RPC pool.
    for (let attempt = 1; attempt <= this.cfg.buy_retry_count; attempt++) {
      const { connection, url } = this.rpcManager.getConnectionWithUrl();
      const sdk = this.makeSdk(connection);
      const t0 = Date.now();

      try {
        const result = await sdk.buy(
          this.wallet,
          mint,
          buyLamports,
          BigInt(this.cfg.slippage_bps),
          PRIORITY_FEES,
          'confirmed',
          'confirmed',
        );

        if (result.success && result.signature) {
          this.rpcManager.recordSuccess(url, Date.now() - t0);

          // Estimate tokens received via constant-product AMM formula (pre-fee):
          //   tokens_out ≈ virtualTokenReserves * buyLamports
          //              / (virtualSolReserves + buyLamports)
          const tokenAmount = Number(
            curve.virtualTokenReserves * buyLamports /
            (curve.virtualSolReserves + buyLamports),
          );

          // Entry price: lamports per full token (1 token = 1_000_000 base units).
          const entryPriceLamports = Number(
            curve.virtualSolReserves * 1_000_000n / curve.virtualTokenReserves,
          );

          this.record(signal, risk.positionSizeSol, entryPriceLamports, tokenAmount, result.signature);

          logger.info(
            {
              tokenAddress,
              ticker: signal.ticker,
              signature: result.signature,
              positionSizeSol: risk.positionSizeSol,
              entryPriceLamports,
              tokenAmount,
              attempt,
            },
            'Buy executed successfully',
          );

          return {
            success: true,
            signature: result.signature,
            positionSizeSol: risk.positionSizeSol,
            tokenAmount,
          };
        }

        // SDK returned success=false (e.g. slippage exceeded, simulation failed).
        this.rpcManager.recordError(url);
        logger.warn(
          { tokenAddress, attempt, error: result.error },
          'Buy attempt rejected by program',
        );
      } catch (err) {
        this.rpcManager.recordError(url);
        logger.warn({ tokenAddress, attempt, err }, 'Buy attempt threw');
      }

      // Brief backoff before the next attempt (skip on last attempt).
      if (attempt < this.cfg.buy_retry_count) {
        await sleep(300 * attempt);
      }
    }

    return {
      success: false,
      reason: `buy failed after ${this.cfg.buy_retry_count} attempt(s)`,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Create a signing `PumpFunSDK` bound to the given `Connection`.
   * Called once per buy attempt so each retry gets a fresh RPC endpoint.
   */
  private makeSdk(connection: import('@solana/web3.js').Connection): PumpFunSDK {
    const wallet = new Wallet(this.wallet);
    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    return new PumpFunSDK(provider);
  }

  /** Write trade + position rows to the database. */
  private record(
    signal: Signal,
    amountSol: number,
    entryPriceLamports: number,
    tokenAmount: number,
    signature: string,
  ): void {
    try {
      const tradeId = this.db.insertTrade({
        token_address: signal.tokenAddress,
        buy_price_lamports: entryPriceLamports,
        amount_sol: amountSol,
        buy_tx: signature,
      });

      this.db.insertPosition({
        token_address: signal.tokenAddress,
        entry_price_lamports: entryPriceLamports,
        amount_sol: amountSol,
        token_amount: tokenAmount,
        trade_id: tradeId,
      });
    } catch (err) {
      // DB write failure is non-fatal — the on-chain trade already executed.
      // Log the error; the orchestrator can reconcile via chain queries later.
      logger.error(
        { tokenAddress: signal.tokenAddress, signature, err },
        'Failed to record buy in DB — trade executed on-chain but not persisted',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Load a Solana keypair from a JSON file (array of 64 bytes).
 * Handles `~` expansion for home-directory paths.
 */
function loadKeypair(filePath: string): Keypair {
  const expanded = filePath.startsWith('~')
    ? filePath.replace('~', homedir())
    : filePath;
  const bytes = JSON.parse(readFileSync(expanded, 'utf8')) as number[];
  return Keypair.fromSecretKey(new Uint8Array(bytes));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
