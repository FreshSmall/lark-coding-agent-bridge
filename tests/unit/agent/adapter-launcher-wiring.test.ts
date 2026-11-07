import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ptyMock = vi.hoisted(() => ({ spawnPty: vi.fn() }));
vi.mock('../../../src/agent/claude/pty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agent/claude/pty')>();
  return { ...actual, spawnPty: ptyMock.spawnPty };
});

const spawnMock = vi.hoisted(() => ({ spawnProcess: vi.fn() }));
vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { ClaudeHeadlessAdapter } from '../../../src/agent/claude/adapter';
import { ClaudePtyAdapter } from '../../../src/agent/claude/pty-adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import type { PtyHandle } from '../../../src/agent/claude/pty';

const SEEDX = { kind: 'seedx' as const };
const SEEDX_PREFIX = (agent: string) => [agent, '--permission-mode', 'limited', '--'];

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

function fakePtyHandle(): PtyHandle & { triggerExit: (code: number) => void } {
  const exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  return {
    pid: 4242,
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((l: (e: { exitCode: number; signal?: number }) => void) => { exitListeners.push(l); }),
    kill: vi.fn(),
    triggerExit: (code) => exitListeners.forEach((l) => l({ exitCode: code })),
  };
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
  ptyMock.spawnPty.mockReset();
  process.env.CLAUDE_CODE_CHILD_SESSION = '1';
  return () => { delete process.env.CLAUDE_CODE_CHILD_SESSION; };
});

async function spawnPtyOnce(adapter: ClaudePtyAdapter) {
  let captured: { file: string; args: string[]; env: Record<string, string | undefined> } | undefined;
  let handle: ReturnType<typeof fakePtyHandle> | undefined;
  ptyMock.spawnPty.mockImplementation((opts: typeof captured) => {
    captured = opts;
    handle = fakePtyHandle();
    return handle;
  });
  const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp', permissionMode: 'acceptEdits' });
  const done = (async () => {
    for await (const e of run.events) if (e.type === 'error' || e.type === 'done') break;
  })();
  await new Promise((r) => setTimeout(r, 50));
  handle?.triggerExit(0);
  await done;
  return captured!;
}

describe('agent launcher wiring', () => {
  it('ClaudePtyAdapter spawns claude directly without a launcher', async () => {
    const spawned = await spawnPtyOnce(new ClaudePtyAdapter({ readinessQuietMs: 0 }));
    expect(spawned.file).toBe('claude');
    expect(spawned.args[0]).toBe('--permission-mode');
    expect(spawned.env.CLAUDE_CODE_CHILD_SESSION).toBe('1');
  });

  it('ClaudePtyAdapter goes through seedx with the bridge permission mode after `--`', async () => {
    const spawned = await spawnPtyOnce(new ClaudePtyAdapter({ readinessQuietMs: 0, launcher: SEEDX }));
    expect(spawned.file).toBe('seedx');
    expect(spawned.args.slice(0, 6)).toEqual([...SEEDX_PREFIX('claude'), '--permission-mode', 'acceptEdits']);
    expect(spawned.env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
  });

  it('ClaudeHeadlessAdapter goes through seedx', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    new ClaudeHeadlessAdapter({ launcher: SEEDX }).run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    const [file, args, opts] = spawnMock.spawnProcess.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(file).toBe('seedx');
    expect(args.slice(0, 5)).toEqual([...SEEDX_PREFIX('claude'), '-p']);
    expect(opts.env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
  });

  it('CodexAdapter goes through seedx and keeps CODEX_HOME', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: '/tmp/codex-profile',
      codexHome: '/tmp/codex-home',
      launcher: { kind: 'seedx', binaryPath: '/opt/bin/seedx' },
    }).run({ runId: 'r1', prompt: 'hi', cwd: '/tmp', sandbox: 'read-only' });
    const [file, args, opts] = spawnMock.spawnProcess.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(file).toBe('/opt/bin/seedx');
    expect(args.slice(0, 5)).toEqual([...SEEDX_PREFIX('codex'), 'exec']);
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only']);
    expect(opts.env.CODEX_HOME).toBe('/tmp/codex-home');
    expect(opts.env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
  });
});
