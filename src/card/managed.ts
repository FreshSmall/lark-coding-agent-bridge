import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

interface ManagedEntry {
  cardId: string;
  sequence: number;
}

// Module-local because state is per-process. Lost on restart, which is fine —
// a new run of /account will mint a fresh card.
const byMessageId = new Map<string, ManagedEntry>();

export interface ManagedCardSendResult {
  messageId: string;
  cardId: string;
}

/**
 * Create a CardKit 2.0 card entity and send a message that references it.
 * Returns both ids; we keep them in a module-local map so future cardAction
 * events can update the card by its messageId.
 *
 * `recipientId` is routed by its id prefix (channel.send infers
 * `receive_id_type`): `oc_*` → chat, `ou_*` → direct message to that user
 * (Lark auto-resolves the p2p chat). If `replyTo` is provided, the card
 * threads under that message — only meaningful for chat sends.
 */
export async function sendManagedCard(
  channel: LarkChannel,
  recipientId: string,
  card: object,
  opts: { replyTo?: string; replyInThread?: boolean } = {},
): Promise<ManagedCardSendResult> {
  const { cardId } = await channel.createCard(card);
  const sendOpts =
    opts.replyTo || opts.replyInThread
      ? {
          ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
          ...(opts.replyInThread ? { replyInThread: true } : {}),
        }
      : undefined;
  let messageId: string;
  try {
    ({ messageId } = await channel.send(recipientId, { cardId }, sendOpts));
  } catch (err) {
    if (!sendOpts?.replyTo || !isDeadReplyTarget(err)) throw err;
    // The message we were replying to is gone (the user recalled it). Reply
    // threading is cosmetic — never let it kill the whole run. Resend
    // top-level, the same fallback the SDK applies for its own revoked-target
    // codes (it just doesn't recognise 230011).
    log.warn('card', 'reply-target-gone', { replyTo: sendOpts.replyTo });
    const retryOpts = sendOpts.replyInThread ? { replyInThread: true } : undefined;
    ({ messageId } = await channel.send(recipientId, { cardId }, retryOpts));
  }
  byMessageId.set(messageId, { cardId, sequence: 0 });
  return { messageId, cardId };
}

/**
 * Feishu codes that all mean "the message you are replying to no longer
 * exists": 230011 recalled, 230017 / 230020 target revoked.
 */
const DEAD_REPLY_TARGET_CODES = new Set([230011, 230017, 230020]);

function isDeadReplyTarget(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const e = current as {
      code?: unknown;
      data?: { code?: unknown };
      response?: { data?: { code?: unknown } };
      cause?: unknown;
    };
    const code = e.response?.data?.code ?? e.data?.code ?? e.code;
    if (typeof code === 'number' && DEAD_REPLY_TARGET_CODES.has(code)) return true;
    current = e.cause;
  }
  return false;
}

/**
 * Update a managed card identified by the messageId of the message that
 * carries it. Auto-increments and tracks the per-card sequence so updates
 * can't be reordered or rejected by the cardkit server.
 */
export async function updateManagedCard(
  channel: LarkChannel,
  messageId: string,
  card: object,
): Promise<void> {
  const entry = byMessageId.get(messageId);
  if (!entry) {
    throw new Error(`no managed card registered for message ${messageId}`);
  }
  entry.sequence += 1;
  try {
    await channel.updateCardById(entry.cardId, card, entry.sequence);
  } catch (err) {
    log.fail('card', err, { step: 'managed-update', cardId: entry.cardId, seq: entry.sequence });
    throw err;
  }
}

/** True iff we have the card_id mapping for this messageId. */
export function isManaged(messageId: string): boolean {
  return byMessageId.has(messageId);
}

/** Drop the mapping; call after the card is recalled or the flow ends. */
export function forgetManagedCard(messageId: string): void {
  byMessageId.delete(messageId);
}
