import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import { dirname, join } from 'node:path';
import { claudeCapability, codexCapability } from '../agent/capability';
import {
  buildAgentPrompt,
  type BridgePromptInteractiveCard,
  type BridgePromptMention,
  type BridgePromptQuotedMessage,
} from '../agent/prompt';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import { AskQuestionFlow } from './ask-question-flow';
import { handleCardAction } from '../card/dispatcher';
import { CallbackAuth } from '../card/callback-auth';
import { CallbackNonceStore } from '../card/callback-store';
import { renderCard, type RunCardRenderOptions } from '../card/run-renderer';
import { registerFeedbackCard } from '../card/feedback-store';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import type { Feedback, LedgerStore } from '../observability/ledger';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { renderText, type RenderTextOptions } from '../card/text-renderer';
import { tryHandleCommand, type Controls } from '../commands';
import type { AppConfig } from '../config/schema';
import {
  getAgentStopGraceMs,
  getClaudeP2pAutoApprove,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getReplyInThreadInGroup,
  getRunIdleTimeoutMs,
  getSessionRotateMaxBytes,
  getToolCallDisplay,
} from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, reportMetric, withTrace } from '../core/logger';
import { MediaCache, type LocalAttachment } from '../media/cache';
import {
  toPolicyAttachment,
  toPromptAttachment,
} from '../media/attachment';
import { canUseDm, canUseGroup } from '../policy/access';
import type { ScopeContext } from '../policy/run-policy';
import { createOwnerRefreshController } from '../policy/owner';
import { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns, type RunHandle } from './active-runs';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { shouldReplyInThread, replyQuoteTargetForMessage } from './thread-policy';
import { handleCommentMention } from './comments';
import { recordRunSessionEvent, startRunFlow } from './run-flow';
import { commandSessionCatalogIdentity } from './session-catalog-identity';
import { startKeepalive } from './keepalive';
import { PendingQueue } from './pending-queue';
import { ProcessPool } from './process-pool';
import { fetchQuotedContext, type QuotedContext } from './quote';
import { addWorkingReaction, removeReaction } from './reaction';
import { fetchKnownChats } from './lark-info';
import type { AppPaths } from '../config/app-paths';

const DEBOUNCE_MS = 600;
const STREAM_TERMINAL_GRACE_MS = 3000;
const REACTION_CLEANUP_GRACE_MS = 1000;

const BRIDGE_AGENT_INSTRUCTIONS = [
  '你在 bridge 进程中运行，普通 lark-cli 会继承 LARK_CHANNEL=1 并进入 bridge-bound 模式。',
  '不要 unset LARK_CHANNEL / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR，也不要用 env -u LARK_CHANNEL 绕回本机普通配置。',
  'Codex bridge 默认使用 danger-full-access 对齐 Claude bridge 的 bypassPermissions 行为，因此 lark-cli 应能像用户本机终端一样访问 keychain。',
  '如果提示 lark-channel context detected but not bound，停止当前操作并请用户重启 bridge 或运行 bridge doctor/preflight；不要改用普通 profile，不要自行 bind，也不要直接读取 config.json 里的账号或密钥。',
];

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

const SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: '/open-apis/wiki/v2/spaces/get_node',
  },
];

function codeFromObj(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const top = (m as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function urlFromObj(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const configUrl = (m as { config?: { url?: unknown } })?.config?.url;
  if (typeof configUrl === 'string') return configUrl;
  const requestPath = (m as { request?: { path?: unknown } })?.request?.path;
  return typeof requestPath === 'string' ? requestPath : undefined;
}

function isSuppressedSdkMessage(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === undefined) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart),
  );
}

export function shouldSuppressSdkErrorLog(args: unknown[]): boolean {
  return args.some(isSuppressedSdkMessage);
}

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  return {
    error: (...args: unknown[]) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: Controls;
  ledger?: LedgerStore;
  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'mediaDir'>;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, sessionCatalog, workspaces, controls, ledger } = deps;
  const activeRuns = new ActiveRuns();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  const executor = new RunExecutor({ agent, pool, activeRuns });

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg, deps.appPaths);
  const callbackNonceStore = deps.appPaths?.mediaDir
    ? new CallbackNonceStore(join(dirname(deps.appPaths.mediaDir), 'callback-nonces.json'))
    : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: [{ version: 1, secret: appSecret }],
        nonceStore: callbackNonceStore,
      })
    : undefined;
  const activePolicyFingerprints = new Map<string, string>();

  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain:
      cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    source: 'lark-channel-bridge',
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 30_000,
    // Route WS + REST through HTTPS_PROXY / HTTP_PROXY when set (no-op otherwise).
    respectProxyEnv: true,
  };

  const channel = createLarkChannel(opts);
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', { scope, batchSize: batch.length });
      try {
        const mode = await chatModeCache.resolve(channel, firstMsg.chatId);
        await runAgentBatch({
          channel,
          executor,
          sessions,
          sessionCatalog,
          workspaces,
          media,
          batch,
          controls,
          callbackAuth,
          activePolicyFingerprints,
          scope,
          mode,
          ledger,
        });
      } catch (err) {
        log.fail('flush', err);
      } finally {
        pending.unblock(scope);
        log.info('flush', 'end');
      }
    });
  });

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
        intakeMessage({
          channel,
          agent,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          pending,
          msg,
          controls,
          chatModeCache,
          executor,
          pool,
          ledger,
        }),
      ).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await handleCardAction({
          channel,
          evt,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          agent,
          processPool: pool,
          runExecutor: executor,
          controls,
          pending,
          chatModeCache,
          callbackAuth,
          callbackPolicyFingerprintForScope: (scope) => activePolicyFingerprints.get(scope),
          ledger,
        });
      }).catch((err) => log.fail('cardAction', err));
    },
    reaction: (evt) => {
      // 👍/👎 on a bot reply → record into the usage ledger. Feishu shows the
      // live count natively; we just mirror it for `/report`. Non-thumb
      // emojis and reactions on non-reply messages are ignored.
      if (!ledger) return;
      const dir: Feedback | undefined =
        evt.emojiType === 'THUMBSUP' ? 'up' : evt.emojiType === 'THUMBSDOWN' ? 'down' : undefined;
      if (!dir) return;
      const matched = ledger.recordReaction(evt.messageId, evt.operator.openId, dir, evt.action);
      if (matched) {
        log.info('ledger', 'reaction', { messageId: evt.messageId, dir, action: evt.action });
      }
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, async () => {
        await handleCommentMention({
          channel,
          evt,
          agent,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          executor,
          controls,
        }).catch((err) => log.fail('comment', err));
      }).catch((err) => log.fail('comment', err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      reportMetric('ws_reconnect', 1, { kind: 'ws' });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  await channel.connect();
  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.accounts.app.id,
  });
  await ownerRefresh.start();
  const knownChatsRefresh = startKnownChatsRefreshTimer(channel, controls);

  const identity = channel.botIdentity;
  // Late-bind the bot's own IM identity into the agent adapter so the system
  // prompt can state "this open_id is you" with the real value. Covers both
  // initial start and credential-swap reconnects (both go through here).
  if (identity?.openId) {
    agent.setBotIdentity?.({
      openId: identity.openId,
      ...(identity.name ? { name: identity.name } : {}),
    });
  }
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  return {
    channel,
    disconnect: async () => {
      activeRuns.pauseNewRuns('bridge-disconnect');
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      keepalive.stop();
      pending.cancelAll();
      const [disconnectResult, stopAllResult, ...flushResults] = await Promise.allSettled([
        channel.disconnect(),
        activeRuns.stopAll(),
        sessions.flush(),
        sessionCatalog?.flush(),
        callbackNonceStore?.flush(),
        workspaces.flush(),
      ]);
      if (stopAllResult.status === 'rejected') {
        log.fail('disconnect', stopAllResult.reason, { step: 'stopAll' });
      }
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: `flush-${idx}` });
        }
      }
      if (disconnectResult.status === 'rejected') {
        throw disconnectResult.reason;
      }
    },
  };
}

function startKnownChatsRefreshTimer(
  channel: LarkChannel,
  controls: Controls,
): { stop(): void } {
  const intervalMs = 30 * 60 * 1000;
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function sendNonAllowedGroupHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '当前群尚未加入响应列表，所以 bot 不会处理消息。\n' +
    'Bot owner/管理员可在本群发 /invite group 加入白名单。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
  executor: RunExecutor;
  pool: ProcessPool;
  ledger?: LedgerStore;
}

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    activeRuns,
    pending,
    msg,
    controls,
    chatModeCache,
    executor,
    pool,
    ledger,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const chatMode = await chatModeCache.resolve(channel, msg.chatId);
  const scope = chatMode === 'topic' && msg.threadId
    ? `${msg.chatId}:${msg.threadId}`
    : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  const accessDecision =
    msg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, msg.senderId)
      : canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId);
  if (!accessDecision.ok) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
      reason: accessDecision.reason,
    });
    if (msg.chatType !== 'p2p' && accessDecision.reason === 'denied-chat' && msg.mentionedBot) {
      void sendNonAllowedGroupHint(channel, msg.chatId, msg.messageId).catch((err) =>
        log.warn('intake', 'non-allowed-hint-failed', { err: String(err) }),
      );
    }
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. Slash commands are NOT exempt — the user
  // chose strict mode so the group stays uniformly quiet unless mentioned.
  // @全员 is already filtered by SDK (`respondToMentionAll: false`), so any
  // event reaching here is either targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    getRequireMentionInGroup(controls.cfg) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    return;
  }

  const handled = await tryHandleCommand({
    channel,
    msg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent,
    activeRuns,
    sessionCatalog,
    sessionCatalogIdentity: await commandSessionCatalogIdentity({
      msg,
      scope,
      mode: chatMode,
      workspaces,
      controls,
      access: accessDecision,
    }),
    runExecutor: executor,
    processPool: pool,
    controls,
    ledger,
  });
  if (handled) {
    const dropped = pending.cancel(scope);
    log.info('intake', 'command', { scope, droppedPending: dropped.length });
    return;
  }

  const size = pending.push(scope, msg);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}

interface RunBatchDeps {
  channel: LarkChannel;
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  callbackAuth?: CallbackAuth;
  activePolicyFingerprints: Map<string, string>;
  scope: string;
  mode: ChatMode;
  ledger?: LedgerStore;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    executor,
    sessions,
    sessionCatalog,
    workspaces,
    media,
    batch,
    controls,
    callbackAuth,
    activePolicyFingerprints,
    scope,
    mode,
    ledger,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await media.resolve(resourceItems, controls.profileConfig.attachments);
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
    for (const attachment of attachments) {
      log.info('attachment', 'decision', {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason,
      });
    }
  }

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => replyQuoteTargetForMessage(m))
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  const prompt = buildPrompt(batch, attachments, quotes, channel.botIdentity);
  log.info('prompt', 'built', { promptChars: prompt.length, quotes: quotes.length });

  // Thread the reply when policy says so: topic groups (when the message is
  // in a thread) and regular groups when the operator toggle is on. p2p never
  // threads. All downstream send/stream sites reuse this single sendOpts.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(shouldReplyInThread(mode, threadId, getReplyInThreadInGroup(controls.cfg))
      ? { replyInThread: true }
      : {}),
  };

  const accessDecision =
    firstMsg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, firstMsg.senderId)
      : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId);
  const scopeContext: ScopeContext = {
    source: 'im',
    chatId,
    actorId: firstMsg.senderId,
    ...(threadId ? { threadId } : {}),
  };
  const capability =
    controls.profileConfig.agentKind === 'codex'
      ? codexCapability(controls.profileConfig)
      : claudeCapability(controls.profileConfig);
  const flow = await startRunFlow({
    scopeId: scope,
    scope: scopeContext,
    prompt,
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
    capability,
    profileConfig: controls.profileConfig,
    sessions,
    sessionCatalog,
    workspaces,
    executor,
    now: Date.now(),
    chatMode: mode,
    claudeP2pAutoApprove: getClaudeP2pAutoApprove(controls.cfg),
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    sessionRotateMaxBytes: getSessionRotateMaxBytes(controls.cfg),
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'im',
      stage: 'submit',
    },
  });
  if (!flow.ok) {
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', {
      scope,
      source: 'im',
      code: flow.rejectReason.code,
    });
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    return;
  }

  const { execution, cwdRealpath: cwd } = flow;
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  const handle = execution.handle;
  const eventStream = execution.subscribe();
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }
  const recordSession = (evt: AgentEvent): void => {
    recordRunSessionEvent({
      scopeId: scope,
      sessions,
      sessionCatalog,
      capability,
      policy: flow.policy,
      event: evt,
    });
    if (evt.type === 'system' && evt.sessionId) {
      log.info('session', 'set', { sessionId: evt.sessionId });
    }
    if (evt.type === 'system' && evt.threadId) {
      log.info('session', 'set-thread', { threadId: evt.threadId });
    }
  };

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });

  // Re-read prefs on every flush so toggling /config mid-stream takes effect
  // immediately (cheap lookups). Resolve tool-call display once per flush:
  // group override in group / topic chats, base pref in p2p. The renderer
  // applies the mode; `/config` changes take effect on the next user message.
  const isGroupChat = mode !== 'p2p';
  const toolDisplay = getToolCallDisplay(controls.cfg, isGroupChat);
  log.info('flush', 'tool-display', { mode: toolDisplay, isGroup: isGroupChat });
  const signOptions = callbackAuth
    ? {
        signCallback: (action: string) =>
          callbackAuth.sign({
            runId: execution.runId,
            scope,
            chatId,
            operatorOpenId: firstMsg.senderId,
            action,
            policyFingerprint: flow.policy.policyFingerprint,
            ttlMs: 24 * 60 * 60 * 1000,
          }),
      }
    : {};
  // Managed entity card render options (a function so a 👍/👎 click can
  // re-render with fresh counts). `toolDisplay` selects the tri-state tool
  // rendering; `staticMode` forces full-replace updates (managed cards don't
  // use SDK streaming_mode); `feedback` adds the 👍 N / 👎 M row on the
  // finished card (counts shared with native emoji reactions via the ledger).
  const cardRenderOptions = (counts?: { up: number; down: number }): RunCardRenderOptions => ({
    ...signOptions,
    toolDisplay,
    staticMode: true,
    ...(ledger ? { feedback: { entryId: execution.runId, ...(counts ? { counts } : {}) } } : {}),
  });
  const textRenderOptions: RenderTextOptions = { toolDisplay };

  // Bind an AskQuestionFlow to this run so the card dispatcher can route
  // AskUserQuestion button clicks back here. Only when callbackAuth is
  // available — without it, we can't sign the bridge_token the buttons need.
  if (callbackAuth && handle.run.answerQuestion) {
    handle.askQuestion = new AskQuestionFlow({
      run: handle.run,
      channel,
      chatId,
      sendOpts,
      signBridgeToken: (action: string) =>
        callbackAuth.sign({
          runId: execution.runId,
          scope,
          chatId,
          operatorOpenId: firstMsg.senderId,
          action,
          policyFingerprint: flow.policy.policyFingerprint,
          ttlMs: 24 * 60 * 60 * 1000,
        }),
    });
  }

  // For non-card modes Claude's output doesn't surface visually until either
  // a first streamed token (markdown mode) or the whole run ends (text mode).
  // Add a "Typing" reaction to the triggering message as an instant ack, but
  // never let that outbound API call block agent event draining.
  const reactionPromise =
    replyMode === 'card' ? undefined : addWorkingReaction(channel, lastMsg.messageId);

  // Captured for the usage ledger below, across whichever reply branch runs.
  // replyMessageId (the bot's reply message) attributes 👍/👎 reactions back
  // to this interaction. It's resolved via a promise so the ledger record in
  // `finally` can await it without racing the async stream-result capture.
  let finalRunState: RunState = initialState;
  let resolveReplyMessageId: (id: string | undefined) => void = () => {};
  const replyMessageIdReady = new Promise<string | undefined>((res) => {
    resolveReplyMessageId = res;
  });

  // Idle checkpoints (PtySession's 3/10/30-min check-ins) intentionally do NOT
  // send a card — a brand-new message per check-in fragmented the chat. The
  // event is still consumed in processAgentStream to disable the channel idle
  // watchdog so long-running turns aren't killed; it just renders nothing, so
  // no `onIdleCheckpoint` handler is passed below.

  try {
    if (replyMode === 'card') {
      // Managed CardKit entity card (createCard + updateCardById). Unlike the
      // inline streaming card, entity updates push live to clients and survive
      // button-click callbacks — so 👍/👎 vote counts refresh reliably. We
      // throttle updates during the run to stay under card-update rate limits.
      const { messageId } = await sendManagedCard(
        channel,
        chatId,
        renderCard(initialState, cardRenderOptions()),
        { ...(sendOpts.replyTo ? { replyTo: sendOpts.replyTo } : {}), ...(sendOpts.replyInThread ? { replyInThread: true } : {}) },
      );
      resolveReplyMessageId(messageId);
      const updater = new ManagedCardUpdater((card) => updateManagedCard(channel, messageId, card));
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state) => {
          finalRunState = state;
          updater.schedule(renderCard(state, cardRenderOptions()));
        },
        // AskUserQuestion continuation updates the ORIGINAL streaming card in
        // place instead of posting a new card — passing no `flushNewCard`
        // keeps processAgentStream from freezing + re-sending (see its body).
        undefined,
        // Idle checkpoints render nothing (see note above) — no handler.
        undefined,
      );
      finalRunState = finalState;
      await updater.flush(renderCard(finalState, cardRenderOptions()));
      // Register the feedback re-render so a 👍/👎 button click can refresh
      // the counts via the same reliable entity-update path.
      if (ledger && finalState.terminal === 'done') {
        registerFeedbackCard(messageId, {
          entryId: execution.runId,
          update: (counts) => updateManagedCard(channel, messageId, renderCard(finalState, cardRenderOptions(counts))),
        });
      }
    } else if (replyMode === 'markdown') {
      let latestState: RunState = initialState;
      let producerStarted = false;
      let markdownCtrl: { setContent(markdown: string): Promise<void> } | undefined;
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          finalRunState = state;
          if (markdownCtrl) {
            await markdownCtrl.setContent(renderText(state, textRenderOptions));
          }
        },
        undefined,
        undefined,
      );
      const streamDone = channel.stream(
        chatId,
        {
          markdown: async (ctrl) => {
            producerStarted = true;
            markdownCtrl = ctrl;
            await ctrl.setContent(renderText(latestState, textRenderOptions));
            await renderDone;
          },
        },
        sendOpts,
      );
      void streamDone
        .then((r) => resolveReplyMessageId((r as { messageId?: string } | undefined)?.messageId))
        .catch(() => resolveReplyMessageId(undefined));
      await awaitRenderAwareStream({
        mode: replyMode,
        streamDone,
        renderDone,
        producerStarted: () => producerStarted,
        fallback: async (state) => {
          const body = renderText(state, textRenderOptions);
          if (body.trim()) {
            const sent = await channel.send(chatId, { markdown: body }, sendOpts);
            resolveReplyMessageId((sent as { messageId?: string } | undefined)?.messageId);
          } else {
            resolveReplyMessageId(undefined);
          }
        },
      });
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post the final rendered text once as a plain markdown
      // (msg_type=post) message — no card, no streaming, no typewriter.
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async () => {},
        undefined,
        undefined,
      );
      finalRunState = finalState;
      const body = renderText(finalState, textRenderOptions);
      if (body.trim()) {
        const sent = await channel.send(chatId, { markdown: body }, sendOpts);
        resolveReplyMessageId((sent as { messageId?: string } | undefined)?.messageId);
      } else {
        resolveReplyMessageId(undefined);
      }
    }
  } catch (err) {
    log.fail('stream', err);
    // We may have failed before ever draining the event stream (e.g. sending
    // the reply card threw), leaving the run spinning with the scope locked.
    // Terminate it now — stop() is a no-op once the run has already finished.
    await execution.stop().catch((stopErr) => {
      log.warn('run', 'post-failure-stop-failed', {
        scope,
        err: stopErr instanceof Error ? stopErr.message : String(stopErr),
      });
    });
  } finally {
    activePolicyFingerprints.delete(scope);
    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);
    if (ledger) {
      const usage = finalRunState.usage;
      // Wait briefly for the reply message id (needed to attribute reactions);
      // don't hang the queue if the stream never surfaced one.
      const replyMessageId = await Promise.race([
        replyMessageIdReady,
        delay(1500).then(() => undefined),
      ]);
      ledger.record({
        id: execution.runId,
        openId: firstMsg.senderId,
        ...(firstMsg.senderName ? { name: firstMsg.senderName } : {}),
        chatId,
        chatKind: mode,
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        ...(replyMessageId ? { replyMessageId } : {}),
      });
      log.info('ledger', 'record', {
        scope,
        chatKind: mode,
        replyMessageId,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        costUsd: usage?.costUsd,
      });
    }
  }
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
 */
async function processAgentStream(
  handle: RunHandle,
  events: AsyncIterable<AgentEvent>,
  scope: string,
  idleTimeoutMs: number | undefined,
  recordSession: (event: AgentEvent) => void,
  flush: (state: RunState) => Promise<void>,
  /**
   * When provided and an `ask_user_question` event arrives mid-turn, the
   * current streaming card is finalized via `flush` and all subsequent
   * events are accumulated into a fresh `RunState`. On terminal, that
   * accumulated state is rendered via `flushNewCard` instead of updating
   * the original card — the user sees the post-answer reply as a new
   * message.
   */
  flushNewCard?: (state: RunState) => Promise<void>,
  /**
   * Fires when PtySession emits an `idle_checkpoint` (long turn going quiet).
   * Caller renders + sends a check-in card. The handler also permanently
   * disables this turn's channel-level idle watchdog — once the user has been
   * notified, further killing is user-driven via the card's [立即终止] button,
   * not by the channel timer.
   */
  onIdleCheckpoint?: (event: Extract<AgentEvent, { type: 'idle_checkpoint' }>) => Promise<void>,
): Promise<RunState> {
  const runStart = Date.now();
  let state: RunState = initialState;
  /** When defined, we're in the post-AskUserQuestion accumulation phase.
   * Events go here instead of into `state`; on terminal we render this as
   * a new card. Stays `undefined` for runs that never call AskUserQuestion. */
  let postAskState: RunState | undefined;

  // Idle watchdog: claude going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — claude can legitimately be silent for a long time when it's
  // waiting on a long-running tool call (e.g. `lark-cli` printing an
  // OAuth URL and blocking until the user clicks authorize). In that
  // case there's no event stream activity from claude itself, only the
  // tool subprocess running. We track which tool_use ids haven't matched
  // a tool_result yet, and pause the watchdog whenever the set is
  // non-empty.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  // Subset of `inFlightTools` that are `ask_user_question` tool_use_ids.
  // While non-empty, claude is intentionally waiting for the user to click
  // an option on a Lark interactive card; surfacing the idle-checkpoint
  // check-in card here would push that card down in the chat and confuse
  // the user. Suppress check-in dispatch (and keep the watchdog state
  // untouched) while this set is non-empty. Cleared by the matching
  // `tool_result` synthesized after the user's click.
  const pendingAskQuestions = new Set<string>();
  // Flipped on the first `idle_checkpoint` event of this turn: the user has
  // been (or is about to be) prompted via the check-in card, so the bridge
  // shouldn't unilaterally kill the run anymore. From here on, termination
  // happens only via the card's [立即终止] button (→ run.stop()) or a real
  // agent terminal event.
  let watchdogDisabled = false;
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs || watchdogDisabled) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  armOrPauseIdle();

  try {
    for await (const evt of events) {
      if (handle.interrupted) break;

      // Track tool flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use opens a window; tool_result
      // closes it. Other event types are bookkept after the if/else.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
        pendingAskQuestions.delete(evt.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      }
      armOrPauseIdle();

      if (evt.type === 'system') {
        recordSession(evt);
        continue;
      }
      if (evt.type === 'ask_user_question') {
        if (handle.askQuestion) {
          try {
            await handle.askQuestion.start(evt.id, evt.questions);
          } catch (err) {
            log.fail('agent', err, { event: 'ask-question-start' });
          }
        } else {
          log.warn('agent', 'ask-question-no-flow-bound', { toolUseId: evt.id });
        }
        // Treat the AskUserQuestion as a tool in-flight: claude is waiting
        // on the user. Adding to the set pauses the idle watchdog so the
        // user can take their time clicking. The matching `tool_result`
        // (synthesised by claude after the keystroke) clears it.
        // Also track in `pendingAskQuestions` so the idle-checkpoint handler
        // knows to stay silent while a click is outstanding.
        inFlightTools.add(evt.id);
        pendingAskQuestions.add(evt.id);
        armOrPauseIdle();
        // Finalize the streaming card now and start a fresh accumulator
        // for the post-answer phase, so claude's reply after the click
        // arrives as a *new* card via flushNewCard instead of being
        // appended to the in-progress one.
        if (flushNewCard && postAskState === undefined) {
          state = { ...state, terminal: 'done' as const, footer: null };
          await flush(state);
          postAskState = initialState;
        }
        continue;
      }
      if (evt.type === 'idle_checkpoint') {
        // Surface long-running turn status to the user. Don't terminate, don't
        // mutate the streaming card — the check-in card goes out as its own
        // new message. From now on the channel watchdog stays off for the
        // remainder of this turn (see `watchdogDisabled` declaration).
        //
        // Exception: when an `AskUserQuestion` card is awaiting the user's
        // click, claude is deliberately silent and a check-in card here
        // would only bury the question card in chat history. Stay silent
        // and leave the watchdog state untouched — when the user finally
        // clicks, claude resumes, the PtySession resets cadence on the next
        // JSONL entry, and check-ins behave normally again.
        const suppressedForAq = pendingAskQuestions.size > 0;
        log.info('agent', 'idle-checkpoint', {
          scope,
          checkpointNumber: evt.checkpointNumber,
          idleMs: evt.idleMs,
          inFlight: evt.snapshot.inFlightTools.map((t) => t.name),
          ...(suppressedForAq ? { suppressed: 'pending-ask-user-question' } : {}),
        });
        if (suppressedForAq) {
          continue;
        }
        if (!watchdogDisabled) {
          watchdogDisabled = true;
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
        }
        if (onIdleCheckpoint) {
          try {
            await onIdleCheckpoint(evt);
          } catch (err) {
            log.fail('agent', err, { event: 'idle-checkpoint' });
          }
        }
        continue;
      }
      if (evt.type === 'usage') {
        const { costUsd, inputTokens, outputTokens } = evt;
        // Usage now streams live (per turn) for the card's token footer, but
        // only the final authoritative event carries costUsd — log/report
        // metrics once on that one to avoid per-delta spam.
        if (costUsd !== undefined) {
          log.info('agent', 'usage', {
            costUsd: Number(costUsd.toFixed(4)),
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
          reportMetric('cost_usd', costUsd);
          if (inputTokens !== undefined) reportMetric('tokens_in', inputTokens);
          if (outputTokens !== undefined) reportMetric('tokens_out', outputTokens);
        }
        // Reduce + flush every event so the token footer updates in real time;
        // usage never changes footer/terminal, so no transition log is needed.
        state = reduce(state, evt);
        await flush(state);
        continue;
      }

      if (postAskState !== undefined) {
        // Post-AskUserQuestion phase: claude's reply belongs to a new card.
        // Accumulate into postAskState; the original streaming card stays
        // at its frozen "normal" terminal. On terminal, render postAskState
        // as a new card via flushNewCard. The streaming card never updates
        // again.
        const prev = postAskState;
        postAskState = reduce(postAskState, evt);
        if (postAskState.footer !== prev.footer || postAskState.terminal !== prev.terminal) {
          log.info('card', 'post-ask-transition', {
            footer: postAskState.footer,
            terminal: postAskState.terminal,
          });
        }
        if (postAskState.terminal !== 'running') {
          if (flushNewCard) {
            try {
              await flushNewCard(postAskState);
            } catch (err) {
              log.fail('agent', err, { event: 'flush-new-card' });
            }
          }
          break;
        }
        continue;
      }

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      // Stop iterating as soon as we have a terminal state. Some claude
      // versions don't close stdout immediately after the result event, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "claude finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { terminal: state.terminal, interrupted: handle.interrupted });
  reportMetric('run_e2e_ms', Date.now() - runStart, { terminal: state.terminal });
  await flush(state);
  if (handle.interrupted) {
    await handle.run.stop();
  }
  return state;
}

async function awaitRenderAwareStream(input: {
  mode: 'card' | 'markdown';
  streamDone: Promise<unknown>;
  renderDone: Promise<RunState>;
  producerStarted: () => boolean;
  fallback: (state: RunState) => Promise<void>;
}): Promise<void> {
  const streamResult = input.streamDone.then(
    () => ({ kind: 'stream' as const, ok: true as const }),
    (err) => ({ kind: 'stream' as const, ok: false as const, err }),
  );
  const renderResult = input.renderDone.then(
    (state) => ({ kind: 'render' as const, ok: true as const, state }),
    (err) => ({ kind: 'render' as const, ok: false as const, err }),
  );
  const first = await Promise.race([streamResult, renderResult]);
  if (!first.ok) {
    if (first.kind === 'stream') {
      log.fail('stream', first.err, { mode: input.mode, step: 'stream' });
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      await runFallbackReply(input.mode, rendered.state, input.fallback);
      return;
    }
    throw first.err;
  }

  if (first.kind === 'stream') {
    const rendered = await renderResult;
    if (!rendered.ok) throw rendered.err;
    return;
  }

  if (!input.producerStarted()) {
    log.warn('stream', 'producer-not-started-before-agent-terminal', { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return;
  }

  const terminal = await Promise.race([
    streamResult,
    delay(STREAM_TERMINAL_GRACE_MS).then(() => undefined),
  ]);
  if (!terminal) {
    log.warn('stream', 'terminal-grace-expired', {
      mode: input.mode,
      graceMs: STREAM_TERMINAL_GRACE_MS,
    });
    void streamResult.then((result) => {
      if (!result.ok) {
        log.fail('stream', result.err, { mode: input.mode, step: 'stream-terminal-late' });
      }
    });
    return;
  }
  if (!terminal.ok) throw terminal.err;
}

async function runFallbackReply(
  mode: 'card' | 'markdown',
  state: RunState,
  fallback: (state: RunState) => Promise<void>,
): Promise<void> {
  try {
    await fallback(state);
  } catch (err) {
    log.fail('stream', err, { mode, step: 'fallback' });
  }
}

function scheduleWorkingReactionCleanup(
  channel: LarkChannel,
  messageId: string,
  reactionPromise: Promise<string | undefined> | undefined,
): void {
  if (!reactionPromise) return;

  void (async () => {
    const reactionResult = reactionPromise.then(
      (reactionId) => ({ ok: true as const, reactionId }),
      (err) => ({ ok: false as const, err }),
    );
    const settled = await Promise.race([
      reactionResult,
      delay(REACTION_CLEANUP_GRACE_MS).then(() => undefined),
    ]);

    if (!settled) {
      log.warn('reaction', 'cleanup-deferred', {
        messageId,
        graceMs: REACTION_CLEANUP_GRACE_MS,
      });
      void reactionResult.then((result) => {
        if (!result.ok || !result.reactionId) return;
        void removeReaction(channel, messageId, result.reactionId);
      });
      return;
    }

    if (!settled.ok || !settled.reactionId) return;
    await removeReaction(channel, messageId, settled.reactionId);
  })();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Coalescing, serialized, time-throttled updater for a managed entity card.
 * During a run the agent flushes on every token, but entity card updates are
 * rate-limited — so we keep only the newest render and send at most one
 * update per `minIntervalMs`. `flush()` forces the final state through and
 * awaits it. Sends are chained (FIFO) so `updateCardById` sequence numbers
 * stay monotonic.
 */
class ManagedCardUpdater {
  private latest: object | undefined;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private lastAt = 0;

  constructor(
    private readonly send: (card: object) => Promise<void>,
    private readonly minIntervalMs = 350,
  ) {}

  schedule(card: object): void {
    this.latest = card;
    if (this.timer) return;
    const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fire();
    }, wait);
  }

  private fire(): void {
    const card = this.latest;
    if (card === undefined) return;
    this.latest = undefined;
    this.lastAt = Date.now();
    this.chain = this.chain
      .then(() => this.send(card))
      .catch((err: unknown) => log.fail('card', err, { step: 'managed-throttled-update' }));
  }

  async flush(card: object): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.latest = card;
    this.fire();
    await this.chain;
  }
}

function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
  botIdentity?: { openId: string; name?: string },
): string {
  const first = batch[0];
  if (!first) return '';

  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  // When the debounce window merged messages (possibly from several senders —
  // common in bot-at-bot group chats), annotate each segment with its sender
  // so the agent can tell who said what. Single-message batches stay verbatim.
  const annotate = batch.length > 1;
  const texts = batch
    .map((m) => {
      const text = stripAttachmentRefs(m.content, fileKeys).trim();
      if (!text) return '';
      return annotate ? `${senderAnnotation(m)} ${text}` : text;
    })
    .filter(Boolean);
  const userPart =
    texts.length > 0
      ? texts.join('\n\n')
      : attachments.length > 0
        ? '请看下面的附件。'
        : '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';

  const senderType = senderTypeOf(first);
  const mentions = mergeMentions(batch);

  return buildAgentPrompt({
    context: {
      chatId: first.chatId,
      chatType: first.chatType,
      senderId: first.senderId,
      ...(first.senderName ? { senderName: first.senderName } : {}),
      ...(senderType ? { senderType } : {}),
      ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(first.threadId ? { threadId: first.threadId } : {}),
      messageIds: batch.map((m) => m.messageId),
      source: 'im',
    },
    instructions: BRIDGE_AGENT_INSTRUCTIONS,
    userInput: userPart,
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
  });
}

/**
 * Classify the sender as human or bot from the raw Feishu event
 * (`sender.sender_type`: 'user' = human, 'app' = bot). The normalizer drops
 * this field, so read it off `msg.raw` (`includeRawEvent: true` above).
 * Unknown / missing values return undefined — omit rather than guess.
 */
function senderTypeOf(msg: NormalizedMessage): 'user' | 'bot' | undefined {
  const raw = msg.raw as { sender?: { sender_type?: unknown } } | undefined;
  const senderType = raw?.sender?.sender_type;
  if (senderType === 'user') return 'user';
  if (senderType === 'app' || senderType === 'bot') return 'bot';
  return undefined;
}

function senderAnnotation(msg: NormalizedMessage): string {
  const name = msg.senderName ?? msg.senderId;
  const type = senderTypeOf(msg);
  return type ? `[${name} (${type})]:` : `[${name}]:`;
}

function mergeMentions(batch: NormalizedMessage[]): BridgePromptMention[] {
  const seen = new Set<string>();
  const out: BridgePromptMention[] = [];
  for (const msg of batch) {
    for (const mention of msg.mentions ?? []) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ''}:${mention.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        ...(mention.openId ? { openId: mention.openId } : {}),
        ...(mention.name ? { name: mention.name } : {}),
        ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
      });
    }
  }
  return out;
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptInteractiveCard(m: NormalizedMessage): BridgePromptInteractiveCard | undefined {
  if (m.rawContentType !== 'interactive') return undefined;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return undefined;
  return {
    messageId: m.messageId,
    content: parseJsonOrRaw(rawContent),
  };
}

function parseJsonOrRaw(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
