import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret, listSecretIds } from '../../../src/config/keystore';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { getRequireMentionInGroup, secretKeyForApp } from '../../../src/config/schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: vi.fn(async () => ({
    ok: true,
    botName: 'Updated Bot',
    botOpenId: 'ou-bot',
  })),
}));

const identityPolicyMocks = vi.hoisted(() => ({
  applyLarkCliIdentityPolicy: vi.fn(async () => true),
}));

vi.mock('../../../src/lark-cli/identity-policy', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lark-cli/identity-policy')>(
    '../../../src/lark-cli/identity-policy',
  );
  return {
    ...actual,
    applyLarkCliIdentityPolicy: identityPolicyMocks.applyLarkCliIdentityPolicy,
  };
});

const preflightMocks = vi.hoisted(() => ({
  checkAgentAvailability: vi.fn(async () => ({ ok: true, version: '1.7.0' }) as unknown),
}));

vi.mock('../../../src/agent/preflight', async () => {
  const actual = await vi.importActual<typeof import('../../../src/agent/preflight')>(
    '../../../src/agent/preflight',
  );
  return { ...actual, checkAgentAvailability: preflightMocks.checkAgentAvailability };
});

const roots: string[] = [];

beforeEach(() => {
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockReset();
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValue(true);
  preflightMocks.checkAgentAvailability.mockReset();
  preflightMocks.checkAgentAvailability.mockResolvedValue({ ok: true, version: '1.7.0' });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile-aware account and config commands', () => {
  it('saves /config submit into the active v2 profile without flattening root config', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      tool_call_display: 'hide',
      tool_call_display_in_groups: 'compact',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.messageReply === 'text',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.activeProfile).toBe('claude');
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.preferences).toMatchObject({
      messageReply: 'text',
      messageReplyMigrated: true,
      toolCallDisplay: 'hide',
      toolCallDisplayInGroups: 'compact',
      maxConcurrentRuns: 7,
      runIdleTimeoutMinutes: 15,
    });
    // The legacy boolean is dropped on submit so the canonical tri-state is
    // the single source of truth.
    expect(root.profiles.claude?.preferences).not.toHaveProperty('showToolCalls');
    expect(root.profiles.claude?.access.requireMentionInGroup).toBe(false);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('user-default');
    expect(root.profiles.claude?.larkCli.localUserImport).toMatchObject({
      status: 'not-needed',
      reason: 'manual-user-default',
    });
    expect(getRequireMentionInGroup(runtimeProfileConfig(root, 'claude'))).toBe(false);
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
  });

  it('does not save a lark-cli identity change when applying the runtime policy fails', async () => {
    vi.useFakeTimers();
    identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValueOnce(false);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      tool_call_display: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('bot-only');
    expect(root.profiles.claude?.preferences.messageReply).not.toBe('text');
    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('lark-cli 身份策略');
    expect(card).not.toContain('偏好已保存');
  });

  it('rolls back lark-cli identity when saving config fails after applying the runtime policy', async () => {
    vi.useFakeTimers();
    const applied = deferred<boolean>();
    identityPolicyMocks.applyLarkCliIdentityPolicy
      .mockImplementationOnce(async () => applied.promise)
      .mockResolvedValue(true);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      tool_call_display: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await writeFile(resolveAppPaths({ rootDir: h.rootDir }).configFile, '{invalid json', 'utf8');
    applied.resolve(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('已回滚');
    expect(card).not.toContain('未做任何修改');
    expect(card).not.toContain('偏好已保存');
  });

  it('switches the model channel to seedx and reconnects after in-flight runs', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', { agent_launcher: 'seedx' });

    const root = await waitForRoot(h.rootDir, (r) => r.profiles.claude?.agentLauncher !== undefined);
    expect(root.profiles.claude?.agentLauncher).toEqual({ kind: 'seedx' });
    expect(preflightMocks.checkAgentAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'seedx' }),
    );
    await vi.waitFor(() => expect(h.controls.restart).toHaveBeenCalledWith({ wait: true }));
    expect(JSON.stringify(h.channel.sent)).toContain('seedx(公司 AI 网关)');
  });

  it('refuses to switch to seedx when seedx is not available', async () => {
    vi.useFakeTimers();
    preflightMocks.checkAgentAvailability.mockResolvedValueOnce({
      ok: false,
      error: new Error('seedx: command not found'),
      diagnostic: {},
    });
    const h = await createHarness();

    await h.command('/config submit', { agent_launcher: 'seedx', message_reply: 'text' });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(h.channel.sent.length).toBeGreaterThan(0));

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.agentLauncher).toBeUndefined();
    expect(root.profiles.claude?.preferences.messageReply).not.toBe('text');
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('seedx 不可用');
    expect(card).toContain('command not found');
    expect(h.controls.restart).not.toHaveBeenCalled();
  });

  it('switches back to direct and reconnects; an unchanged seedx keeps its binaryPath without reconnecting', async () => {
    vi.useFakeTimers();
    const h = await createHarness({ agentLauncher: { kind: 'seedx', binaryPath: '/opt/seedx' } });

    await h.command('/config submit', { agent_launcher: 'seedx', message_reply: 'text' });
    let root = await waitForRoot(h.rootDir, (r) => r.profiles.claude?.preferences.messageReply === 'text');
    expect(root.profiles.claude?.agentLauncher).toEqual({ kind: 'seedx', binaryPath: '/opt/seedx' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.controls.restart).not.toHaveBeenCalled();
    expect(preflightMocks.checkAgentAvailability).not.toHaveBeenCalled();

    await h.command('/config submit', { agent_launcher: 'direct' });
    root = await waitForRoot(h.rootDir, (r) => r.profiles.claude?.agentLauncher === undefined);
    expect(root.profiles.claude).not.toHaveProperty('agentLauncher');
    await vi.waitFor(() => expect(h.controls.restart).toHaveBeenCalledWith({ wait: true }));
  });

  it('reconnects after in-flight runs when the claude driver changes', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', { claude_driver: 'headless' });

    const root = await waitForRoot(h.rootDir, (r) => r.profiles.claude?.preferences.claudeDriver === 'headless');
    expect(root.profiles.claude?.preferences.claudeDriver).toBe('headless');
    await vi.waitFor(() => expect(h.controls.restart).toHaveBeenCalledWith({ wait: true }));
  });

  it('does not reconnect when neither the driver nor the model channel changes', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', { claude_driver: 'pty', agent_launcher: 'direct', message_reply: 'text' });

    await waitForRoot(h.rootDir, (r) => r.profiles.claude?.preferences.messageReply === 'text');
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.stringify(h.channel.sent)).toContain('偏好已保存');
    expect(h.controls.restart).not.toHaveBeenCalled();
  });

  it('saves /account submit into the active v2 profile and profile-local keystore', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/account submit', {
      app_id: 'cli_new',
      app_secret: 'new-secret',
      tenant: 'lark',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.accounts.app.id === 'cli_new',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.accounts.app).toMatchObject({
      id: 'cli_new',
      tenant: 'lark',
      secret: {
        source: 'exec',
        provider: 'bridge',
        id: secretKeyForApp('cli_new'),
      },
    });
    expect(root.secrets?.providers?.bridge?.command).toContain('secrets-getter');
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
    await expect(
      getSecret(secretKeyForApp('cli_new'), resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' })),
    ).resolves.toBe('new-secret');
    const claudePaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' });
    const codexPaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'codex-dev' });
    expect(claudePaths.secretsFile).not.toBe(codexPaths.secretsFile);
    await expect(
      listSecretIds(codexPaths),
    ).resolves.not.toContain(secretKeyForApp('cli_new'));
  });
});

async function createHarness(opts: { agentLauncher?: ProfileConfig['agentLauncher'] } = {}): Promise<{
  rootDir: string;
  channel: ReturnType<typeof createFakeChannel>;
  controls: Controls;
  command(content: string, formValue?: Record<string, unknown>): Promise<boolean>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-profile-config-command-'));
  roots.push(rootDir);
  const workspace = join(rootDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const root = await writeRoot(rootDir, workspace, opts.agentLauncher);
  const profileConfig = root.profiles.claude!;
  const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
  const channel = createFakeChannel();
  const sessions = new SessionStore(appPaths.sessionsFile);
  const workspaces = new WorkspaceStore(appPaths.workspacesFile);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-admin',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: appPaths.configFile,
    cfg: runtimeProfileConfig(root, 'claude'),
    processId: 'proc-1',
  } satisfies Controls;

  return {
    rootDir,
    channel,
    controls,
    command: (content: string, formValue?: Record<string, unknown>) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent: new FakeAgentAdapter(),
        activeRuns: new ActiveRuns(),
        controls,
        formValue,
        fromCardAction: true,
      }),
  };
}

async function writeRoot(
  rootDir: string,
  workspace: string,
  agentLauncher?: ProfileConfig['agentLauncher'],
): Promise<RootConfig> {
  const root: RootConfig = {
    schemaVersion: 2,
    activeProfile: 'claude',
    preferences: {},
    profiles: {
      claude: createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: {
          app: { id: 'cli_old', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        access: { admins: ['ou-admin'] },
      }),
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: {
          app: { id: 'cli_codex', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        codex: { binaryPath: 'codex' },
      }),
    },
  };
  root.profiles.claude!.workspaces.default = workspace;
  if (agentLauncher) root.profiles.claude!.agentLauncher = agentLauncher;
  await writeJson(resolveAppPaths({ rootDir }).configFile, root);
  await writeFile(join(rootDir, 'active-profile'), 'claude\n', 'utf8');
  return root;
}

async function readRoot(rootDir: string): Promise<RootConfig> {
  return JSON.parse(await readFile(resolveAppPaths({ rootDir }).configFile, 'utf8')) as RootConfig;
}

async function waitForRoot(
  rootDir: string,
  predicate: (root: RootConfig) => boolean,
): Promise<RootConfig> {
  let lastRoot = await readRoot(rootDir);
  await vi.waitFor(async () => {
    lastRoot = await readRoot(rootDir);
    expect(predicate(lastRoot)).toBe(true);
  }, { timeout: 5000 });
  return lastRoot;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function appliedLarkCliIdentities(): unknown[] {
  return (
    identityPolicyMocks.applyLarkCliIdentityPolicy.mock.calls as unknown as Array<[unknown, unknown]>
  ).map((call) => call[1]);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
