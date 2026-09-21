export type TenantBrand = 'feishu' | 'lark';

/**
 * SecretRef points at a secret stored outside this file — keeps secrets out
 * of `config.json` so backups / accidental git commits / log dumps don't
 * leak the bot's App Secret. Matches lark-cli's `SecretRef` shape so
 * `--source lark-channel` reads it through the same generic
 * `ResolveSecretInput` pipeline.
 *
 *   - `env`:  value is in process env at `id` (optionally allowlisted via provider)
 *   - `file`: value is at the path `id` (or `provider.path` if provider config)
 *   - `exec`: spawn `provider.command`, send JSON over stdin, read JSON from stdout
 */
export interface SecretRef {
  source: 'env' | 'file' | 'exec';
  provider?: string;
  id: string;
}

/** A secret field can be either a plain string (potentially a `${VAR}`
 * template) or a SecretRef. JSON deserializer accepts both forms. */
export type SecretInput = string | SecretRef;

export interface AppCredentials {
  id: string;
  secret: SecretInput;
  tenant: TenantBrand;
}

/**
 * `secrets.providers` declares how SecretRefs resolve to plaintext (env
 * allowlist, file path, exec command). Only the fields actually consumed by
 * bridge's resolver are typed here; lark-cli reads the same JSON via its
 * richer Go types.
 */
export interface ProviderConfig {
  source: 'env' | 'file' | 'exec';
  /** env: allowlist of env var names that ref.id is allowed to be in. */
  allowlist?: string[];
  /** file: optional base path; ref.id is joined onto it. */
  path?: string;
  /** exec: command to spawn + args. */
  command?: string;
  args?: string[];
  /** exec: explicit env to inject (key=value pairs). */
  env?: Record<string, string>;
  /** exec: env var names to pass through from parent env. */
  passEnv?: string[];
  /** exec: max ms to wait for the child. */
  noOutputTimeoutMs?: number;
  /** exec: max stdout bytes accepted before treating as runaway. */
  maxOutputBytes?: number;
}

export interface SecretsConfig {
  providers?: Record<string, ProviderConfig>;
  defaults?: { env?: string; file?: string; exec?: string };
}

/**
 * How replies are rendered in IM chats:
 *   - `card`: full interactive card (tool panels, ⏹ button, footer status)
 *   - `markdown`: lightweight streaming markdown card (typewriter, no buttons)
 *   - `text`: plain markdown post sent once at run completion (no streaming)
 *
 * Pre-0.1.27 only had `card` and `text`, where `text` meant what's now called
 * `markdown`. See `messageReplyMigrated` for the auto-coercion logic.
 */
export type MessageReplyMode = 'card' | 'markdown' | 'text';

/** Tool-call rendering mode. See `AppPreferences.toolCallDisplay`. */
export type ToolCallDisplay = 'full' | 'compact' | 'hide';

const CLAUDE_DRIVER_OPTIONS = ['pty', 'headless'] as const;
export type ClaudeDriver = (typeof CLAUDE_DRIVER_OPTIONS)[number];

/**
 * Access control settings. Empty lists are fail-closed in the v2 policy:
 * no DM senders, no group chats, and only the runtime owner can administer
 * the bot. Runtime owner/admin bypass is applied by the policy layer because
 * owner identity is refreshed from Lark rather than stored in config.json.
 */
export interface AppAccess {
  /** open_id allowlist for DM senders. Group senders are gated by chat. */
  allowedUsers?: string[];
  /** chat_id allowlist for groups the bot responds in. Does not apply to p2p. */
  allowedChats?: string[];
  /** open_id list with admin privileges. Gates sensitive commands
   * (/account, /config, /exit, /reconnect, /doctor, /cd, /ws, /doc,
   * /invite, /remove). */
  admins?: string[];
}

export interface AppPreferences {
  /** Reply rendering mode for IM (group/p2p) messages. Default 'card'. */
  messageReply?: MessageReplyMode;
  /**
   * Internal marker: pre-0.1.27 the value `'text'` meant "lightweight
   * streaming markdown card" (what's now called `'markdown'`). On upgrade
   * we'd silently switch those users to true plain-text behavior unless we
   * coerce; this flag is set the first time the user submits `/config`
   * after the rename, indicating their `messageReply` value is in the
   * new semantic.
   */
  messageReplyMigrated?: boolean;
  /**
   * Whether to render tool-call blocks (Bash / Read / Edit / ...) in the
   * output. Legacy boolean — superseded by `toolCallDisplay`. Kept so
   * upgrades from pre-tri-state configs keep working; `getToolCallDisplay`
   * coerces `false` → `'hide'` when `toolCallDisplay` is unset (a legacy
   * `true` falls through to the `'compact'` default).
   */
  showToolCalls?: boolean;
  /**
   * Whether the bot replies in-thread (starts/continues a 话题) in regular
   * (non-topic) group chats. Default true. Topic-mode groups always thread
   * regardless; p2p never threads. Set false to keep flat quoted replies.
   */
  replyInThreadInGroup?: boolean;
  /**
   * Whether bridge auto-injects the message a thread hangs off (the thread
   * root) as context on the first turn of each threaded session. Default
   * true. Applies wherever a message carries a thread — Feishu topic groups
   * AND ordinary groups where someone opened a thread under an existing
   * message (the common alert-bot case). Set false to keep prompts minimal;
   * users can still reply-quote the root by hand.
   */
  threadRootContext?: boolean;
  /**
   * How tool-call blocks render in the card. Tri-state:
   *   - `full`     : header + collapsible body (input args + truncated output)
   *   - `compact`  : header-only one-liners (icon + tool name + short summary)
   *   - `hide`     : skip tool blocks entirely
   *
   * Default `compact` — uniform header-only one-liners. `full` adds the
   * collapsible input/output bodies (handy in p2p where noise is fine, but
   * its per-group folding looks inconsistent across turns). `hide` keeps the
   * card empty during long tool sequences — only use when the user truly
   * only cares about the final answer.
   */
  toolCallDisplay?: ToolCallDisplay;
  /**
   * Optional override for group / topic chats. When unset, falls back to
   * `toolCallDisplay`. Lets users e.g. keep `full` in p2p (where noise is
   * acceptable) while picking `compact` for groups (where it isn't).
   */
  toolCallDisplayInGroups?: ToolCallDisplay;
  /**
   * Cap on concurrent claude runs across all chats / topics. Excess runs
   * queue FIFO. Default 10. Mostly relevant for topic groups where each
   * topic can spawn its own run; capping protects RAM / token spend.
   */
  maxConcurrentRuns?: number;
  /**
   * Global default idle-timeout for claude runs, in minutes. When set,
   * if claude emits no stream event for this long the bridge kills the
   * run as presumed-hung. Undefined / 0 = no timeout (the default — runs
   * can hang indefinitely). Per-scope `/timeout` overrides this.
   */
  runIdleTimeoutMinutes?: number;
  /**
   * Hard hang ceiling for a claude turn, in minutes: if claude's JSONL stays
   * silent this long *while no tool is in flight*, the turn is presumed hung
   * and ends (failed) so the chat can't lock forever. Unlike
   * `runIdleTimeoutMinutes` this cannot be disabled by an idle check-in — it
   * is the last-resort safety net. Default 15; range [1, 120]. 0 disables.
   */
  turnSilenceTimeoutMinutes?: number;
  /**
   * Absolute wall-clock cap for a single claude turn, in minutes — a blunt
   * backstop for a genuinely hung *tool* (in flight forever, so the silence
   * ceiling never fires). Off by default (0) because a legitimate long
   * agentic turn keeps writing JSONL and shouldn't be clock-killed. Range
   * [1, 720] when set.
   */
  turnMaxMinutes?: number;
  /**
   * Auto-rotate a claude session before resume when its JSONL exceeds this
   * many bytes: the bridge abandons the bloated session and starts a fresh
   * one (old file kept on disk, same as `/new`). Huge sessions make resume /
   * boot slow and fragile. Default 2_000_000 (~2 MB). 0 disables.
   */
  sessionRotateMaxBytes?: number;
  /**
   * Whether the bot only responds to messages that @-mention it in groups
   * (regular and topic groups). p2p is always unrestricted. Default true:
   * groups are quiet unless the user @bot. Set false to let any group
   * message reach Claude (the 0.1.21-and-earlier behavior).
   *
   * @全员 is never responded to regardless (SDK `respondToMentionAll: false`).
   * Cloud-doc comments still require @-mention unconditionally.
   */
  requireMentionInGroup?: boolean;
  /** Access control — user/chat allowlists + admin gating. See AppAccess. */
  access?: AppAccess;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when killing the claude
   * subprocess. Bumped from a hardcoded 500ms because claude often has its
   * own subprocesses (e.g. lark-cli mid-OAuth) that need a moment to clean
   * up — too short a window and the SIGKILL cascade kills the descendants
   * before they can finish what the user is waiting on. Default 5000ms.
   * Range 100-30000; out-of-range values fall back to default.
   */
  agentStopGraceMs?: number;
  /**
   * In p2p (private) chats, launch claude in `bypassPermissions` so it never
   * emits a per-tool permission prompt — the owner is the only participant, so
   * per-tool approval is pure friction. Default `true`. Set `false` to fall
   * back to the access-tier-resolved permission mode in p2p as well. Groups /
   * topics are unaffected by this flag.
   */
  claudeP2pAutoApprove?: boolean;
  /**
   * How claude is driven. `pty` (default) uses a long-lived pseudo-terminal
   * with JSONL log tailing; `headless` uses `claude -p --output-format
   * stream-json` (one process per turn, no TUI interactions).
   */
  claudeDriver?: ClaudeDriver;
}

/**
 * Top-level config shape on disk.
 *
 * `accounts` is a namespace for credential-flavored fields (currently just
 * the bot app, room for OAuth / alternate apps later). `preferences`
 * holds user-tunable behavior knobs. Other future sections (mcp, etc.)
 * belong at this top level alongside them.
 */
export interface AppConfig {
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences?: AppPreferences;
}

export function isComplete(cfg: Partial<AppConfig>): cfg is AppConfig {
  const app = cfg.accounts?.app;
  return Boolean(app?.id && hasSecret(app?.secret) && app?.tenant);
}

function hasSecret(s: SecretInput | undefined): boolean {
  if (!s) return false;
  if (typeof s === 'string') return s.length > 0;
  return Boolean(s.source && s.id);
}

/** True iff this credential's secret is stored externally (env/file/exec). */
export function isSecretRef(s: SecretInput): s is SecretRef {
  return typeof s === 'object' && s !== null;
}

/** Account/keystore key for the bot's App Secret. lark-cli also uses a
 * similar `appsecret:` convention so audit/grep is consistent. */
export function secretKeyForApp(appId: string): string {
  return `app-${appId}`;
}

/**
 * Resolve the message-reply preference with default fallback + legacy coerce.
 *
 * Pre-0.1.27 users with `messageReply: 'text'` actually wanted the streaming
 * markdown card (the new `'markdown'`). Until they re-submit `/config`
 * (which sets `messageReplyMigrated: true`), we map their `text` →
 * `markdown` so the behavior stays the same after upgrade.
 *
 * Default for fresh configs (no `messageReply` set) is `'markdown'`.
 */
export function getMessageReplyMode(cfg: AppConfig): MessageReplyMode {
  const raw = cfg.preferences?.messageReply;
  if (raw === 'text' && cfg.preferences?.messageReplyMigrated !== true) {
    return 'markdown';
  }
  if (raw === 'card' || raw === 'markdown' || raw === 'text') return raw;
  return 'markdown';
}

/**
 * Resolve the tool-call display mode for a given chat scope.
 *
 * Precedence:
 *   1. `toolCallDisplayInGroups` if `isGroup` and the field is set.
 *   2. `toolCallDisplay` if set.
 *   3. Legacy `showToolCalls === false` → `'hide'` (explicit opt-out wins).
 *   4. Default `'compact'` — header-only one-liners. Picked over `'full'`
 *      because full panels render inconsistently depending on how claude
 *      batches its tool calls (contiguous ≥3 fold; interleaved-with-text
 *      singletons spill the command inline), which read as "randomly
 *      expanded". `compact` is uniform regardless of batching. A legacy
 *      `showToolCalls: true` also lands here — it only ever meant "show
 *      tools", which compact does.
 *
 * `isGroup` should be true for `'group'` / `'topic'` chat modes, false for
 * `'p2p'`. Callers in non-chat contexts (e.g. the `/config` form) can pass
 * `false` to read the base preference.
 */
export function getToolCallDisplay(cfg: AppConfig, isGroup: boolean): ToolCallDisplay {
  const prefs = cfg.preferences;
  if (isGroup && isValidToolCallDisplay(prefs?.toolCallDisplayInGroups)) {
    return prefs!.toolCallDisplayInGroups!;
  }
  if (isValidToolCallDisplay(prefs?.toolCallDisplay)) {
    return prefs!.toolCallDisplay!;
  }
  if (prefs?.showToolCalls === false) return 'hide';
  return 'compact';
}

function isValidToolCallDisplay(v: unknown): v is ToolCallDisplay {
  return v === 'full' || v === 'compact' || v === 'hide';
}

/**
 * Resolve the show-tool-calls preference with default fallback.
 *
 * Retained for backward compatibility with callers that haven't migrated to
 * the tri-state `getToolCallDisplay`. Returns `false` only when the effective
 * mode is `'hide'`.
 */
export function getShowToolCalls(cfg: AppConfig): boolean {
  return getToolCallDisplay(cfg, false) !== 'hide';
}

/**
 * Resolve the claude driver mode. Default `'pty'` — the `!== 'headless'`
 * check makes older configs without the field inherit the default.
 *
 * - `pty`: long-lived PTY + JSONL tailing (supports AskUserQuestion,
 *   idle checkpoint, …)
 * - `headless`: `claude -p --output-format stream-json` (stateless,
 *   one process per turn, clean tool rendering)
 */
export function getClaudeDriver(cfg: AppConfig): ClaudeDriver {
  const v = cfg.preferences?.claudeDriver;
  if (v === 'headless') return 'headless';
  return 'pty';
}

/** Resolve the max-concurrent-runs preference with default + sanity clamp. */
export function getMaxConcurrentRuns(cfg: AppConfig): number {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 10;
  // Reasonable upper bound — at 50+ concurrent claudes the bot box is
  // probably already RAM-starved. Clamp to keep typos from killing the box.
  return Math.min(Math.floor(raw), 50);
}

/**
 * Resolve the require-mention-in-group preference. Default `true` — the
 * `!== false` check makes "undefined" (older configs that don't have the
 * field) inherit the new safer default automatically.
 */
export function getRequireMentionInGroup(cfg: AppConfig): boolean {
  if (cfg.preferences?.requireMentionInGroup !== undefined) {
    return cfg.preferences.requireMentionInGroup !== false;
  }
  const profileAccess = (cfg as AppConfig & {
    access?: { requireMentionInGroup?: boolean };
  }).access;
  if (profileAccess?.requireMentionInGroup !== undefined) {
    return profileAccess.requireMentionInGroup;
  }
  return true;
}

/**
 * Resolve the reply-in-thread-in-group preference. Default `true` — the
 * `!== false` check makes older configs without the field inherit the new
 * default. Only affects regular groups; topic groups thread unconditionally.
 */
export function getReplyInThreadInGroup(cfg: AppConfig): boolean {
  return cfg.preferences?.replyInThreadInGroup !== false;
}

/**
 * Resolve the thread-root-context preference. Default `true` — the `!== false`
 * check makes older configs without the field inherit the new default. Gates
 * injection for any threaded message; p2p never has a thread so it is never
 * affected.
 */
export function getThreadRootContext(cfg: AppConfig): boolean {
  return cfg.preferences?.threadRootContext !== false;
}

/**
 * Grace period before SIGKILL fallback when stopping a claude subprocess.
 * Returns ms. Defaults to 5000 (5 seconds). Clamps to [100, 30000] so a
 * typo can't either make stop() effectively SIGKILL-immediate or hang for
 * minutes.
 */
export function getAgentStopGraceMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
  return Math.min(30_000, Math.max(100, Math.floor(raw)));
}

/**
 * Resolve whether p2p chats auto-approve (run claude in bypassPermissions).
 * Default `true` — the `!== false` check makes older configs without the
 * field inherit the on-by-default behavior.
 */
export function getClaudeP2pAutoApprove(cfg: AppConfig): boolean {
  return cfg.preferences?.claudeP2pAutoApprove !== false;
}

/**
 * Resolve the global default idle-timeout in ms. Returns `undefined` when
 * disabled (the default). Clamps to [1, 120] minutes when set so a typo
 * can't lock the bot into a 1-second kill loop or wait forever to a number
 * the user didn't really mean.
 */
export function getRunIdleTimeoutMs(cfg: AppConfig): number | undefined {
  const raw = cfg.preferences?.runIdleTimeoutMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  const clamped = Math.min(Math.max(Math.floor(raw), 1), 120);
  return clamped * 60_000;
}

/**
 * Hard hang ceiling (ms) for a claude turn. Defaults to 15 min. A configured
 * value clamps to [1, 120] minutes; an explicit 0 disables it (opt-out only —
 * you have to ask for the bot to be able to hang forever again).
 */
export function getTurnSilenceTimeoutMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.turnSilenceTimeoutMinutes;
  if (raw === 0) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 15 * 60_000;
  const clamped = Math.min(Math.max(Math.floor(raw), 1), 120);
  return clamped * 60_000;
}

/**
 * Absolute per-turn wall-clock cap (ms). Off by default (0). A configured
 * value clamps to [1, 720] minutes.
 */
export function getTurnMaxMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.turnMaxMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  const clamped = Math.min(Math.max(Math.floor(raw), 1), 720);
  return clamped * 60_000;
}

/**
 * Byte size above which a claude session is rotated (fresh session) before
 * resume. Defaults to 2 MB. An explicit 0 disables rotation. A configured
 * value clamps to a floor of 512 KB so a typo can't rotate every turn.
 */
export function getSessionRotateMaxBytes(cfg: AppConfig): number {
  const raw = cfg.preferences?.sessionRotateMaxBytes;
  if (raw === 0) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 2_000_000;
  return Math.max(Math.floor(raw), 512_000);
}
