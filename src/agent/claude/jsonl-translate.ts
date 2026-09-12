import type {
  AgentEvent,
  AskUserQuestionItem,
  TodoItem,
  TodoSnapshot,
  ToolInFlight,
} from '../types';

export interface TranslatorSnapshot {
  inFlightTools: ToolInFlight[];
  lastCompletedTool: ToolInFlight | null;
  lastTextTail: string;
  todos: TodoSnapshot | null;
  entriesSeen: number;
  tokens: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
}

const TEXT_TAIL_MAX = 200;

/** `message.model` value Claude Code uses for turns it fabricates itself. */
const SYNTHETIC_MODEL = '<synthetic>';

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function humanLabel(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const inp = input as Record<string, unknown>;
  const str = (k: string): string => (typeof inp[k] === 'string' ? (inp[k] as string) : '');
  switch (name) {
    case 'Bash':
      return `Bash · ${truncate(str('command'), 80)}`;
    case 'Edit':
    case 'Write':
      return `${name} · ${str('file_path')}`;
    case 'Read': {
      const p = str('file_path');
      const off = typeof inp.offset === 'number' ? `:${inp.offset}` : '';
      return `Read · ${p}${off}`;
    }
    case 'Grep': {
      const pat = truncate(str('pattern'), 40);
      const path = str('path');
      return `Grep · ${pat}${path ? ` in ${path}` : ''}`;
    }
    case 'Glob':
      return `Glob · ${str('pattern')}`;
    case 'Agent': {
      const desc = str('description') || str('prompt');
      return `Agent · ${truncate(desc, 60)}`;
    }
    case 'WebFetch':
      return `WebFetch · ${str('url')}`;
    case 'WebSearch':
      return `WebSearch · ${truncate(str('query'), 60)}`;
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TodoWrite':
      return name; // todo list itself surfaced via TurnSnapshot.todos
    default:
      return name;
  }
}

function parseTodos(input: unknown): TodoSnapshot | null {
  if (!input || typeof input !== 'object') return null;
  const raw = (input as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return null;
  const items: TodoItem[] = [];
  let inProgressIdx: number | null = null;
  let completed = 0;
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const obj = it as Record<string, unknown>;
    const content = typeof obj.content === 'string' ? obj.content : '';
    const status = obj.status;
    if (
      !content ||
      (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
    ) {
      continue;
    }
    if (status === 'in_progress' && inProgressIdx === null) inProgressIdx = items.length;
    if (status === 'completed') completed++;
    items.push({
      content,
      ...(typeof obj.activeForm === 'string' && obj.activeForm
        ? { activeForm: obj.activeForm }
        : {}),
      status,
    });
  }
  if (items.length === 0) return null;
  return { total: items.length, completed, inProgressIdx, items };
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface AssistantMessage {
  content?: ContentBlock[];
  stop_reason?: string;
  /** `'<synthetic>'` for turns the CLI fabricates rather than sampling. */
  model?: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

interface UserMessage {
  content?: ContentBlock[];
}

interface SystemEntry {
  type?: string;
  subtype?: string;
}

interface JsonlEntry {
  type?: string;
  subtype?: string;
  message?: AssistantMessage | UserMessage;
}

/**
 * Per-turn translator. One instance per `PtySession.runTurn()` so the
 * end-of-turn usage event correctly sums only the turn's assistant entries.
 *
 * Reads JSONL records written to `~/.claude/projects/<encoded>/<id>.jsonl`
 * and emits the bridge's `AgentEvent`.
 *
 * **Turn-end detection:** assistant entries with `stop_reason === "end_turn"`
 * are NOT reliable as turn boundaries by themselves — when claude does
 * Extended Thinking, it splits the response into a *thinking-only* assistant
 * entry (signature-only, no visible text) with `stop_reason: end_turn`,
 * followed by a *text* assistant entry (also `stop_reason: end_turn`) that
 * holds the user-visible reply. If we emit `done` on the first one we lose
 * the second one. The reliable signal is a `system` entry with
 * `subtype: "turn_duration"`, written after all assistant content for the
 * turn — we emit `usage` + `done` then.
 */
export class JsonlTurnTranslator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private _endTurnSeen = false;
  private currentTools = new Map<string, ToolInFlight>();
  private lastCompletedTool: ToolInFlight | null = null;
  private lastTextTail = '';
  private todos: TodoSnapshot | null = null;
  private entriesSeen = 0;
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  get endTurnSeen(): boolean {
    return this._endTurnSeen;
  }

  snapshot(): TranslatorSnapshot {
    return {
      inFlightTools: [...this.currentTools.values()],
      lastCompletedTool: this.lastCompletedTool,
      lastTextTail: this.lastTextTail,
      todos: this.todos,
      entriesSeen: this.entriesSeen,
      tokens: {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        cachedInputTokens: this.cachedInputTokens,
      },
    };
  }

  private appendText(delta: string): void {
    this.lastTextTail = (this.lastTextTail + delta).slice(-TEXT_TAIL_MAX);
  }

  *translate(raw: unknown): Generator<AgentEvent> {
    if (!raw || typeof raw !== 'object') return;
    this.entriesSeen += 1;
    const entry = raw as JsonlEntry;
    if (entry.type === 'assistant') {
      const message = entry.message as AssistantMessage | undefined;
      // Claude Code fabricates a zero-token `<synthetic>` assistant turn to keep
      // the transcript alternating after `[Request interrupted by user]` or a
      // `Continue from where you left off.` resume. Its body ("No response
      // requested.") is bookkeeping, not a reply — rendering it would open the
      // Lark card with a line the model never wrote.
      if (message?.model === SYNTHETIC_MODEL) return;
      if (message?.usage) {
        const u = message.usage;
        this.inputTokens +=
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        this.outputTokens += u.output_tokens ?? 0;
        this.cachedInputTokens += u.cache_read_input_tokens ?? 0;
      }
      if (message?.stop_reason === 'end_turn') {
        this._endTurnSeen = true;
      }
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          this.appendText(block.text);
          yield { type: 'text', delta: block.text };
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          yield { type: 'thinking', delta: block.thinking };
        } else if (block.type === 'tool_use' && block.id && block.name) {
          // Track every tool_use (including AskUserQuestion) for snapshot purposes.
          const inFlight: ToolInFlight = {
            id: block.id,
            name: block.name,
            label: humanLabel(block.name, block.input),
            startedAt: this.now(),
          };
          this.currentTools.set(block.id, inFlight);
          // Tool inputs that carry semantic progress (todo lists) update derived
          // snapshot fields immediately — the bridge doesn't have to wait for
          // tool_result to surface them.
          if (
            block.name === 'TaskCreate' ||
            block.name === 'TaskUpdate' ||
            block.name === 'TodoWrite'
          ) {
            const parsed = parseTodos(block.input);
            if (parsed) this.todos = parsed;
          }
          if (block.name === 'AskUserQuestion') {
            // Special-case claude's built-in AskUserQuestion. Don't emit it
            // as a generic tool_use (the bot can't show a useful panel for a
            // tool that's pending blocking keyboard input); emit a structured
            // event the bot can render as an interactive Lark card.
            const questions = parseAskUserQuestions(block.input);
            if (questions.length > 0) {
              yield {
                type: 'ask_user_question',
                id: block.id,
                questions,
                questionIdx: 0,
              };
            }
            // If the input couldn't be parsed (shouldn't happen with real
            // claude), skip silently — better than emitting half a tool_use.
            continue;
          }
          yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        }
      }
      return;
    }
    if (entry.type === 'user') {
      const message = entry.message as UserMessage | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const completed = this.currentTools.get(block.tool_use_id);
          if (completed) {
            this.currentTools.delete(block.tool_use_id);
            this.lastCompletedTool = completed;
          }
          const output =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          yield {
            type: 'tool_result',
            id: block.tool_use_id,
            output,
            isError: block.is_error === true,
          };
        }
      }
      return;
    }
    if (entry.type === 'system') {
      const sys = raw as SystemEntry;
      if (sys.subtype === 'turn_duration' && this._endTurnSeen) {
        yield {
          type: 'usage',
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
          cachedInputTokens: this.cachedInputTokens,
        };
        yield { type: 'done', terminationReason: 'normal' };
      }
    }
  }
}

/**
 * Parse the `input` of an `AskUserQuestion` tool_use into our typed shape.
 * Returns [] if the structure doesn't match.
 */
function parseAskUserQuestions(input: unknown): AskUserQuestionItem[] {
  if (!input || typeof input !== 'object') return [];
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskUserQuestionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const q = item as {
      question?: unknown;
      header?: unknown;
      multiSelect?: unknown;
      options?: unknown;
    };
    const question = typeof q.question === 'string' ? q.question : '';
    if (!question) continue;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: AskUserQuestionItem['options'] = [];
    for (const o of rawOptions) {
      if (!o || typeof o !== 'object') continue;
      const oo = o as { label?: unknown; description?: unknown };
      if (typeof oo.label !== 'string' || !oo.label) continue;
      options.push({
        label: oo.label,
        ...(typeof oo.description === 'string' && oo.description
          ? { description: oo.description }
          : {}),
      });
    }
    if (options.length === 0) continue;
    out.push({
      question,
      ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out;
}
