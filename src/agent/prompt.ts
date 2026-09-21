export type BridgePromptSource = 'im' | 'card' | 'comment';

export interface BridgePromptMention {
  openId?: string;
  name?: string;
  isBot?: boolean;
}

export interface BridgePromptContext {
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  /** Whether the sender is a human user or another bot ('app' sender). */
  senderType?: 'user' | 'bot';
  /** The bridge bot's own open_id — "this id is you" for self-identification. */
  botOpenId?: string;
  /** Accounts @-mentioned in the triggering message(s), deduped across the batch. */
  mentions?: BridgePromptMention[];
  threadId?: string;
  messageIds?: string[];
  source: BridgePromptSource;
}

export interface BridgePromptQuotedMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  createdAt?: string;
  rawContentType: string;
  content: string;
}

/**
 * The thread the triggering message sits in. Distinct from
 * {@link BridgePromptQuotedMessage}: a quote is what the user pointed at, a
 * thread is the surroundings they're speaking in. `total` / `omitted` let the
 * agent tell "that's all of it" from "there's more I wasn't given".
 */
export interface BridgePromptThreadContext {
  threadId: string;
  total: number;
  omitted: number;
  messages: BridgePromptThreadMessage[];
  /** Set when the thread couldn't be read; `messages` is then empty. */
  error?: string;
}

export interface BridgePromptThreadMessage {
  messageId: string;
  position: number;
  /** The message the thread hangs off — usually what the thread is about. */
  isHost: boolean;
  senderId: string;
  senderName?: string;
  senderType: 'user' | 'bot';
  createdAt: string;
  contentType: string;
  content: string;
  truncatedChars?: number;
}

export interface BridgePromptInteractiveCard {
  messageId?: string;
  content: unknown;
}

export interface BridgePromptComment {
  commentScopeId: string;
  isWholeDocument: boolean;
  docsLink?: string;
  question: string;
  quote?: string;
}

export interface BridgePromptAttachment {
  path: string;
  kind: string;
  hash?: string;
  size?: number;
  mime?: string;
  sourceMessageId?: string;
  requiredness?: 'required' | 'optional';
  decision?: 'accepted' | 'rejected' | 'skipped';
  rejectionReason?: string;
}

export interface BuildAgentPromptInput {
  context: BridgePromptContext;
  instructions?: string[];
  userInput: string;
  threadContext?: BridgePromptThreadContext;
  quotedMessages?: BridgePromptQuotedMessage[];
  interactiveCards?: BridgePromptInteractiveCard[];
  comment?: BridgePromptComment;
  attachments?: BridgePromptAttachment[];
}

export function buildAgentPrompt(input: BuildAgentPromptInput): string {
  const sections = [
    promptSection('bridge_context', input.context),
    input.instructions && input.instructions.length > 0
      ? promptSection('bridge_instructions', input.instructions)
      : undefined,
    input.threadContext
      ? promptSection('thread_context', input.threadContext)
      : undefined,
    input.quotedMessages && input.quotedMessages.length > 0
      ? promptSection('quoted_messages', input.quotedMessages)
      : undefined,
    input.interactiveCards && input.interactiveCards.length > 0
      ? promptSection('interactive_cards', input.interactiveCards)
      : undefined,
    input.comment ? promptSection('comment_context', input.comment) : undefined,
    promptSection('user_input', {
      text: input.userInput,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    }),
  ];

  return sections.filter(Boolean).join('\n\n');
}

export function promptSection(tag: string, value: unknown): string {
  return `<${tag}>\n${safeJsonStringify(value)}\n</${tag}>`;
}

export function safeJsonStringify(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
