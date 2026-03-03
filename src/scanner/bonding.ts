import { PublicKey } from '@solana/web3.js';
import type { PumpFunSDK } from 'pumpdotfun-sdk';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Pump.fun graduation threshold: the bonding curve completes once
 * realSolReserves reaches ~85 SOL (85_000_000_000 lamports).
 *
 * This is a well-known mainnet constant; adjust if the protocol changes.
 */
const GRADUATION_LAMPORTS = 85_000_000_000n;

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BondingCurveInfo {
  /** Mint address (base58). */
  mintAddress: string;
  /**
   * How far along the bonding curve is toward graduation (0–100).
   * Capped at 100; equals 100 when `complete === true`.
   */
  percentComplete: number;
  /** Raw real SOL reserves in lamports (actual SOL raised by buyers). */
  realSolReserves: bigint;
  /** Virtual SOL reserves in lamports (includes initial virtual liquidity). */
  virtualSolReserves: bigint;
  /** Virtual token reserves in base units (6 decimals). Used for price calculation. */
  virtualTokenReserves: bigint;
  /**
   * Market cap expressed in SOL, calculated by the SDK's constant-product
   * formula: `tokenTotalSupply / virtualTokenReserves * virtualSolReserves`.
   */
  marketCapSol: number;
  /** True once the bonding curve has reached its graduation target. */
  complete: boolean;
}

// ---------------------------------------------------------------------------
// BondingCurveTracker
// ---------------------------------------------------------------------------

/**
 * Fetches and interprets bonding curve account data for a pump.fun token.
 *
 * Constructed with a shared `PumpFunSDK` instance (from `PumpFunScanner.pumpSdk`)
 * to avoid duplicating the Anchor provider / program setup.
 */
export class BondingCurveTracker {
  private readonly sdk: PumpFunSDK;

  constructor(sdk: PumpFunSDK) {
    this.sdk = sdk;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch the current bonding curve state for `mintAddress`.
   *
   * Returns `null` when:
   *   - The address is not a valid Solana public key.
   *   - The bonding curve account does not exist (token may not be on pump.fun).
   *   - The RPC call fails.
   */
  async fetch(mintAddress: string): Promise<BondingCurveInfo | null> {
    let mint: PublicKey;
    try {
      mint = new PublicKey(mintAddress);
    } catch {
      logger.warn({ mintAddress }, 'BondingCurveTracker: invalid mint address');
      return null;
    }

    try {
      const curve = await this.sdk.getBondingCurveAccount(mint, 'confirmed');
      if (!curve) {
        logger.debug({ mintAddress }, 'Bonding curve account not found');
        return null;
      }

      const percentComplete = curve.complete
        ? 100
        : Math.min(
            100,
            Number((curve.realSolReserves * 10_000n) / GRADUATION_LAMPORTS) / 100,
          );

      const marketCapSol =
        Number(curve.getMarketCapSOL()) / Number(LAMPORTS_PER_SOL);

      logger.debug(
        {
          mintAddress,
          percentComplete: percentComplete.toFixed(1),
          marketCapSol: marketCapSol.toFixed(2),
          complete: curve.complete,
        },
        'Bonding curve fetched',
      );

      return {
        mintAddress,
        percentComplete,
        realSolReserves: curve.realSolReserves,
        virtualSolReserves: curve.virtualSolReserves,
        virtualTokenReserves: curve.virtualTokenReserves,
        marketCapSol,
        complete: curve.complete,
      };
    } catch (err) {
      logger.warn({ mintAddress, err }, 'BondingCurveTracker: RPC error');
      return null;
    }
  }

  /**
   * Convenience method: returns `true` when the bonding curve has completed
   * (i.e. the token has graduated and a Raydium pool will be created shortly).
   */
  async isComplete(mintAddress: string): Promise<boolean> {
    const info = await this.fetch(mintAddress);
    return info?.complete ?? false;
  }
}
