import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCwdForClaudeProjects } from '../../../src/agent/claude/jsonl-path.js';
import { PtySession } from '../../../src/agent/claude/pty-session.js';
import type { PtyHandle } from '../../../src/agent/claude/pty.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function createStubPty(): {
  handle: PtyHandle;
  writes: string[];
  emitData: (s: string) => void;
  emitExit: (code: number, signal?: number) => void;
} {
  const writes: string[] = [];
  const dataListeners: ((s: string) => void)[] = [];
  const exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  return {
    writes,
    emitData: (s) => dataListeners.forEach((l) => l(s)),
    emitExit: (code, signal) => exitListeners.forEach((l) => l({ exitCode: code, signal })),
    handle: {
      pid: 1234,
      write: (d) => writes.push(d),
      resize: () => {},
      onData: (l) => { dataListeners.push(l); },
      onExit: (l) => { exitListeners.push(l); },
      kill: () => {},
    },
  };
}

describe('PtySession', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeJsonlHome(cwd: string, sessionId: string): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'pty-session-home-'));
    dirs.push(home);
    const dir = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd));
    await mkdir(dir, { recursive: true });
    return home;
  }

  it('writes the prompt + delay + CR to the PTY and emits events drained from the JSONL', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-1';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });

    // Pre-populate the JSONL with two entries so runTurn finds them quickly.
    const jsonl = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd), `${sessionId}.jsonl`);
    setTimeout(async () => {
      await appendFile(jsonl, JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi back' }] },
      }) + '\n');
      await appendFile(jsonl, JSON.stringify({
        type: 'assistant',
        message: {
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      }) + '\n');
      await appendFile(jsonl, JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 1,
      }) + '\n');
    }, 20);

    const events: AgentEvent[] = [];
    for await (const ev of session.runTurn('hello')) events.push(ev);

    expect(stub.writes[0]).toBe('hello');
    expect(stub.writes[1]).toBe('\r');
    expect(events).toEqual([
      { type: 'text', delta: 'hi back' },
      { type: 'usage', inputTokens: 3, outputTokens: 4, cachedInputTokens: 0 },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('with readyMarker, a launcher banner + pause does not count as a ready TUI', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-marker';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 30,
      readinessMaxMs: 5000,
      readyMarker: '\x1b[?2004h',
    });

    const events: AgentEvent[] = [];
    const turn = (async () => {
      for await (const ev of session.runTurn('hello')) events.push(ev);
    })();

    // seedx banner, then a pause well past the quiet window.
    stub.emitData('agent=claude · 权限=受限\n拉起 claude 会话(不绑需求)…\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.writes).toEqual([]);

    // claude's first frame arrives; prompt goes out after the quiet window.
    stub.emitData('\x1b[?25l\x1b[?2004h\x1b[?1004h welcome');
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.writes.slice(0, 2)).toEqual(['hello', '\r']);

    stub.emitExit(0);
    await turn;
  });

  it('flattens internal newlines so the TUI sees one line + Submit', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-newlines';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });

    const jsonl = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd), `${sessionId}.jsonl`);
    setTimeout(async () => {
      await appendFile(jsonl, JSON.stringify({
        type: 'assistant',
        message: { content: [], stop_reason: 'end_turn', usage: {} },
      }) + '\n');
      await appendFile(jsonl, JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 1,
      }) + '\n');
    }, 20);

    for await (const _ of session.runTurn('line1\nline2\r\nline3')) { /* drain */ }

    expect(stub.writes[0]).toBe('line1 line2 line3');
    expect(stub.writes[1]).toBe('\r');
  });

  it('handles the "trust this folder" consent dialog by pressing Enter (one-time)', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-trust';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });
    void session;

    stub.emitData('Quick safety check: Is this a project you trust?\n  1. Yes, I trust this folder\n  2. No, exit\n');

    // Dialog response is debounced 100ms so the redraw settles first.
    await new Promise((r) => setTimeout(r, 200));
    expect(stub.writes).toContain('\r');
    const trustPresses = stub.writes.filter((w) => w === '\r').length;
    expect(trustPresses).toBeGreaterThanOrEqual(1);

    // Re-emitting the same string must not re-press.
    stub.emitData('Yes, I trust this folder\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.writes.filter((w) => w === '\r').length).toBe(trustPresses);
  });

  it('resends a consent answer claude dropped, and stops once claude reacts', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-consent-retry';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    void new PtySession({ pty: stub.handle, cwd, sessionId, home, readinessQuietMs: 0, consentDelayMs: 10 });

    stub.emitData('Quick safety check\n ❯ No, continue without these permissions\n   Yes, I trust this folder\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.writes).toEqual(['\r']);

    // No redraw after the first Enter → it was dropped → resend after the retry window.
    await new Promise((r) => setTimeout(r, 1600));
    expect(stub.writes).toEqual(['\r', '\r']);

    // claude reacts → no more presses.
    stub.emitData('\x1b[2J main TUI');
    await new Promise((r) => setTimeout(r, 1600));
    expect(stub.writes).toEqual(['\r', '\r']);
  });

  it('does not type the prompt while a consent dialog is still unanswered', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-consent-gate';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 30,
      readinessMaxMs: 5000,
      consentDelayMs: 200,
    });
    const turn = (async () => {
      for await (const _ev of session.runTurn('hello')) { /* drain */ }
    })();

    stub.emitData('Yes, I trust this folder\n');
    // Quiet window (30ms) elapses long before the consent key goes out.
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.writes).toEqual([]);

    await new Promise((r) => setTimeout(r, 100));
    expect(stub.writes).toEqual(['\r']);
    stub.emitData('main TUI');
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.writes).toEqual(['\r', 'hello', '\r']);

    stub.emitExit(0);
    await turn;
  });

  it('handles the "Bypass Permissions" consent by pressing 2 (one-time)', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-bypass';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });
    void session;

    stub.emitData('Bypass Permissions mode\n  1. No, exit\n  2. Yes, I accept\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(stub.writes).toContain('2\r');

    const before = stub.writes.filter((w) => w === '2\r').length;
    stub.emitData('Yes, I accept\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.writes.filter((w) => w === '2\r').length).toBe(before);
  });

  describe('answerAskUserQuestion', () => {
    const cwd = '/Users/me/proj';

    function makeSession(stub: ReturnType<typeof createStubPty>) {
      return new PtySession({
        pty: stub.handle,
        cwd,
        sessionId: 'aq-test',
        home: '/tmp',
        pollMs: 10,
        promptDelayMs: 5,
        readinessQuietMs: 0,
      });
    }

    it('single-select: writes just the option number (no Tab) for a non-last question', async () => {
      const stub = createStubPty();
      const session = makeSession(stub);
      await session.answerAskUserQuestion({
        toolUseId: 'toolu_1',
        selections: [2],
        multiSelect: false,
        isLastQuestion: false,
      });
      expect(stub.writes).toEqual(['3']);
    });

    it('single-select last question: writes number then \\r as separate keystrokes', async () => {
      const stub = createStubPty();
      const session = makeSession(stub);
      await session.answerAskUserQuestion({
        toolUseId: 'toolu_2',
        selections: [0],
        multiSelect: false,
        isLastQuestion: true,
      });
      expect(stub.writes).toEqual(['1', '\r']);
    });

    it('multi-select: each number then Tab as separate writes, no \\r when not last', async () => {
      const stub = createStubPty();
      const session = makeSession(stub);
      await session.answerAskUserQuestion({
        toolUseId: 'toolu_3',
        selections: [0, 2],
        multiSelect: true,
        isLastQuestion: false,
      });
      expect(stub.writes).toEqual(['1', '3', '\t']);
    });

    it('multi-select last question: numbers + Tab + Enter as four separate writes', async () => {
      const stub = createStubPty();
      const session = makeSession(stub);
      await session.answerAskUserQuestion({
        toolUseId: 'toolu_4',
        selections: [1, 3],
        multiSelect: true,
        isLastQuestion: true,
      });
      expect(stub.writes).toEqual(['2', '4', '\t', '\r']);
    });

    it('does nothing when selections is empty', async () => {
      const stub = createStubPty();
      const session = makeSession(stub);
      await session.answerAskUserQuestion({
        toolUseId: 'toolu_empty',
        selections: [],
        multiSelect: false,
        isLastQuestion: false,
      });
      expect(stub.writes).toEqual([]);
    });

    it('skips out-of-range option indices but still writes the in-range ones', async () => {
      const stub = createStubPty();
      const session = makeSession(stub);
      await session.answerAskUserQuestion({
        toolUseId: 'toolu_oor',
        selections: [0, 9, 2], // 9 maps to "10" which exceeds single-digit
        multiSelect: true,
        isLastQuestion: false,
      });
      expect(stub.writes).toEqual(['1', '3', '\t']);
    });
  });

  it('softInterrupt writes ESC and resolves done(interrupted) if the turn does not complete in grace', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-3';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });

    const iter = session.runTurn('long task')[Symbol.asyncIterator]();
    setTimeout(() => { void session.softInterrupt(20); }, 30);

    const ev = await iter.next();
    expect(ev.done).toBe(false);
    expect(ev.value).toEqual({ type: 'done', terminationReason: 'interrupted' });

    expect(stub.writes).toContain('\x1b');
  });

  it('emits error(failed) and stops iteration when the PTY exits mid-turn', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-4';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });

    setTimeout(() => stub.emitExit(1, undefined), 30);

    const events: AgentEvent[] = [];
    for await (const ev of session.runTurn('bye')) events.push(ev);

    expect(events.at(-1)).toEqual({
      type: 'error',
      message: expect.stringMatching(/exited/i) as unknown as string,
      terminationReason: 'failed',
    });
    expect(session.isAlive()).toBe(false);
  });

  it('emits idle_checkpoint with snapshot when JSONL goes silent, without ending the turn', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-checkpoint';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const jsonl = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd), `${sessionId}.jsonl`);
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 5,
      promptDelayMs: 1,
      readinessQuietMs: 0,
      // Three checkpoints at 30/60/60 ms — short enough for tests.
      idleCheckpointsMs: [30, 60, 60],
    });

    setTimeout(async () => {
      await appendFile(
        jsonl,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 999' } },
            ],
          },
        }) + '\n',
      );
    }, 5);

    const events: AgentEvent[] = [];
    const iter = session.runTurn('hi')[Symbol.asyncIterator]();
    try {
      // Collect 2 checkpoints — proves backoff actually advances, not just one firing repeatedly.
      let checkpointsSeen = 0;
      while (checkpointsSeen < 2) {
        const { value, done } = await iter.next();
        if (done) break;
        events.push(value);
        if (value.type === 'idle_checkpoint') checkpointsSeen += 1;
      }
    } finally {
      await session.softInterrupt(50);
      // Drain remaining events so the generator's `finally` runs.
      for await (const ev of { [Symbol.asyncIterator]: () => iter }) events.push(ev);
    }

    const checkpoints = events.filter((e) => e.type === 'idle_checkpoint') as Array<
      Extract<AgentEvent, { type: 'idle_checkpoint' }>
    >;
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    expect(checkpoints[0]!.checkpointNumber).toBe(1);
    expect(checkpoints[1]!.checkpointNumber).toBe(2);
    expect(checkpoints[0]!.snapshot.inFlightTools[0]?.name).toBe('Bash');
    expect(checkpoints[0]!.snapshot.inFlightTools[0]?.label).toContain('sleep 999');
    expect(checkpoints[0]!.snapshot.lastEntryAt).toBeGreaterThan(0);
    // Second checkpoint must wait at least the 2nd backoff (60ms) past the first.
    expect(checkpoints[1]!.idleMs).toBeGreaterThan(checkpoints[0]!.idleMs);
  });

  it('ends the turn (error/failed) when JSONL stays silent past maxSilenceMs with no tool in flight', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-silence-timeout';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 5,
      promptDelayMs: 1,
      readinessQuietMs: 0,
      // Push checkpoints far out so they can't interfere with the assertion.
      idleCheckpointsMs: [10_000],
      maxSilenceMs: 40,
      maxTurnMs: 0,
    });

    // Never write to the JSONL: the turn must self-terminate on the ceiling.
    const events: AgentEvent[] = [];
    for await (const ev of session.runTurn('hi')) events.push(ev);

    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((last as Extract<AgentEvent, { type: 'error' }>).message).toContain('超时');
  });

  it('does NOT time out on silence while a tool is in flight', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-silence-inflight';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const jsonl = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd), `${sessionId}.jsonl`);
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 5,
      promptDelayMs: 1,
      readinessQuietMs: 0,
      idleCheckpointsMs: [10_000],
      maxSilenceMs: 30,
      maxTurnMs: 0,
    });

    // A tool_use with no matching tool_result keeps a tool "in flight", which
    // must pause the silence ceiling (legit long build / OAuth wait).
    setTimeout(() => {
      void appendFile(
        jsonl,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 999' } }],
          },
        }) + '\n',
      );
    }, 5);

    const events: AgentEvent[] = [];
    const iter = session.runTurn('hi')[Symbol.asyncIterator]();
    const pump = (async () => {
      while (true) {
        const { value, done } = await iter.next();
        if (done) break;
        events.push(value);
      }
    })();

    // Wait well past 5× maxSilenceMs — a broken ceiling would have fired by now.
    await new Promise((r) => setTimeout(r, 200));
    expect(events.some((e) => e.type === 'error')).toBe(false);

    await session.softInterrupt(50);
    await pump;
    // Ended by interrupt, not by the silence ceiling.
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
  });

  it('ends the turn (error/failed) at maxTurnMs wall-clock cap', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-wallclock';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 5,
      promptDelayMs: 1,
      readinessQuietMs: 0,
      idleCheckpointsMs: [10_000],
      maxSilenceMs: 0, // disable silence ceiling to isolate the wall-clock cap
      maxTurnMs: 60,
    });

    const events: AgentEvent[] = [];
    for await (const ev of session.runTurn('hi')) events.push(ev);

    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((last as Extract<AgentEvent, { type: 'error' }>).message).toContain('单轮时长上限');
  });

  it('resetIdleCheckpoint() restarts the backoff and JSONL progress prevents checkpoints', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-progress';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const jsonl = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd), `${sessionId}.jsonl`);
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 5,
      promptDelayMs: 1,
      readinessQuietMs: 0,
      // 40ms first checkpoint; keep entries flowing faster than that → no checkpoint.
      idleCheckpointsMs: [40, 40, 40],
    });

    let cancelled = false;
    (async () => {
      for (let i = 0; i < 10; i++) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 20));
        await appendFile(
          jsonl,
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: `chunk-${i}` }] },
          }) + '\n',
        );
      }
      await appendFile(
        jsonl,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }) + '\n',
      );
      await appendFile(
        jsonl,
        JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 200 }) + '\n',
      );
    })();

    const events: AgentEvent[] = [];
    try {
      for await (const ev of session.runTurn('go')) events.push(ev);
    } finally {
      cancelled = true;
    }

    expect(events.at(-1)?.type).toBe('done');
    expect(events.some((e) => e.type === 'idle_checkpoint')).toBe(false);
  });

  it('terminate() resolves via soft-interrupt when runTurn yields interrupted in time', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-term-soft';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 5, // small enough that runTurn ticks before terminate's grace expires
      promptDelayMs: 1,
      readinessQuietMs: 0,
    });

    const killCalls: Array<string | undefined> = [];
    (stub.handle as { kill: (sig?: string) => void }).kill = (sig) => {
      killCalls.push(sig);
    };

    const events: AgentEvent[] = [];
    const drain = (async () => {
      for await (const ev of session.runTurn('hi')) events.push(ev);
    })();
    await new Promise((r) => setTimeout(r, 20));
    expect(session.isBusy()).toBe(true);

    await session.terminate(100, 50);
    await drain;

    // Soft path: ESC was written, no kill signals issued, last event is interrupted.
    expect(stub.writes).toContain('\x1b');
    expect(killCalls).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'done', terminationReason: 'interrupted' });
    expect(session.isBusy()).toBe(false);
  });

  it('terminate() escalates to hardClose when soft interrupt does not clear busy in time', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-term-esc';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 500, // far longer than softGraceMs below, so runTurn won't tick before soft returns
      promptDelayMs: 1,
      readinessQuietMs: 0,
    });

    const killCalls: Array<string | undefined> = [];
    (stub.handle as { kill: (sig?: string) => void }).kill = (sig) => {
      killCalls.push(sig);
      // Simulate a PTY actually exiting on SIGTERM so the hardClose loop ends.
      stub.emitExit(143, undefined);
    };

    const events: AgentEvent[] = [];
    const drain = (async () => {
      for await (const ev of session.runTurn('hi')) events.push(ev);
    })();
    await new Promise((r) => setTimeout(r, 30));
    expect(session.isBusy()).toBe(true);

    // softGraceMs=20 ≪ pollMs=500 → softInterrupt returns before runTurn ticks.
    await session.terminate(20, 50);
    await drain;

    expect(stub.writes).toContain('\x1b');
    expect(killCalls).toContain('SIGTERM');
    expect(session.isAlive()).toBe(false);
  });

  it('snapshot() returns null outside a turn and the live state during one', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-snap';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const jsonl = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd), `${sessionId}.jsonl`);
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 5,
      promptDelayMs: 1,
      readinessQuietMs: 0,
    });

    expect(session.snapshot()).toBeNull();

    const iter = session.runTurn('plan it')[Symbol.asyncIterator]();
    setTimeout(async () => {
      await appendFile(
        jsonl,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'thinking...' },
              {
                type: 'tool_use',
                id: 'tc-1',
                name: 'TaskCreate',
                input: {
                  todos: [
                    { content: 'A', status: 'completed' },
                    { content: 'B', status: 'in_progress' },
                    { content: 'C', status: 'pending' },
                  ],
                },
              },
            ],
          },
        }) + '\n',
      );
    }, 5);

    // Pull events until both the text and the tool_use have been processed.
    let gotText = false;
    let gotTool = false;
    while (!gotText || !gotTool) {
      const { value, done } = await iter.next();
      if (done) break;
      if (value.type === 'text') gotText = true;
      if (value.type === 'tool_use') gotTool = true;
    }

    const snap = session.snapshot();
    expect(snap).not.toBeNull();
    expect(snap!.lastTextTail).toContain('thinking');
    expect(snap!.todos?.total).toBe(3);
    expect(snap!.todos?.completed).toBe(1);
    expect(snap!.todos?.inProgressIdx).toBe(1);
    expect(snap!.entriesSeen).toBe(1);

    await session.softInterrupt(50);
    for await (const _ of { [Symbol.asyncIterator]: () => iter }) { /* drain */ }
    expect(session.snapshot()).toBeNull();
  });
});
