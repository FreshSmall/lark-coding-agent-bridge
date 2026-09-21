import { describe, expect, it } from 'vitest';
import { extractCardText } from '../../../src/bot/interactive-card.js';

describe('extractCardText', () => {
  it('pulls the content out of a markdown element', () => {
    const card = JSON.stringify({
      schema: '2.0',
      body: {
        elements: [{ tag: 'markdown', content: '**告警标题**', element_id: '_2' }],
      },
    });

    expect(extractCardText(card)).toBe('**告警标题**');
  });

  it('descends into column_set / columns / elements', () => {
    const card = JSON.stringify({
      body: {
        elements: [
          { tag: 'markdown', content: '第一行' },
          {
            tag: 'column_set',
            columns: [
              { tag: 'column', elements: [{ tag: 'markdown', content: '嵌套内容' }] },
            ],
          },
        ],
      },
    });

    expect(extractCardText(card)).toBe('第一行\n嵌套内容');
  });

  it('renders a button as its label plus url', () => {
    const card = JSON.stringify({
      body: {
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '告警详情' },
            url: 'https://alert.example.com/d/1',
          },
        ],
      },
    });

    expect(extractCardText(card)).toBe('[告警详情](https://alert.example.com/d/1)');
  });

  it('keeps a button label when it carries no url', () => {
    const card = JSON.stringify({
      body: { elements: [{ tag: 'button', text: { tag: 'plain_text', content: '确认' } }] },
    });

    expect(extractCardText(card)).toBe('确认');
  });

  it('drops layout and identifier noise', () => {
    const card = JSON.stringify({
      body: {
        direction: 'vertical',
        padding: '12px 12px 12px 12px',
        elements: [
          {
            tag: 'markdown',
            content: '正文',
            element_id: '_2',
            text_align: 'center',
            background_style: 'grey-100',
          },
        ],
      },
    });

    expect(extractCardText(card)).toBe('正文');
  });

  it('ignores config.summary, which just repeats the header', () => {
    const card = JSON.stringify({
      body: { elements: [{ tag: 'markdown', content: '正文' }] },
      config: { summary: { content: '正文' }, streaming_mode: false },
      card_link: { url: '' },
    });

    expect(extractCardText(card)).toBe('正文');
  });

  it('includes the header title when present', () => {
    const card = JSON.stringify({
      header: { title: { tag: 'plain_text', content: '服务告警' } },
      body: { elements: [{ tag: 'markdown', content: '正文' }] },
    });

    expect(extractCardText(card)).toBe('服务告警\n正文');
  });

  // Alert platforms often encode the whole alert body into a "ask AI about
  // this" link. That payload is already in the card text, in a harder-to-read
  // percent-encoded form, and the agent has no use for the href itself.
  it('drops an overlong button url but keeps its label', () => {
    const long = `https://ai.example.com/ask?message=${'%E5%91%8A'.repeat(60)}`;
    expect(long.length).toBeGreaterThan(300);
    const card = JSON.stringify({
      body: {
        elements: [
          { tag: 'button', text: { content: 'AI快速排查' }, url: long },
          { tag: 'button', text: { content: 'trace详情' }, url: 'https://t.example.com/x?traceId=abc' },
        ],
      },
    });

    expect(extractCardText(card)).toBe(
      'AI快速排查\n[trace详情](https://t.example.com/x?traceId=abc)',
    );
  });

  it('returns undefined for content that is not a card', () => {
    expect(extractCardText('not json at all')).toBeUndefined();
    expect(extractCardText(JSON.stringify({ text: 'plain message' }))).toBeUndefined();
    expect(extractCardText(undefined)).toBeUndefined();
  });

  it('unwraps a v2 card nested under user_dsl', () => {
    const inner = JSON.stringify({
      body: { elements: [{ tag: 'markdown', content: '真实内容' }] },
    });
    const card = JSON.stringify({
      elements: [{ tag: 'div', text: { content: '请升级至最新版本客户端' } }],
      user_dsl: inner,
    });

    expect(extractCardText(card)).toBe('真实内容');
  });

  it('falls back to v1 elements when there is no body', () => {
    const card = JSON.stringify({
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'v1 卡片内容' } }],
    });

    expect(extractCardText(card)).toBe('v1 卡片内容');
  });
});
