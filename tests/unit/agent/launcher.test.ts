import { describe, expect, it } from 'vitest';
import { ClaudePtyAdapter } from '../../../src/agent/claude/pty-adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import { applyLauncher, launcherBinary } from '../../../src/agent/launcher';

describe('applyLauncher', () => {
  const spec = {
    file: '/usr/local/bin/claude',
    args: ['--permission-mode', 'acceptEdits', '--session-id', 's1'],
    env: { PATH: '/bin', HOME: '/home/u' } as Record<string, string | undefined>,
  };

  it('returns the spec untouched without a launcher', () => {
    expect(applyLauncher(undefined, 'claude', spec)).toBe(spec);
  });

  it('wraps the agent as `seedx <agent> --permission-mode limited -- <args>`', () => {
    const out = applyLauncher({ kind: 'seedx' }, 'claude', spec);
    expect(out.file).toBe('seedx');
    expect(out.args).toEqual([
      'claude', '--permission-mode', 'limited', '--',
      '--permission-mode', 'acceptEdits', '--session-id', 's1',
    ]);
  });

  it('uses the configured seedx binary', () => {
    const launcher = { kind: 'seedx' as const, binaryPath: '/opt/seedx/bin/seedx' };
    expect(applyLauncher(launcher, 'codex', spec).file).toBe('/opt/seedx/bin/seedx');
    expect(launcherBinary(launcher)).toBe('/opt/seedx/bin/seedx');
    expect(launcherBinary({ kind: 'seedx' })).toBe('seedx');
  });

  it('strips the env markers that make seedx silently refuse to launch', () => {
    const out = applyLauncher({ kind: 'seedx' }, 'codex', {
      ...spec,
      env: {
        ...spec.env,
        SEEDX_CHILD_SESSION: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CODEX_THREAD_ID: 't',
        CODEX_SANDBOX: 'seatbelt',
        AGENT: 'codex',
      },
    });
    expect(out.env).toEqual(spec.env);
    expect(out.args.slice(0, 4)).toEqual(['codex', '--permission-mode', 'limited', '--']);
  });

  it('does not mutate the caller env', () => {
    const env = { ...spec.env, AGENT: 'codex' };
    applyLauncher({ kind: 'seedx' }, 'claude', { ...spec, env });
    expect(env.AGENT).toBe('codex');
  });
});

describe('preflight with a launcher', () => {
  const launcher = { kind: 'seedx' as const, binaryPath: '/nonexistent/seedx-bin' };

  it('checks the seedx binary instead of claude', async () => {
    const res = await new ClaudePtyAdapter({ binary: '/nonexistent/claude-bin', launcher }).checkAvailability();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostic.command).toBe('/nonexistent/seedx-bin');
  });

  it('checks the seedx binary instead of codex', async () => {
    const res = await new CodexAdapter({
      binary: '/nonexistent/codex-bin',
      profileStateDir: '/tmp',
      launcher,
    }).checkAvailability();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.diagnostic.command).toBe('/nonexistent/seedx-bin');
  });
});
