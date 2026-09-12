import { describe, expect, it } from 'vitest';
import { JsonlTurnTranslator } from '../../../src/agent/claude/jsonl-translate.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function run(entries: unknown[]): AgentEvent[] {
  const t = new JsonlTurnTranslator();
  const out: AgentEvent[] = [];
  for (const e of entries) for (const ev of t.translate(e)) out.push(ev);
  return out;
}

describe('JsonlTurnTranslator', () => {
  it('translates assistant text and tool_use blocks', () => {
    expect(run([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      },
    ])).toEqual([
      { type: 'text', delta: 'hi' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  it('drops synthetic placeholder messages the CLI writes after an interrupt', () => {
    // Claude Code injects a `<synthetic>` assistant turn (zero tokens) to keep
    // the transcript alternating after `[Request interrupted by user]` or a
    // `Continue from where you left off.` resume. It is bookkeeping, not a
    // reply — surfacing it puts "No response requested." in the Lark card.
    expect(run([
      {
        type: 'assistant',
        message: {
          model: '<synthetic>',
          stop_reason: 'stop_sequence',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: 'text', text: 'No response requested.' }],
        },
      },
    ])).toEqual([]);
  });

  it('translates thinking blocks', () => {
    expect(run([
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'plan' }] } },
    ])).toEqual([{ type: 'thinking', delta: 'plan' }]);
  });

  it('translates user tool_result, including structured + error', () => {
    expect(run([
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            {
              type: 'tool_result',
              tool_use_id: 't2',
              content: [{ type: 'text', text: 'bad' }],
              is_error: true,
            },
          ],
        },
      },
    ])).toEqual([
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      {
        type: 'tool_result',
        id: 't2',
        output: JSON.stringify([{ type: 'text', text: 'bad' }]),
        isError: true,
      },
    ]);
  });

  it('synthesizes usage + done only when system.turn_duration arrives (after all assistant entries)', () => {
    const events = run([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'first half' }],
          usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 5 },
        },
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'final' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 7 },
        },
      },
      { type: 'system', subtype: 'turn_duration', durationMs: 1234 },
    ]);
    expect(events).toEqual([
      { type: 'text', delta: 'first half' },
      { type: 'text', delta: 'final' },
      { type: 'usage', inputTokens: 17, outputTokens: 12, cachedInputTokens: 4 },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('survives the Extended-Thinking case: thinking-only end_turn entry followed by text entry', () => {
    // Repro of the real-claude scenario where the response is split into two
    // assistant entries both carrying stop_reason="end_turn" — the first one
    // is signature-only thinking with no text, the second one holds the
    // actual reply. We must NOT emit `done` after the first entry; we wait
    // for the system.turn_duration marker.
    const events = run([
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }], stop_reason: 'end_turn' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'the real reply' }], stop_reason: 'end_turn' } },
      { type: 'system', subtype: 'turn_duration', durationMs: 1 },
    ]);
    expect(events).toEqual([
      { type: 'text', delta: 'the real reply' },
      { type: 'usage', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('does not emit done from turn_duration when no assistant end_turn was seen', () => {
    // turn_duration without a preceding end_turn should be a no-op
    // (defensive — shouldn't happen in practice).
    expect(run([
      { type: 'system', subtype: 'turn_duration', durationMs: 100 },
    ])).toEqual([]);
  });

  it('ignores unknown / empty / partial entries', () => {
    expect(run([
      null,
      { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } }, // no name
      { type: 'system', subtype: 'other' },
    ])).toEqual([]);
  });

  it('translates AskUserQuestion tool_use into a structured ask_user_question event', () => {
    expect(run([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_aq',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Pick a color',
                    header: 'Color',
                    multiSelect: false,
                    options: [
                      { label: 'Red', description: 'bold' },
                      { label: 'Blue' },
                    ],
                  },
                  {
                    question: 'Pick fruits',
                    multiSelect: true,
                    options: [
                      { label: 'Apple' },
                      { label: 'Banana' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    ])).toEqual([
      {
        type: 'ask_user_question',
        id: 'toolu_aq',
        questionIdx: 0,
        questions: [
          {
            question: 'Pick a color',
            header: 'Color',
            options: [
              { label: 'Red', description: 'bold' },
              { label: 'Blue' },
            ],
          },
          {
            question: 'Pick fruits',
            multiSelect: true,
            options: [{ label: 'Apple' }, { label: 'Banana' }],
          },
        ],
      },
    ]);
  });

  it('does not emit ask_user_question when input is malformed', () => {
    expect(run([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: { questions: 'bad' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'AskUserQuestion', input: { questions: [{ options: [] }] } }] } },
    ])).toEqual([]);
  });

  it('reports whether end_turn was seen', () => {
    const t = new JsonlTurnTranslator();
    for (const _ of t.translate({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })) {
      /* drain */
    }
    expect(t.endTurnSeen).toBe(false);
    for (const _ of t.translate({
      type: 'assistant',
      message: { content: [], stop_reason: 'end_turn' },
    })) {
      /* drain */
    }
    expect(t.endTurnSeen).toBe(true);
  });

  describe('snapshot', () => {
    it('returns an empty baseline before any entry', () => {
      const t = new JsonlTurnTranslator({ now: () => 1000 });
      expect(t.snapshot()).toEqual({
        inFlightTools: [],
        lastCompletedTool: null,
        lastTextTail: '',
        todos: null,
        entriesSeen: 0,
        tokens: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      });
    });

    it('tracks tool_use → tool_result lifecycle with human label', () => {
      let clock = 1000;
      const t = new JsonlTurnTranslator({ now: () => clock });
      const drain = (e: unknown) => { for (const _ of t.translate(e)) { /* drain */ } };

      drain({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't-bash', name: 'Bash', input: { command: 'pnpm test:unit' } },
            { type: 'tool_use', id: 't-edit', name: 'Edit', input: { file_path: 'src/foo.ts' } },
          ],
        },
      });
      const mid = t.snapshot();
      expect(mid.inFlightTools.map((x) => x.label)).toEqual([
        'Bash · pnpm test:unit',
        'Edit · src/foo.ts',
      ]);
      expect(mid.inFlightTools.every((x) => x.startedAt === 1000)).toBe(true);
      expect(mid.lastCompletedTool).toBeNull();

      clock = 1500;
      drain({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't-bash', content: 'ok' }] },
      });
      const after = t.snapshot();
      expect(after.inFlightTools.map((x) => x.id)).toEqual(['t-edit']);
      expect(after.lastCompletedTool?.id).toBe('t-bash');
      expect(after.lastCompletedTool?.label).toBe('Bash · pnpm test:unit');
    });

    it('parses TaskUpdate input into todo progress', () => {
      const t = new JsonlTurnTranslator({ now: () => 0 });
      for (const _ of t.translate({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'TaskUpdate',
              input: {
                todos: [
                  { content: 'A', status: 'completed' },
                  { content: 'B', status: 'completed', activeForm: 'Doing B' },
                  { content: 'C', status: 'in_progress', activeForm: 'Doing C' },
                  { content: 'D', status: 'pending' },
                  { content: 'E', status: 'pending' },
                ],
              },
            },
          ],
        },
      })) { /* drain */ }
      const snap = t.snapshot();
      expect(snap.todos).toEqual({
        total: 5,
        completed: 2,
        inProgressIdx: 2,
        items: [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'completed', activeForm: 'Doing B' },
          { content: 'C', status: 'in_progress', activeForm: 'Doing C' },
          { content: 'D', status: 'pending' },
          { content: 'E', status: 'pending' },
        ],
      });
    });

    it('keeps text tail bounded to last ~200 chars and counts entries + tokens', () => {
      const t = new JsonlTurnTranslator({ now: () => 0 });
      const long = 'x'.repeat(500);
      for (const _ of t.translate({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: long + 'TAIL' }],
          usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 3 },
        },
      })) { /* drain */ }
      for (const _ of t.translate({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '!' }] },
      })) { /* drain */ }
      const snap = t.snapshot();
      expect(snap.lastTextTail.length).toBeLessThanOrEqual(200);
      expect(snap.lastTextTail.endsWith('TAIL!')).toBe(true);
      expect(snap.entriesSeen).toBe(2);
      expect(snap.tokens).toEqual({ inputTokens: 13, outputTokens: 7, cachedInputTokens: 3 });
    });

    it('Agent tool label falls back to prompt when description is absent', () => {
      const t = new JsonlTurnTranslator({ now: () => 0 });
      for (const _ of t.translate({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'ag',
              name: 'Agent',
              input: { prompt: 'investigate the timeout bug in pty-session and report back' },
            },
          ],
        },
      })) { /* drain */ }
      expect(t.snapshot().inFlightTools[0]?.label.startsWith('Agent · investigate')).toBe(true);
    });
  });
});
