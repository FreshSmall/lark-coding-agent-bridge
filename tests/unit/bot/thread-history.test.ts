import { describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { fetchThreadContext } from '../../../src/bot/thread-history.js';

interface RawItem {
  message_id: string;
  msg_type: string;
  thread_message_position?: string;
  create_time?: string;
  sender?: { id?: string; id_type?: string; sender_type?: string };
  body?: { content?: string };
}

function textItem(
  id: string,
  position: number,
  text: string,
  senderId = 'ou_human',
): RawItem {
  return {
    message_id: id,
    msg_type: 'text',
    thread_message_position: String(position),
    create_time: '1789972249773',
    sender: { id: senderId, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text }) },
  };
}

function cardItem(id: string, position: number, text: string, senderId: string): RawItem {
  return {
    message_id: id,
    msg_type: 'interactive',
    thread_message_position: String(position),
    create_time: '1789972249773',
    sender: { id: senderId, id_type: 'app_id', sender_type: 'app' },
    body: {
      content: JSON.stringify({ body: { elements: [{ tag: 'markdown', content: text }] } }),
    },
  };
}

function fakeChannel(items: RawItem[] | (() => never)): LarkChannel {
  const list = vi.fn(async () => {
    if (typeof items === 'function') items();
    return { data: { items, has_more: false } };
  });
  return {
    rawClient: { im: { v1: { message: { list } } } },
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
  } as unknown as LarkChannel;
}

const BASE = { selfIds: ['cli_selfbot', 'ou_bot'], excludeMessageIds: [] as string[] };

describe('fetchThreadContext', () => {
  it('returns thread messages in position order with the host flagged', async () => {
    const ch = fakeChannel([
      textItem('om_2', 0, '分析告警'),
      cardItem('om_1', -1, '应用 X 普通预警', 'cli_alertbot'),
    ]);

    const ctx = await fetchThreadContext(ch, 'omt_1', BASE);

    expect(ctx.error).toBeUndefined();
    expect(ctx.messages.map((m) => m.messageId)).toEqual(['om_1', 'om_2']);
    expect(ctx.messages[0]?.isHost).toBe(true);
    expect(ctx.messages[1]?.isHost).toBe(false);
    expect(ctx.total).toBe(2);
    expect(ctx.omitted).toBe(0);
  });

  it('extracts readable text from an interactive card instead of raw JSON', async () => {
    const ch = fakeChannel([cardItem('om_1', -1, '应用 X 普通预警', 'cli_alertbot')]);

    const ctx = await fetchThreadContext(ch, 'omt_1', BASE);

    expect(ctx.messages[0]?.content).toBe('应用 X 普通预警');
  });

  it('unwraps the text field of a plain text message', async () => {
    const ch = fakeChannel([textItem('om_1', 0, '你好')]);

    const ctx = await fetchThreadContext(ch, 'omt_1', BASE);

    expect(ctx.messages[0]?.content).toBe('你好');
  });

  it("drops the bridge bot's own messages", async () => {
    const ch = fakeChannel([
      cardItem('om_1', -1, '告警', 'cli_alertbot'),
      textItem('om_2', 0, '分析', 'ou_human'),
      cardItem('om_3', 1, '我的上一次回复', 'cli_selfbot'),
    ]);

    const ctx = await fetchThreadContext(ch, 'omt_1', BASE);

    expect(ctx.messages.map((m) => m.messageId)).toEqual(['om_1', 'om_2']);
    // total counts what the thread really holds, not what survived filtering
    expect(ctx.total).toBe(3);
  });

  it('keeps other bots — only the bridge bot itself is noise', async () => {
    const ch = fakeChannel([cardItem('om_1', -1, '告警', 'cli_alertbot')]);

    const ctx = await fetchThreadContext(ch, 'omt_1', BASE);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]?.senderType).toBe('bot');
  });

  it('drops messages already present in the current batch', async () => {
    const ch = fakeChannel([
      cardItem('om_1', -1, '告警', 'cli_alertbot'),
      textItem('om_2', 0, '分析告警'),
    ]);

    const ctx = await fetchThreadContext(ch, 'omt_1', {
      ...BASE,
      excludeMessageIds: ['om_2'],
    });

    expect(ctx.messages.map((m) => m.messageId)).toEqual(['om_1']);
  });

  it('truncates an overlong single message and records how much was cut', async () => {
    const ch = fakeChannel([textItem('om_1', 0, 'x'.repeat(500))]);

    const ctx = await fetchThreadContext(ch, 'omt_1', { ...BASE, maxMessageChars: 100 });

    expect(ctx.messages[0]?.content).toHaveLength(100);
    expect(ctx.messages[0]?.truncatedChars).toBe(400);
  });

  it('always keeps the host even when the budget is tiny', async () => {
    const ch = fakeChannel([
      cardItem('om_host', -1, 'H'.repeat(80), 'cli_alertbot'),
      textItem('om_2', 0, 'A'.repeat(80)),
      textItem('om_3', 1, 'B'.repeat(80)),
    ]);

    const ctx = await fetchThreadContext(ch, 'omt_1', { ...BASE, maxTotalChars: 100 });

    expect(ctx.messages.map((m) => m.messageId)).toContain('om_host');
    expect(ctx.omitted).toBeGreaterThan(0);
  });

  it('spends the remaining budget on the newest messages', async () => {
    const ch = fakeChannel([
      cardItem('om_host', -1, 'H'.repeat(50), 'cli_alertbot'),
      textItem('om_old', 0, 'A'.repeat(50)),
      textItem('om_new', 1, 'B'.repeat(50)),
    ]);

    const ctx = await fetchThreadContext(ch, 'omt_1', { ...BASE, maxTotalChars: 120 });

    const ids = ctx.messages.map((m) => m.messageId);
    expect(ids).toContain('om_host');
    expect(ids).toContain('om_new');
    expect(ids).not.toContain('om_old');
    expect(ctx.omitted).toBe(1);
    // still ordered oldest-first for reading
    expect(ids).toEqual(['om_host', 'om_new']);
  });

  // Without card_msg_content_type the API hands back a v1 downgrade whose
  // only text is "请升级至最新版本客户端" — the alert body never arrives.
  it('asks for the original card DSL rather than the v1 downgrade', async () => {
    const ch = fakeChannel([textItem('om_1', 0, 'hi')]);

    await fetchThreadContext(ch, 'omt_1', BASE);

    const list = (ch as unknown as {
      rawClient: { im: { v1: { message: { list: { mock: { calls: unknown[][] } } } } } };
    }).rawClient.im.v1.message.list;
    expect(list.mock.calls[0]?.[0]).toMatchObject({
      params: { card_msg_content_type: 'user_card_content' },
    });
  });

  it('reports a fetch failure instead of pretending the thread is empty', async () => {
    const ch = fakeChannel(() => {
      throw new Error('permission denied');
    });

    const ctx = await fetchThreadContext(ch, 'omt_1', BASE);

    expect(ctx.error).toContain('permission denied');
    expect(ctx.messages).toEqual([]);
  });

  it('describes an unsupported message type rather than dropping it', async () => {
    const ch = fakeChannel([
      {
        message_id: 'om_1',
        msg_type: 'audio',
        thread_message_position: '0',
        sender: { id: 'ou_human', sender_type: 'user' },
        body: { content: '{"file_key":"abc"}' },
      },
    ]);

    const ctx = await fetchThreadContext(ch, 'omt_1', BASE);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]?.contentType).toBe('audio');
    expect(ctx.messages[0]?.content).toContain('audio');
  });
});
