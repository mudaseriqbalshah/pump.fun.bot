/**
 * Ambient module declarations for telegram (gramjs) sub-path imports.
 *
 * The `telegram` package is CJS with no `exports` field. TypeScript's
 * NodeNext module resolver rejects sub-path imports in that situation.
 *
 * Notes:
 * - `StringSession` is accessed via the `sessions` namespace re-exported from
 *   the main `telegram` entry — no ambient needed for that.
 * - `telegram/events` is declared here with the minimal surface we use.
 *   `NewMessage` is cast to `any` at the `addEventHandler` call site to avoid
 *   reproducing the full internal `EventBuilder` interface here.
 */

declare module 'telegram/events' {
  import type { Api } from 'telegram';

  export class NewMessageEvent {
    message: Api.Message;
  }

  export class NewMessage {
    constructor(params?: {
      chats?: (number | string)[];
      incoming?: boolean;
      outgoing?: boolean;
      pattern?: RegExp;
    });
  }
}
