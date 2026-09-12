import type { LarkChannel } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import { sendManagedCard } from '../../../src/card/managed';

describe('sendManagedCard reply-target fallback', () => {
  it('resends without replyTo when the replied-to message was withdrawn', async () => {
    const sendCalls: Array<{ opts: unknown }> = [];
    const channel = {
      createCard: async () => ({ cardId: 'card_1' }),
      send: async (_recipient: string, _content: unknown, opts?: unknown) => {
        sendCalls.push({ opts });
        if ((opts as { replyTo?: string } | undefined)?.replyTo) {
          throw withdrawnError();
        }
        return { messageId: 'om_sent' };
      },
    } as unknown as LarkChannel;

    const result = await sendManagedCard(channel, 'oc_chat', { type: 'card' }, {
      replyTo: 'om_withdrawn',
      replyInThread: true,
    });

    expect(result.messageId).toBe('om_sent');
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]?.opts).toEqual({ replyInThread: true });
  });

  it('propagates send failures that are not a dead reply target', async () => {
    const channel = {
      createCard: async () => ({ cardId: 'card_1' }),
      send: async () => {
        throw new Error('boom');
      },
    } as unknown as LarkChannel;

    await expect(
      sendManagedCard(channel, 'oc_chat', { type: 'card' }, { replyTo: 'om_alive' }),
    ).rejects.toThrow('boom');
  });
});

function withdrawnError(): Error {
  const err = new Error('The message was withdrawn.') as Error & { cause?: unknown };
  err.cause = { response: { status: 400, data: { code: 230011, msg: 'The message was withdrawn.' } } };
  return err;
}
