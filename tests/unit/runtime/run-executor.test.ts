import { describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

describe('RunExecutor policy runtime options', () => {
  it('passes policy sandbox and permission mode into each agent run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-policy',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-policy',
      policy: policy({
        sandbox: 'workspace-write',
        permissionMode: 'acceptEdits',
      }),
    });

    expect(agent.runOptions[0]).toMatchObject({
      runId: 'run-policy',
      sandbox: 'workspace-write',
      permissionMode: 'acceptEdits',
    });

    await collect(execution.subscribe());
  });
});

function policy(overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: '/tmp/repo',
    cwdRealpath: '/tmp/repo',
    accessMode: 'workspace',
    sandbox: 'workspace-write',
    permissionMode: 'acceptEdits',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('RunExecutor lifecycle safety', () => {
  it('releases the scope and the pool slot when nobody ever subscribes', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const activeRuns = new ActiveRuns();
    const pool = new ProcessPool(() => 1);
    const executor = new RunExecutor({
      agent,
      pool,
      activeRuns,
      createRunId: () => 'run-orphan',
      now: () => 1000,
      postDoneExitGraceMs: 0,
    });

    // Caller submits, then blows up before it ever drains execution.subscribe()
    // — exactly what happens when sending the reply card fails.
    await executor.submit({ scopeId: 'scope-orphan', policy: policy() });

    await waitFor(() => activeRuns.get('scope-orphan') === undefined);
    expect(pool.snapshot().active).toBe(0);
  });

  it('does not touch the agent again when stopping an already finished run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-settled',
      now: () => 1000,
      postDoneExitGraceMs: 0,
    });

    const execution = await executor.submit({ scopeId: 'scope-settled', policy: policy() });
    await collect(execution.subscribe());

    // A caller that fails *after* the stream completed must not be able to
    // kill the underlying (reusable) agent session by stopping a dead run.
    await execution.stop();

    expect(agent.runs[0]?.stopped).toBe(false);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for async work');
}
