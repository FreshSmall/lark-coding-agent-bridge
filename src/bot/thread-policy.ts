import type { NormalizedMessage } from '@larksuite/channel';
import type { ChatMode } from './chat-mode-cache';

/**
 * Decide whether an outbound reply should be threaded (`reply_in_thread`).
 *
 * - topic-mode groups thread only when the triggering message already has a
 *   `threadId` (preserves the prior behavior);
 * - regular groups thread iff the operator-tunable toggle is on;
 * - p2p never threads.
 */
export function shouldReplyInThread(
  mode: ChatMode,
  threadId: string | undefined,
  replyInThreadInGroup: boolean,
): boolean {
  if (mode === 'topic') return Boolean(threadId);
  if (mode === 'group') return replyInThreadInGroup;
  return false;
}

/**
 * Resolve the message a reply should quote, or `undefined` when there's no
 * intentional quote. Feishu thread messages carry `root_id` as the thread
 * anchor even for ordinary in-thread messages (in topic groups AND in regular
 * groups that now carry threads) — that's structure, not a quote, so it's
 * filtered out. Non-threaded messages have no `threadId`, so the filter never
 * triggers for them.
 */
export function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;
  if (msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}
