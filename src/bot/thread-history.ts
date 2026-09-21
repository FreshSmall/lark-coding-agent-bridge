import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';
import { extractCardText } from './interactive-card';

/** Feishu marks the message a thread hangs off with position -1. */
const HOST_POSITION = -1;

export const DEFAULT_MAX_TOTAL_CHARS = 20_000;
export const DEFAULT_MAX_MESSAGE_CHARS = 4_000;

/** Page size for the thread listing. Feishu caps this at 50. */
const PAGE_SIZE = 50;

export interface ThreadMessage {
  messageId: string;
  /** `thread_message_position`; -1 is the host message that opened the thread. */
  position: number;
  isHost: boolean;
  senderId: string;
  senderType: 'user' | 'bot';
  createdAt: string;
  contentType: string;
  content: string;
  /** Characters cut from `content` by the per-message cap, when any. */
  truncatedChars?: number;
}

export interface ThreadContext {
  threadId: string;
  /** How many messages the thread actually holds, before filtering/budget. */
  total: number;
  messages: ThreadMessage[];
  /** Messages dropped by the character budget (filtered-out ones don't count). */
  omitted: number;
  /** Set when the listing failed; `messages` is then empty. */
  error?: string;
}

export interface FetchThreadContextOptions {
  /**
   * Ids identifying the bridge bot itself — both its `app_id` (what
   * `sender.id` carries for app senders) and its `open_id`. Its own replies
   * are already in the agent's session; re-feeding them is pure noise.
   */
  selfIds: readonly string[];
  /** Messages already in the prompt as the triggering batch. */
  excludeMessageIds: readonly string[];
  maxTotalChars?: number;
  maxMessageChars?: number;
}

interface ApiThreadItem {
  message_id?: string;
  msg_type?: string;
  thread_message_position?: string;
  create_time?: string;
  sender?: { id?: string; id_type?: string; sender_type?: string };
  body?: { content?: string };
}

interface MessageListClient {
  im: {
    v1: {
      message: {
        list(req: {
          params: {
            container_id_type: string;
            container_id: string;
            page_size: number;
            page_token?: string;
            card_msg_content_type?: string;
          };
        }): Promise<{
          data?: { items?: ApiThreadItem[]; has_more?: boolean; page_token?: string };
        }>;
      };
    };
  };
}

/**
 * Read a thread's messages and shape them for the prompt.
 *
 * Feishu's `im.v1.message.list` with `container_id_type=thread` returns the
 * whole thread *including* the host message (position -1) — the alert card or
 * broadcast someone opened the thread under. That host is usually the single
 * most important message in the thread, so it is exempt from the character
 * budget; everything else is filled in newest-first and whatever doesn't fit
 * is reported as `omitted` rather than silently dropped.
 *
 * Requires the `im:message.group_msg` scope. Without it the call fails with
 * 230027 and this returns an `error` — never an empty-looking success, since
 * an agent that can't tell "no messages" from "couldn't read messages" will
 * answer confidently from nothing.
 */
export async function fetchThreadContext(
  channel: LarkChannel,
  threadId: string,
  opts: FetchThreadContextOptions,
): Promise<ThreadContext> {
  const maxTotal = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const maxPerMessage = opts.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;

  let items: ApiThreadItem[];
  try {
    const client = channel.rawClient as unknown as MessageListClient;
    const res = await client.im.v1.message.list({
      params: {
        container_id_type: 'thread',
        container_id: threadId,
        page_size: PAGE_SIZE,
        // Without this the API returns the v1 downgrade for CardKit 2.0
        // cards — an "请升级至最新版本客户端" placeholder instead of the
        // card. An alert card goes from 238 bytes of nothing to 3.5 KB of
        // the actual alert.
        card_msg_content_type: 'user_card_content',
      },
    });
    items = res?.data?.items ?? [];
  } catch (err) {
    const message = errorText(err);
    log.warn('thread', 'list-failed', { threadId, err: message });
    return { threadId, total: 0, messages: [], omitted: 0, error: message };
  }

  const total = items.length;
  const selfIds = new Set(opts.selfIds.filter(Boolean));
  const excluded = new Set(opts.excludeMessageIds);

  const candidates = items
    .map((item) => toThreadMessage(item, maxPerMessage))
    .filter((m): m is ThreadMessage => m !== undefined)
    .filter((m) => !selfIds.has(m.senderId) && !excluded.has(m.messageId))
    .sort((a, b) => a.position - b.position);

  const { kept, omitted } = applyBudget(candidates, maxTotal);
  return { threadId, total, messages: kept, omitted };
}

/**
 * Keep the host unconditionally, then spend what's left of the budget on the
 * newest messages — in a long thread the recent turns explain what people are
 * currently asking about, while the middle is usually restating the host.
 * Output stays oldest-first so it reads as a transcript.
 */
function applyBudget(
  messages: ThreadMessage[],
  maxTotalChars: number,
): { kept: ThreadMessage[]; omitted: number } {
  const host = messages.filter((m) => m.isHost);
  const rest = messages.filter((m) => !m.isHost);

  let used = host.reduce((n, m) => n + m.content.length, 0);
  const keptRest: ThreadMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const m = rest[i]!;
    if (used + m.content.length > maxTotalChars) continue;
    used += m.content.length;
    keptRest.push(m);
  }

  const kept = [...host, ...keptRest].sort((a, b) => a.position - b.position);
  return { kept, omitted: rest.length - keptRest.length };
}

function toThreadMessage(
  item: ApiThreadItem,
  maxMessageChars: number,
): ThreadMessage | undefined {
  const messageId = item.message_id;
  if (!messageId) return undefined;

  const contentType = item.msg_type ?? 'text';
  const full = renderContent(contentType, item.body?.content);
  const truncated = full.length > maxMessageChars;
  const position = Number.parseInt(item.thread_message_position ?? '0', 10);

  return {
    messageId,
    position: Number.isFinite(position) ? position : 0,
    isHost: position === HOST_POSITION,
    senderId: item.sender?.id ?? '',
    senderType: item.sender?.sender_type === 'user' ? 'user' : 'bot',
    createdAt: isoTime(item.create_time),
    contentType,
    content: truncated ? full.slice(0, maxMessageChars) : full,
    ...(truncated ? { truncatedChars: full.length - maxMessageChars } : {}),
  };
}

/**
 * Render a message body as plain text. Cards go through `extractCardText`
 * (layout JSON is ~75% of an alert card by weight). Types we can't render
 * are described rather than dropped — the agent should know a message exists
 * even when its content isn't available here.
 */
function renderContent(msgType: string, rawContent: string | undefined): string {
  if (!rawContent) return `[${msgType}]`;

  if (msgType === 'interactive') {
    return extractCardText(rawContent) ?? `[${msgType}]`;
  }

  const parsed = tryParse(rawContent);
  if (!parsed) return rawContent;

  if (msgType === 'text' && typeof parsed.text === 'string') return parsed.text;
  if (msgType === 'post') {
    const flat = flattenPost(parsed);
    if (flat) return flat;
  }
  return `[${msgType}] ${rawContent}`;
}

/** Feishu `post` bodies are `{title, content: [[{tag,text}, ...], ...]}`. */
function flattenPost(parsed: Record<string, unknown>): string | undefined {
  const rows = parsed.content;
  if (!Array.isArray(rows)) return undefined;
  const lines: string[] = [];
  if (typeof parsed.title === 'string' && parsed.title.trim()) lines.push(parsed.title);
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const line = row
      .map((seg) =>
        seg && typeof seg === 'object' && typeof (seg as { text?: unknown }).text === 'string'
          ? (seg as { text: string }).text
          : '',
      )
      .join('');
    if (line.trim()) lines.push(line);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function tryParse(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isoTime(createTime: string | undefined): string {
  const ms = Number.parseInt(createTime ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  const body = (err as { response?: { data?: unknown } })?.response?.data;
  if (body) return JSON.stringify(body).slice(0, 300);
  return String(err);
}
