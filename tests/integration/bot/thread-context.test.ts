import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
        message: { list: ReturnType<typeof vi.fn> };
      };
    };
  };
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}


const SELF_APP_ID = 'cli_test';

/** Mirrors what `im.v1.message.list` returns for a thread: host at -1. */
const DEFAULT_THREAD_ITEMS = [
  {
    message_id: 'om_host',
    msg_type: 'interactive',
    thread_message_position: '-1',
    create_time: '1760000000000',
    sender: { id: 'cli_alertbot', id_type: 'app_id', sender_type: 'app' },
    body: {
      content: JSON.stringify({
        body: {
          direction: 'vertical',
          elements: [
            {
              tag: 'markdown',
              content: '应用 X 普通预警',
              element_id: '_2',
              background_style: 'grey-100',
            },
          ],
        },
      }),
    },
  },
  {
    message_id: 'om_peer',
    msg_type: 'text',
    thread_message_position: '0',
    create_time: '1760000001000',
    sender: { id: 'ou_peer', id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: '别人的补充' }) },
  },
  {
    message_id: 'om_selfreply',
    msg_type: 'interactive',
    thread_message_position: '1',
    create_time: '1760000002000',
    sender: { id: SELF_APP_ID, id_type: 'app_id', sender_type: 'app' },
    body: {
      content: JSON.stringify({
        body: { elements: [{ tag: 'markdown', content: '我之前的回复' }] },
      }),
    },
  },
];

/** A message inside the alert thread; `threadId: undefined` makes it flat. */
function threadMsg(input: {
  messageId: string;
  content: string;
  threadId?: string | undefined;
  parentId?: string;
}): NormalizedMessage {
  const threadId = 'threadId' in input ? input.threadId : 'omt_topic';
  return message({
    messageId: input.messageId,
    rootId: 'om_host',
    parentId: input.parentId ?? 'om_host',
    ...(threadId ? { threadId } : {}),
    content: input.content,
  });
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('thread context injection', () => {
  it('injects the whole thread, host first, on the first turn', async () => {
    const h = await createHarness();

    await startTestBridge(h);
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_at', content: '@Bridge 分析告警' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<thread_context>');
    expect(prompt).toContain('应用 X 普通预警');
    expect(prompt).toContain('"isHost":true');
    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          container_id_type: 'thread',
          container_id: 'omt_topic',
        }),
      }),
    );
  });

  it('extracts card text rather than dumping the card JSON', async () => {
    const h = await createHarness();

    await startTestBridge(h);
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_at', content: '@Bridge 分析告警' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('应用 X 普通预警');
    expect(prompt).not.toContain('background_style');
    expect(prompt).not.toContain('element_id');
  });

  it("leaves out the bridge bot's own replies", async () => {
    const h = await createHarness();

    await startTestBridge(h);
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_at', content: '@Bridge 分析告警' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).not.toContain('我之前的回复');
    expect(prompt).toContain('别人的补充');
  });

  it('does not re-fetch the thread on later turns of the same session', async () => {
    const h = await createHarness();

    await startTestBridge(h);
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_t1', content: '@Bridge 分析告警' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_t2', content: '@Bridge 影响面呢' }));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.agent.runOptions[1]?.prompt ?? '').not.toContain('<thread_context>');
    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after /new resets the session', async () => {
    const h = await createHarness();

    await startTestBridge(h);
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_t1', content: '@Bridge 分析告警' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_new', content: '/new' }));
    await waitFor(() => !h.sessions.hasInjectedThreadContext('oc_topic_chat:omt_topic', 'omt_topic'));
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_t2', content: '@Bridge 再看' }));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.agent.runOptions[1]?.prompt ?? '').toContain('<thread_context>');
    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalledTimes(2);
  });

  // An ordinary group shares one scope across all of its threads, so a
  // scope-keyed marker used to make the first thread in a group suppress
  // every later one — the alert in thread #2 never reached the agent.
  it('injects for a second thread in the same group', async () => {
    const h = await createHarness({ chatMode: 'group' });

    await startTestBridge(h);
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_a', content: '@Bridge 分析告警' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(
      threadMsg({ messageId: 'om_b', content: '@Bridge 这个呢', threadId: 'omt_other' }),
    );
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.agent.runOptions[0]?.prompt ?? '').toContain('<thread_context>');
    expect(h.agent.runOptions[1]?.prompt ?? '').toContain('<thread_context>');
    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalledTimes(2);
  });

  it('skips injection when threadContext is disabled', async () => {
    const h = await createHarness({ preferences: { threadContext: false } });

    await startTestBridge(h);
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_at', content: '@Bridge 分析告警' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions[0]?.prompt ?? '').not.toContain('<thread_context>');
    expect(h.channel.rawClient.im.v1.message.list).not.toHaveBeenCalled();
  });

  it('does not inject for a message outside any thread', async () => {
    const h = await createHarness();

    await startTestBridge(h);
    await h.channel.handlers.message?.(
      threadMsg({ messageId: 'om_flat', content: '@Bridge 你好', threadId: undefined }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions[0]?.prompt ?? '').not.toContain('<thread_context>');
    expect(h.channel.rawClient.im.v1.message.list).not.toHaveBeenCalled();
  });

  //保真优先：拉取失败要让 agent 看见缺口，而不是当作话题是空的。
  it('reports a fetch failure in the prompt and retries next turn', async () => {
    const h = await createHarness({ failListOnce: true });

    await startTestBridge(h);
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_t1', content: '@Bridge 分析告警' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    const first = h.agent.runOptions[0]?.prompt ?? '';
    expect(first).toContain('<thread_context>');
    expect(first).toContain('thread list blew up');

    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_t2', content: '@Bridge 再试' }));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.agent.runOptions[1]?.prompt ?? '').toContain('应用 X 普通预警');
    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicit reply quote in quoted_messages, with no origin field', async () => {
    const h = await createHarness({ quotedMessages: { om_other: 'explicitly quoted' } });

    await startTestBridge(h);
    await h.channel.handlers.message?.(
      threadMsg({ messageId: 'om_at', content: '@Bridge 看这条', parentId: 'om_other' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<quoted_messages>');
    expect(prompt).toContain('explicitly quoted');
    expect(prompt).not.toContain('origin');
  });

  it('does not quote the thread host as if the user had pointed at it', async () => {
    const h = await createHarness();

    await startTestBridge(h);
    await h.channel.handlers.message?.(threadMsg({ messageId: 'om_at', content: '@Bridge 分析告警' }));
    await waitFor(() => h.agent.runOptions.length === 1);

    // host 走 thread_context，不该同时出现在 quoted_messages 里
    expect(h.agent.runOptions[0]?.prompt ?? '').not.toContain('<quoted_messages>');
  });
});

interface HarnessOptions {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  /** Merged into profileConfig.preferences — e.g. `{ threadContext: false }`. */
  preferences?: Record<string, unknown>;
  /** Make the first thread listing reject, to exercise the retry path. */
  failListOnce?: boolean;
  /** Override the fake thread listing. */
  threadItems?: unknown[];
}

async function createHarness(options: HarnessOptions = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('topic-quote-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_topic_chat'],
      allowedUsers: ['ou_user'],
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
    ...(options.preferences
      ? {
          preferences: {
            ...(baseProfileConfig as { preferences?: Record<string, unknown> }).preferences,
            ...options.preferences,
          },
        }
      : {}),
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(
  options: HarnessOptions = {},
): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const chatMode = options.chatMode ?? 'topic';
  const quotedMessages = options.quotedMessages ?? {
    om_topic_root: 'topic root content',
  };
  let listFailed = false;
  const threadItems = options.threadItems ?? DEFAULT_THREAD_ITEMS;
  const messageList = vi.fn(async () => {
    if (options.failListOnce && !listFailed) {
      listFailed = true;
      throw new Error('thread list blew up');
    }
    return { data: { items: threadItems, has_more: false } };
  });
  return {
    handlers,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
          message: { list: messageList },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
    listChats: vi.fn(async () => []),
    fetchRawMessage: vi.fn(async (messageId: string) => [
      {
        message_id: messageId,
        msg_type: 'text',
        body: {
          content: JSON.stringify({
            text: quotedMessages[messageId] ?? 'quoted content',
          }),
        },
        create_time: '1760000000000',
        sender: { id: 'ou_quote_sender' },
      },
    ]),
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return chatMode;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {},
    async stream(_chatId, input) {
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
    },
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(input: {
  messageId: string;
  rootId: string;
  parentId: string;
  threadId?: string;
  content: string;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_topic_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
    mentionAll: false,
    mentionedBot: true,
    rootId: input.rootId,
    parentId: input.parentId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    replyToMessageId: input.parentId,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
