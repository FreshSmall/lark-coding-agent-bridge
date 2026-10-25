# lark-coding-agent-bridge 模块地图

> 生成时间:2026-10-24。基于分支 `feat/topic-root-context` 的真实源码梳理(约 2.5 万行 TS)。
> 结论均定位到 `文件:行号` 与符号;标注【已确认】/【推断】/【待验证】。
> 配套文档:[feature-catalog.md](./feature-catalog.md)(业务功能清单)。

## 0. 全局架构鸟瞰

```
飞书开放平台 (WS 长连接)
      │  @larksuite/channel SDK
      ▼
┌─────────────────────────────── bridge 进程 (Node.js) ───────────────────────────────┐
│                                                                                      │
│  src/cli (主机命令) ──► src/cli/commands/start.ts#runStart                          │
│        │                    │                                                       │
│        ▼                    ▼                                                       │
│  src/daemon (OS 服务)   src/bot/channel.ts#startChannel  ◄── 总装配点                │
│                          │  ├─ intakeMessage ─► src/policy/access (ACL 门)           │
│                          │  ├─ tryHandleCommand ─► src/commands (斜杠命令)           │
│                          │  └─ PendingQueue (合批) ─► runAgentBatch                  │
│                          │        │                                                 │
│                          │        ▼                                                 │
│                          │  src/bot/run-flow.ts#startRunFlow                        │
│                          │   ├─ src/policy/workspace (cwd 校验)                     │
│                          │   ├─ src/policy/run-policy (运行策略+指纹)                │
│                          │   ├─ src/session (会话目录/续接)                          │
│                          │   └─ src/runtime/run-executor (并发/生命周期)              │
│                          │        │                                                 │
│                          │        ▼                                                 │
│                          │  src/agent (AgentAdapter: ClaudePty / ClaudeHeadless /  │
│                          │            Codex) ──► 外部子进程                          │
│                          │        │ AgentEvent 流                                   │
│                          │        ▼                                                 │
│                          └─ processAgentStream ─► src/card (RunState→渲染) ─► 飞书   │
│                                                                                      │
│  横切:src/config (profile/密钥) · src/core (日志/遥测) · src/observability (账本)     │
│        src/media (附件) · src/lark-cli (身份策略) · src/platform (spawn/原子写)       │
└──────────────────────────────────────────────────────────────────────────────────────┘
      │ 子进程                                    │ 子进程
      ▼                                           ▼
claude TUI (node-pty,每会话长驻)           codex exec --json (每 run 一个)
```

- 无 Web 界面:全仓库无 express/http server(已 grep 验证);"交互界面"是飞书卡片(CardKit)。
- 所有 bridge 逻辑在单一 Node.js 进程内;Agent 是外部子进程;守护进程由 OS(launchd/systemd/schtasks)拉起 bridge 自身。

---

## 1. `src/cli` — 主机 CLI 与程序初始化

| 项 | 内容 |
|---|---|
| 职责 | commander 命令注册、前台启动编排、OS 服务管理、profile 管理、首跑 bootstrap、lark-cli 预检 |
| 关键文件 | `src/cli/index.ts`(260 行,命令注册)、`src/cli/commands/start.ts`(611 行,`runStart`)、`service.ts`(475 行)、`profile.ts`(276 行)、`migrate.ts`(276 行)、`ps.ts`、`secrets.ts`(210 行)、`preflight.ts`(742 行)、`profile-bootstrap.ts`、`agent-detection.ts`、`prompt.ts` |
| 核心符号 | `runStart`(`src/cli/commands/start.ts:91`)、`createRuntimeAgent`(`start.ts:430`)、`runServiceStart`(`service.ts:269`)、`preFlightChecks`(`src/cli/preflight.ts:51`)、`checkLarkCli`(`preflight.ts:55`) |
| 上游调用者 | `bin/lark-channel-bridge.mjs` → `dist/cli.js`(tsup 入口 `src/cli/index.ts`,见 `tsup.config.ts:5`) |
| 下游依赖 | `bot/channel`、`agent/*`、`runtime/*`、`config/*`、`daemon/*`、`core/logger` |
| 对外能力 | 主机命令 `run / migrate / profile / ps / kill / start / stop / restart / status / unregister / secrets` |

初始化要点(已确认,`src/cli/commands/start.ts:91-398`):
1. `resolveProfileRuntime`(allowBootstrap)→ 2. `configureLogger` + `preFlightChecks`(lark-cli 自动安装/绑定)→ 3. `loadTelemetryAdapter` → 4. `createRuntimeAgent`(按 `agentKind` 与 `claudeDriver` 选适配器)→ 5. `withProfileAndAppLocks` 运行时锁 → 6. 初始化四个 Store(Session/Catalog/Workspace/Ledger)→ 7. `sameAppLiveOthers` 冲突检测 + `register` 进程注册 → 8. `makeControls`(含 `restart()` 热重连)→ 9. `startChannel` → 10. 信号钩子 + 挂起事件循环。
`controls.restart()` 是**进程内热重连**:先连新 bridge 成功再断旧的(connect-before-disconnect,`start.ts:285-338`),用于 `/account` 换凭据、`/reconnect`、keepalive 强制重连。

## 2. `src/bot` — 飞书事件接入与运行编排(最大模块,~4.4k 行)

### 2.1 `channel.ts`(1655 行,总装配点)

| 项 | 内容 |
|---|---|
| 核心符号 | `startChannel`(`src/bot/channel.ts:186`)、`intakeMessage`(`:528`)、`runAgentBatch`(`:649`)、`processAgentStream`(`:1097`)、`buildPrompt`(`:1514`)、`ManagedCardUpdater`(`:1472`,350ms 节流卡片更新)、`awaitRenderAwareStream`(`:1356`) |
| 事件接线 | `channel.on({ message, reject, cardAction, reaction, comment, reconnecting, reconnected, error })`(`:298-403`) |
| 上游 | `start.ts#runStart` / `controls.restart()` |
| 下游 | 几乎所有模块(见各节) |

消息主流程(已确认):
- `intakeMessage`:解析 scope(p2p/群=chatId;话题群=`chatId:threadId`,`:547-550`)→ ACL 门(`canUseDm`/`canUseGroup`)→ 群内 @bot 策略(`getRequireMentionInGroup`)→ `tryHandleCommand`(命令直接处理并清空该 scope 队列)→ 否则 `pending.push` 进合批队列。
- `runAgentBatch`(由 PendingQueue 触发):附件解析(`MediaCache.resolve`)→ 引用上下文(`fetchQuotedContext`)→ 话题上下文(`fetchThreadContext`,每 session 一次,`SessionStore.hasInjectedThreadContext`/`markThreadContextInjected` 把关)→ `buildPrompt` → 线程回复策略(`shouldReplyInThread`)→ `startRunFlow` → 按 `getMessageReplyMode` 分三路渲染(card/markdown/text)→ finally 记账(`LedgerStore.record`)。
- `processAgentStream`:把 `AgentEvent` 流 reduce 成 `RunState`,含通道级空闲看门狗(in-flight 工具暂停计时,`inFlightTools`/`pendingAskQuestions` 两个集合,`:1143-1174`)、AskUserQuestion 卡片冻结与续答新卡(`postAskState`,`:1291-1316`)、终态判定(idleFired > interrupted > finalize,`:1338-1346`)。

### 2.2 队列与并发

- `pending-queue.ts` — `PendingQueue`:按 scope 的 600ms 防抖合批;`block/unblock` 保证"每 scope 同时最多一个 run",运行期消息留到下一批(`src/bot/pending-queue.ts:23-102`)。
- `process-pool.ts` — `ProcessPool`:FIFO 全局并发上限,cap 每次读取 `getMaxConcurrentRuns(cfg)`,`/config` 改完下个 run 生效(`src/bot/process-pool.ts:17-60`)。
- `active-runs.ts` — `ActiveRuns`:scope 级运行句柄表 + 预订(reserve/register)、`interrupt()`、`stopAll()`、`pauseNewRuns('bridge-disconnect')`(`src/bot/active-runs.ts:15-108`)。`RunHandle` 上挂 `interrupted` 标志与可选 `askQuestion` 流。

### 2.3 run-flow.ts(265 行)

`startRunFlow`(`src/bot/run-flow.ts:90`):cwd 解析 → `evaluateRunPolicy` → 从 `SessionCatalog.activeFor`(按 scope+agent+cwd+fingerprint)或 `SessionStore.resumeFor` 决定续接 → 会话轮转(JSONL 超 `sessionRotateMaxBytes` 则弃续接,`:159-195`)→ `executor.submit`。`recordRunSessionEvent`(`:242`)把 `system` 事件里的 sessionId/threadId 写回两套存储。

### 2.4 上下文获取

- `thread-history.ts` — `fetchThreadContext`:拉整个话题(含 position -1 宿主消息),`DEFAULT_MAX_TOTAL_CHARS=20000`、单条 4000(`src/bot/thread-history.ts:8-9`)。
- `quote.ts` — `fetchQuotedContext`:逐条拉取用户显式引用的消息。
- `thread-policy.ts` — `shouldReplyInThread` / `replyQuoteTargetForMessage`(`src/bot/thread-policy.ts:12,30`)。

### 2.5 其他 bot 文件

- `comments.ts`(761 行)— `handleCommentMention`(`:84`):云文档评论入口,支持 fileType `doc/docx/sheet/file`(`:45`),自回复过滤、scope 推导(docSessionScopeId 等)。
- `chat-mode-cache.ts` — `ChatMode`:p2p/group/topic 三态缓存,一次 `chat.get`。
- `ask-question-flow.ts` — `AskQuestionFlow`:把 agent 的 `ask_user_question` 渲染成卡片并把按钮点击写回 PTY(见 §15)。
- `keepalive.ts` — `startKeepalive`:15s 探测 + 唤醒检测 + HTTP 可达性,失效则 `forceReconnect`(`src/bot/channel.ts:440-444`)。
- `wizard.ts` — `runRegistrationWizard`:QR 终端注册 PersonalAgent(`qrcode-terminal`)。
- `lark-info.ts`(`fetchKnownChats`)、`user-names.ts`(`resolveUserNames`)、`group.ts`(`createBoundChat`)、`reaction.ts`(typing 表情)、`session-catalog-identity.ts`、`scope.ts`、`comment-resource.ts`。

## 3. `src/agent` — Agent 适配层(~3.4k 行)

### 3.1 统一接口 `types.ts`(227 行)

`AgentAdapter`(id/displayName/isAvailable/run/closeSession/shutdown/setBotIdentity/prepareRun,`src/agent/types.ts:200-227`)、`AgentRun`(events 异步流 + stop/waitForExit/answerQuestion/resetIdleCheckpoint,`:147-188`)、`AgentEvent` 联合类型(system/text/thinking/tool_use/tool_result/idle_checkpoint/ask_user_question/usage/done/error,`:69-123`)。

### 3.2 Claude PTY 路径(默认)

| 文件 | 职责 | 关键符号 |
|---|---|---|
| `claude/pty-adapter.ts`(225 行) | 适配器;run() 内 acquire PTY → runTurn 生成器;stop→terminate | `ClaudePtyAdapter`(`:46`)、`spawnSession`(`:172`,args 含 `--permission-mode/--resume|--session-id/--append-system-prompt/--model`) |
| `claude/pty-pool.ts`(112 行) | sessionId→PtySession 池;30min 空闲回收(60s 扫描) | `ClaudePtyPool.acquire/release/reap`(`:37-110`) |
| `claude/pty-session.ts`(538 行) | 单会话驱动:consent 对话框自动应答(`CONSENT_DIALOGS`,`:67-75`)、就绪等待(`waitForReady`)、**写 prompt 到 PTY + 轮询磁盘 JSONL**(`runTurn`,`:326-455`)、AskUserQuestion 按键协议(`answerAskUserQuestion`,`:246-309`,含 bracketed-paste 规避)、软中断 ESC / 硬杀 SIGTERM→SIGKILL(`softInterrupt`/`terminate`/`hardClose`,`:494-537`)、空闲检查点(3/10/30min,`:83-87`)、挂死上限(`maxSilenceMs` 15min、`maxTurnMs` 默认关) | `PtySession` |
| `claude/pty.ts` | node-pty 薄封装 | `spawnPty` |
| `claude/jsonl-path.ts` | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` 路径 | `sessionJsonlPath` |
| `claude/jsonl-reader.ts` | 增量按行读 JSONL(游标 + 文件重建处理) | `JsonlReader.readNew/setCursor` |
| `claude/jsonl-translate.ts`(344 行) | 单条 JSONL → AgentEvent;`stop_reason==="end_turn"` 判轮次结束(`:145-155`);维护 in-flight 工具/todos/token 快照 | `JsonlTurnTranslator` |

关键事实(已确认):**事件流来自磁盘 JSONL 轮询(300ms),不是进程 stdout**;PTY stdout 仅用于就绪检测与 consent 对话框匹配(`pty-session.ts:394-405`)。

### 3.3 Claude headless 路径(可选)

`claude/adapter.ts`(264 行)— `ClaudeHeadlessAdapter`:spawn `claude -p <prompt> --output-format stream-json --verbose --include-partial-messages --permission-mode … --append-system-prompt … [--resume] [--model]`(args 组装 `src/agent/claude/adapter.ts:60-77`,已确认),由 `stream-json.ts` 的 `createStreamJsonTranslator` 翻译 stdout。启用条件:`getClaudeDriver(cfg)==='headless'`(`src/cli/commands/start.ts:467`);**默认 pty 已确认**(`src/config/schema.ts:343-347`:仅显式 headless 才切换)。

### 3.4 Codex 路径

- `codex/adapter.ts`(301 行)— `CodexAdapter.run`:spawn `codex exec [--json] [resume <threadId>] --sandbox <mode> -c approval_policy="never" ...`(`codex/argv.ts:22-57`),prompt(前置 bridge system prompt)写 stdin;stderr 逐行记日志;stop 为 SIGTERM→grace→SIGKILL(`adapter.ts:161-180`)。
- `codex/jsonl.ts` — `CodexJsonlTranslator`:处理 `thread.started/turn.started/item.started/item.completed/agent_message/turn.completed/turn.failed/error` 事件(`src/agent/codex/jsonl.ts:22-48`),含 protocol drift 检测。

### 3.5 Prompt 与环境

- `prompt.ts` — `buildAgentPrompt`(`:99`):组装 `<bridge_context>/<bridge_instructions>/<thread_context>/<quoted_messages>/<interactive_cards>/<attachments>` 分节(分节定义见 `src/bot/channel.ts:750` 调用与 spec `spec/thread-context/implementation.md`)。
- `bridge-system-prompt.ts` — `BRIDGE_SYSTEM_PROMPT`(中文运行约定,`:3`)+ `buildBridgeSystemPrompt`(注入 bot 身份,`:179`)+ `prefixBridgeSystemPrompt`(codex stdin 前缀,`:185`)。
- `lark-channel-env.ts` — `buildLarkChannelEnv`:向 agent 子进程注入 `LARK_CHANNEL=1 / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR`(`src/agent/lark-channel-env.ts:11`)。
- `capability.ts` — `claudeCapability`/`codexCapability`:声明 agent 能力(注入模式 append-system-prompt vs stdin-prefix、maxAccess)。
- `preflight.ts` — `checkAgentAvailability`:二进制存在性/版本诊断(`AgentPreflightDiagnostic`)。

## 4. `src/card` — 卡片呈现层(~2.8k 行)

| 文件 | 职责 | 关键符号 |
|---|---|---|
| `run-state.ts`(208 行) | 纯函数状态机:AgentEvent → RunState(blocks/toolEntry/footer/terminal/usage) | `RunState`(`:27`)、`reduce`(`:53`)、`markInterrupted`(`:178`)、`markIdleTimeout`(`:188`)、`finalizeIfRunning`(`:199`) |
| `run-renderer.ts`(342 行) | RunState → 飞书卡片 DSL(CardKit) | `renderCard`(`:54`),支持 toolDisplay(full/compact/hide)、feedback 行、签名回调 |
| `text-renderer.ts` | RunState → markdown 纯文本 | `renderText`(`:32`) |
| `managed.ts` | 托管实体卡(createCard/updateCardById,支持按钮回调存活) | `sendManagedCard`/`updateManagedCard`/`isManaged` |
| `dispatcher.ts`(396 行) | cardAction 事件分发:内置 cmd(stop/fb/config…)→ 命令系统;`__bridge_cb` → 回注 pending 队列给 agent | `handleCardAction`(`:47`)、`BRIDGE_CALLBACK_MARKER`(`:25`) |
| `callback-auth.ts` | HMAC 签名 + nonce 防重放(密钥=App Secret) | `CallbackAuth.sign/verify`(`:64`) |
| `callback-store.ts` | nonce 持久化(`callback-nonces.json`) | `CallbackNonceStore` |
| `config-card.ts` / `account-cards.ts` / `ask-question-card.ts` / `idle-checkpoint-card.ts` / `feedback-store.ts` / `templates.ts` | /config 表单卡、/account 流程卡、AskUserQuestion 卡、检查点卡(继续等/立即终止)、👍/👎 卡注册、help/status/workspaces/resume 卡 | `configFormCard`、`accountFormCard`、`registerFeedbackCard`(`:21`)、`helpCard` 等 |

对外导出:`src/index.ts` 导出 `renderCard/renderText/run-state 系列/telemetry 类型`(供外部复用渲染逻辑,tsup dts entry)。

## 5. `src/commands` — 斜杠命令系统(~2.4k 行)

- `index.ts`(2296 行):`handlers` 注册表(`src/commands/index.ts:206-230`,19 个命令键,`/reset` 为 `/new` 别名)、`ADMIN_COMMANDS` 集合(`:233-247`)、`tryHandleCommand`(`:251`,入口)+ `runCommandHandler`(卡片回调复用)。
- Handler 清单(`:353-1920`):`handleNew/handleCd/handleWs(list/save/use/remove)/handleDoc/handleResume(+all)/handleStatus/handleReport/handleStop/handleTimeout/handlePs/handleExit/handleReconnect/handleDoctor/handleHelp/handleAccount/handleInvite/handleRemove/handleConfig`。
- 关键状态:`resumeCandidates` 模块级 Map(/resume 候选,TTL 10min,`:180-188`);`Controls` 接口(`:84-109`,由 start.ts 注入 restart/exit/refreshOwner);`CommandContext`(`:111-150`,含 `formValue`/`fromCardAction` 供卡片复用)。
- `report-format.ts` — `/report` 账单卡片格式化。

## 6. `src/runtime` — 运行时治理(~1.8k 行)

- `run-executor.ts`(326 行)— `RunExecutor.submit`(`:63-214`):policy 有效期校验 → `ActiveRuns.reserve`(scope 单飞)→ `ProcessPool.acquire`(全局并发)→ `prepareRun` → `agent.run()` → 注册句柄 → `EventFanout.start()` 立即驱动流(防订阅前抛错泄漏 scope 锁,`:189-194`)。`observeRunEvents` 包装打点。`EventFanout`(`:253-322`)单订阅缓冲扇出。
- `registry.ts`(398 行)— 进程注册表(`~/.lark-channel/registry/processes.json`):`register`(`:132`)/`unregisterSync`(`:189`)/`readAndPrune`(按 pid 存活清理,`:84`)/`sameAppOthers`/`resolveTarget`(`:242`)。
- `locks.ts` — proper-lockfile 封装:profile 锁 + app 锁(`withProfileAndAppLocks`),冲突抛 `RuntimeLockConflictError`(`:25`)。
- `profile-runtime.ts`(734 行)— `resolveProfileRuntime`:定位/加载/必要时 bootstrap profile,产出 `ProfileRuntime`(cfg+profileConfig+appPaths);`createRuntimeProfileConfig`(`:85`)。
- `profile-discovery.ts`、`errors.ts`(`RunRejected`/`SpawnFailed`,含拒绝码 `RunRejectedCode`:`policy-expired/reconnect-in-progress/run-already-active/pool-full`)。

## 7. `src/policy` — 访问与运行策略(~0.5k 行)

- `access.ts` — `isCreator`/`canUseDm`/`canUseGroup`/`canRunAdminCommand`(`:26-54`):四层身份(app 创建者 / admins / allowedUsers / allowedChats)。
- `run-policy.ts` — `evaluateRunPolicy`(`:95`):access→accessMode→clamp(取 defaultAccess、maxAccess、capability 上限的最严值)→ 映射 claude permissionMode / codex sandbox;校验 folder allowlist、必需附件;产出 `policyFingerprint` 与 5min TTL(`:93`)。
- `workspace.ts` — `resolveWorkingDirectory`:存在性/目录性/过宽路径(根、home、系统目录、tmp)拒绝。
- `owner.ts` — `createOwnerRefreshController`/`refreshOwnerControls`:30min 定时从飞书刷新 app owner(`OWNER_REFRESH_INTERVAL_MS`,`:4`)。
- `fingerprint.ts` — `policyFingerprint`:access+resource+attachment 摘要,变化即视为不同会话身份(驱动 catalog 匹配)。

## 8. `src/config` — 配置与密钥(~2.4k 行)

- `schema.ts`(477 行)— `AppConfig`(`:239`)+ `AppPreferences`(`:94`)+ ~20 个 getter(`getMessageReplyMode`/`getMaxConcurrentRuns`/`getRequireMentionInGroup`/`getThreadContext*`/`getRunIdleTimeoutMs`/`getClaudeDriver`/`getSessionRotateMaxBytes` 等,`:279-477`)。
- `profile-schema.ts`(365 行)— `ProfileConfig`(agentKind/codex/permissions/access/workspaces/attachments/larkCli/secrets,`:77`)、`RootConfig`(schemaVersion=2,`:105`)、`normalizeProfileConfig`(`:148`)。
- `profile-store.ts`(300 行)— `loadRootConfig/saveRootConfig`(带文件锁 `withConfigFileLock`)、`runtimeProfileConfig`(AppConfig∩ProfileConfig 合成,`:146`)、`createRootConfig`、remove/export 辅助。
- `store.ts` — `saveConfig`/`buildEncryptedAccountConfig`(appSecret 支持加密引用)。
- `keystore.ts`(密钥库)— 加密 secrets(`~/.lark-channel/profiles/<p>/secrets.enc`,scrypt 派生密钥,`keystore.ts:44-170`)。
- `secret-resolver.ts`(249 行)— `resolveAppSecret`:明文 / `${VAR}` / SecretRef{source: keystore|env|file|exec}。
- `permissions.ts`(285 行)— AccessMode(read-only/workspace/full)↔ ClaudePermissionMode ↔ CodexSandboxMode 双向映射 + `clampAccess`(`:73`)。
- `migrate-v2.ts` — v1 单 profile → v2 多 profile 迁移;`app-paths.ts` — `resolveAppPaths`(`~/.lark-channel` 全部路径,支持 `LARK_CHANNEL_HOME`);`paths.ts`。

## 9. `src/session` + `src/workspace` — 会话与工作区

- `store.ts` — `SessionStore`:scope→`SessionEntry{sessionId?,cwd?,idleTimeoutMinutes?,updatedAt}`(`src/session/store.ts:6-13`),持久化 `sessions.json`;另持内存态 `threadContextInjected` 集合(按 `scope␟threadId` 键,**故意不持久化**,`:30-43`)。
- `catalog.ts`(286 行)— `SessionCatalog`:agent 感知目录(`sessions.json.catalog.json`),key=scope+agentId+cwd+fingerprint,active/archived 状态,`activeFor`/`upsertActive`/`archiveActive`/GC。
- `history.ts` — `listRecentSessions`/`listAllRecentSessions`:扫描 `~/.claude/projects/*/*.jsonl` 供 `/resume`;`codex-history.ts` — `listCodexThreadHistory`(读 codex home 的 rollout 文件【待验证:具体文件格式】)。
- `jcs.ts`/`preview.ts` — 会话预览摘要(供 /resume 列表;【待验证:细节未读】)。
- `workspace/store.ts` — `WorkspaceStore`(`workspaces.json`):scope→当前 cwd + 命名工作区表。

## 10. 支撑层

- `core/logger.ts`(681 行)— `log.info/warn/fail` 结构化 JSONL(按日切分)、`withTrace` trace-id 贯穿、`reportMetric/reportError`、脱敏(`sanitizeLogsForDoctor`/`redactDiagnosticText`,`:478-507`)。
- `core/telemetry.ts` — `loadTelemetryAdapter`(环境变量 `LARK_CHANNEL_TELEMETRY_MODULE` 动态 import 外部适配器,失败降级 noop,`:154` 前)。
- `observability/ledger.ts`(265 行)— `LedgerStore`:每次交互的 token/cost/用户/回复消息 id + 👍/👎 投票(`setVote/countsFor/recordReaction`),供 `/report` 与卡片 feedback。
- `observability/events.ts` — `REQUIRED_OBSERVABILITY_EVENTS`(静态契约测试用,`tests/static/contracts.test.ts`)。
- `media/cache.ts`(217 行)— `MediaCache.resolve`→`resolveOne`:`channel.downloadResourceToFile`(im v1 messageResource.get)下载到 profile mediaDir,大小上限在下载后强制(`:81-89`)。
- `media/attachment.ts` — `normalizeAttachments`(类型/大小/MIME→扩展名白名单校验,decision accepted/rejected/skipped)、`toPolicyAttachment`/`toPromptAttachment`。
- `daemon/*`(812 行)— `getServiceAdapter`(`service-adapter.ts:161`)按平台选 `launchd.ts`/`systemd.ts`/`schtasks.ts`;plist/unit 名 `ai.lark-channel-bridge.bot.<profile>` 等。
- `lark-cli/identity-policy.ts` — `applyLarkCliIdentityPolicy`:bot-only/user-default 两档身份策略;`profile-projection.ts` — 把 bridge profile 投影成 lark-cli 配置;`legacy-source-overlay.ts` — 旧版 source 叠加兼容。
- `platform/spawn.ts` — `spawnProcess/mergeProcessEnv`(cross-spawn 封装,shell 处理);`platform/atomic-write.ts` — `writeFileAtomic`(tmp+rename)。
- `utils/feishu-auth.ts` — `validateAppCredentials`(app_id/secret 校验,/account 与 wizard 用)。

## 11. 测试与辅助(117 个 test 文件)

- `tests/unit/`(~70 文件):模块级,含 `static/contracts.test.ts`(README/observability 契约)、`docs/readme-contract.test.ts`(README 与 CLI 注册一致性)。
- `tests/integration/`:bot 流程(access-gate、im-run-flow、thread-context、claude-security)、commands、comments、config、executor、policy、runtime、session。
- `tests/process/`:真实子进程适配器测试(claude-headless-adapter、codex-adapter)。
- helpers:`fake-channel.ts`(LarkChannel 假实现)、`fake-agent.ts`、`tmp-profile.ts`(隔离 `~/.lark-channel`)、`card-normalize.ts`、`fake-comment-surface.ts`、`fake-executable.ts`;fixtures:`claude-fake/claude.mjs`(假 claude TUI)。
- 测试纪律见 `CLAUDE.md`(禁 watch、窄范围、maxForks=4 不可绕过)。

## 12. 模块依赖要点(谁调谁)

- `cli/commands/start.ts` 是唯一的进程装配点;`bot/channel.ts` 是唯一的运行时装配点——两者都不被其他业务模块反向依赖(已确认,grep 无其他调用方)。
- `commands/index.ts` 依赖最广(channel/card/config/policy/session/workspace/runtime/ledger),但只通过 `CommandContext` 参数接收依赖,不直接 import 运行时单例。
- `agent/*` 不依赖 bot/card/commands(纯适配层,仅依赖 config/permissions、core/logger)——分层干净(已确认 import 方向)。
- `policy/*` 被 bot/channel、run-flow、commands、card/dispatcher 消费;`config/*` 被几乎所有层消费。
- 事件流方向:`@larksuite/channel` → bot → RunExecutor(EventFanout)→ AgentRun.events → processAgentStream → card/run-state → channel.send/stream(单向,无环)。

## 13. 待验证事项(模块层面)

1. ~~`ClaudeHeadlessAdapter` 的完整 args 与默认 driver~~(已核实:默认 pty,`src/config/schema.ts:343-347`;headless args 见 §3.3)。
2. `session/jcs.ts`、`session/preview.ts`、`bot/scope.ts`、`bot/comment-resource.ts`、`cli/agent-detection.ts`、`cli/prompt.ts`、`daemon/paths.ts` 细节未读(均 <120 行,职责按名字+调用点推断)。
3. `codex-history.ts` 读取的 rollout 文件格式。
4. `@larksuite/channel` SDK 内部(WS 重连策略、消息归一化规则)——外部依赖,源码在 node_modules,未深读。
