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

/**
 * Resolve the thread root to inject as *implicit* context, or `undefined`
 * when there's nothing to inject.
 *
 * Distinct from {@link replyQuoteTargetForMessage}, which resolves what the
 * user *intentionally* quoted. A topic's root is structure — but when the
 * topic was opened by an alert card and the user simply @-mentions the bot
 * inside it, that structure IS the context the user means. Callers inject it
 * once per session and let the agent session carry it from there.
 *
 * Returns `undefined` when the message isn't in a thread, has no root, or IS
 * the root itself (its content is already in the batch).
 */
export function implicitThreadRootTarget(
  msg: NormalizedMessage,
): string | undefined {
  if (!msg.threadId || !msg.rootId) return undefined;
  if (msg.rootId === msg.messageId) return undefined;
  return msg.rootId;
}
