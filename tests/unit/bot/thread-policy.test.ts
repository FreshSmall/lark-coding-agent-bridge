import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import {
  shouldReplyInThread,
  replyQuoteTargetForMessage,
  implicitThreadRootTarget,
} from '../../../src/bot/thread-policy.js';

function msg(partial: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    messageId: 'm1',
    chatId: 'c1',
    chatType: 'group',
    senderId: 's1',
    content: '',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 0,
    ...partial,
  } as NormalizedMessage;
}

describe('shouldReplyInThread', () => {
  it('topic group threads only when a threadId exists', () => {
    expect(shouldReplyInThread('topic', 'omt_1', true)).toBe(true);
    expect(shouldReplyInThread('topic', undefined, true)).toBe(false);
  });

  it('regular group follows the toggle', () => {
    expect(shouldReplyInThread('group', undefined, true)).toBe(true);
    expect(shouldReplyInThread('group', undefined, false)).toBe(false);
  });

  it('p2p never threads', () => {
    expect(shouldReplyInThread('p2p', undefined, true)).toBe(false);
  });
});

describe('replyQuoteTargetForMessage', () => {
  it('returns undefined when there is no reply target', () => {
    expect(replyQuoteTargetForMessage(msg({}))).toBeUndefined();
  });

  it('treats a reply to the thread root as structure, not a quote', () => {
    expect(
      replyQuoteTargetForMessage(
        msg({ replyToMessageId: 'root1', threadId: 'omt_1', rootId: 'root1' }),
      ),
    ).toBeUndefined();
  });

  it('returns an explicit quote to a non-root message', () => {
    expect(
      replyQuoteTargetForMessage(
        msg({ replyToMessageId: 'other', threadId: 'omt_1', rootId: 'root1' }),
      ),
    ).toBe('other');
  });

  it('returns the quote target for a plain (non-threaded) reply', () => {
    expect(replyQuoteTargetForMessage(msg({ replyToMessageId: 'q1' }))).toBe('q1');
  });
});

describe('implicitThreadRootTarget', () => {
  it('returns the root for an in-thread message', () => {
    expect(
      implicitThreadRootTarget(
        msg({ messageId: 'm2', threadId: 'omt_1', rootId: 'root1' }),
      ),
    ).toBe('root1');
  });

  it('returns undefined outside a thread', () => {
    expect(implicitThreadRootTarget(msg({ rootId: 'root1' }))).toBeUndefined();
  });

  it('returns undefined when the message IS the root', () => {
    expect(
      implicitThreadRootTarget(
        msg({ messageId: 'root1', threadId: 'omt_1', rootId: 'root1' }),
      ),
    ).toBeUndefined();
  });

  it('returns undefined when there is no rootId', () => {
    expect(
      implicitThreadRootTarget(msg({ messageId: 'm2', threadId: 'omt_1' })),
    ).toBeUndefined();
  });
});
