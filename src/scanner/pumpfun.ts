import { EventEmitter } from 'events';
import { Connection, Keypair } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import type { CreateEvent, CompleteEvent } from 'pumpdotfun-sdk';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

export interface NewTokenPayload {
  /** Mint address (base58). */
  mintAddress: string;
  name: string;
  symbol: string;
  /** Bonding curve program account (base58). */
  bondingCurveAddress: string;
  /** Creator wallet (base58). */
  creator: string;
  /** Unix ms when the event was received locally. */
  timestamp: number;
}

export interface TokenCompletePayload {
  /** Mint address (base58). */
  mintAddress: string;
  /** Bonding curve program account (base58). */
  bondingCurveAddress: string;
  /** Unix ms (converted from on-chain seconds). */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// PumpFunScanner
// ---------------------------------------------------------------------------

/**
 * Listens for pump.fun program events via Anchor's on-chain event system
 * (internally backed by an RPC `logsSubscribe` WebSocket).
 *
 * Emitted events:
 *   - `'new_token'`      → NewTokenPayload   (createEvent: token launched)
 *   - `'token_complete'` → TokenCompletePayload (completeEvent: bonding curve full)
 */
export class PumpFunScanner extends EventEmitter {
  private readonly sdk: PumpFunSDK;
  private createListenerId: number | null = null;
  private completeListenerId: number | null = null;

  /**
   * @param connection A Solana Connection with a wss:// endpoint for WebSocket events.
   *   Pass the result of `rpcManager.getConnection()`.
   */
  constructor(connection: Connection) {
    super();

    // A read-only wallet is sufficient — we only subscribe to events and read
    // accounts; no transactions are signed by the scanner.
    const wallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });

    this.sdk = new PumpFunSDK(provider);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Exposes the underlying SDK so other components (e.g. BondingCurveTracker)
   * can share the same initialized instance.
   */
  get pumpSdk(): PumpFunSDK {
    return this.sdk;
  }

  start(): void {
    this.createListenerId = this.sdk.addEventListener(
      'createEvent',
      (event: CreateEvent, _slot: number, _sig: string) => {
        const payload: NewTokenPayload = {
          mintAddress: event.mint.toBase58(),
          name: event.name,
          symbol: event.symbol,
          bondingCurveAddress: event.bondingCurve.toBase58(),
          creator: event.user.toBase58(),
          timestamp: Date.now(),
        };

        logger.info(
          { mintAddress: payload.mintAddress, name: payload.name, symbol: payload.symbol },
          'New pump.fun token detected',
        );
        this.emit('new_token', payload);
      },
    );

    this.completeListenerId = this.sdk.addEventListener(
      'completeEvent',
      (event: CompleteEvent, _slot: number, _sig: string) => {
        const payload: TokenCompletePayload = {
          mintAddress: event.mint.toBase58(),
          bondingCurveAddress: event.bondingCurve.toBase58(),
          // On-chain timestamp is in seconds; convert to ms.
          timestamp: event.timestamp * 1_000,
        };

        logger.info(
          { mintAddress: payload.mintAddress },
          'Pump.fun bonding curve complete — token graduating to DEX',
        );
        this.emit('token_complete', payload);
      },
    );

    logger.info('PumpFunScanner started (createEvent + completeEvent)');
  }

  stop(): void {
    if (this.createListenerId !== null) {
      this.sdk.removeEventListener(this.createListenerId);
      this.createListenerId = null;
    }
    if (this.completeListenerId !== null) {
      this.sdk.removeEventListener(this.completeListenerId);
      this.completeListenerId = null;
    }
    logger.info('PumpFunScanner stopped');
  }
}
