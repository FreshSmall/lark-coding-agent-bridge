# lark-coding-agent-bridge 业务功能清单

> 生成时间:2026-10-24。基于分支 `feat/topic-root-context` 真实源码。
> 配套文档:[module-map.md](./module-map.md)(模块地图)、[flows/message-to-agent.md](./flows/message-to-agent.md) 与 [flows/streaming-response.md](./flows/streaming-response.md)(核心链路逐步追踪)。
> 证据状态:【已确认】= 读到实现代码;【推断】= 由调用点/命名/文档推断;【待验证】= 存在断点。

## 功能索引

| 编号 | 功能 | 触发入口 | 入口函数 | 核心文件 |
|---|---|---|---|---|
| F01 | 主机 CLI 命令 | 终端 `lark-channel-bridge …` | `src/cli/index.ts` commander 注册 | `src/cli/commands/*` |
| F02 | OS 守护进程管理 | `start/stop/restart/status/unregister` | `runServiceStart`(`src/cli/commands/service.ts:269`) | `src/daemon/*` |
| F03 | 首跑 QR 注册与 profile bootstrap | 首次 `run`/`profile create` | `runStart`(allowBootstrap)→ `runRegistrationWizard` | `src/bot/wizard.ts`、`src/cli/profile-bootstrap.ts` |
| F04 | lark-cli 预检与自动安装 | 每次 `run` 启动 | `preFlightChecks`(`src/cli/preflight.ts:51`) | `src/cli/preflight.ts`、`src/lark-cli/*` |
| F05 | 飞书长连接接入与事件路由 | 进程启动 | `startChannel`(`src/bot/channel.ts:186`) | `src/bot/channel.ts` |
| F06 | keepalive 探测与进程内热重连 | 定时器 / `/reconnect` / `/account` | `startKeepalive`、`Controls.restart`(`start.ts:245`) | `src/bot/keepalive.ts`、`src/cli/commands/start.ts` |
| F07 | 消息接入与访问控制门 | IM message 事件 | `intakeMessage`(`channel.ts:528`) | `src/policy/access.ts` |
| F08 | 群/话题模式识别与 scope 划分 | 消息接入 | `ChatModeCache.resolve` | `src/bot/chat-mode-cache.ts` |
| F09 | 斜杠命令系统 | 消息以 `/` 开头 / 卡片按钮 | `tryHandleCommand`(`src/commands/index.ts:251`) | `src/commands/index.ts` |
| F10 | 消息合批队列 | 普通消息 600ms 静默窗 | `PendingQueue` | `src/bot/pending-queue.ts` |
| F11 | 运行编排与并发控制 | 批次 flush | `startRunFlow`(`src/bot/run-flow.ts:90`)→`RunExecutor.submit` | `src/runtime/run-executor.ts` |
| F12 | Claude PTY 会话适配 | claude run | `ClaudePtyAdapter.run`→`PtySession.runTurn` | `src/agent/claude/*` |
| F13 | Claude headless 适配 | driver=headless | `ClaudeHeadlessAdapter.run` | `src/agent/claude/adapter.ts`、`stream-json.ts` |
| F14 | Codex 适配 | agentKind=codex | `CodexAdapter.run`(`src/agent/codex/adapter.ts:91`) | `src/agent/codex/*` |
| F15 | Prompt 组装(上下文注入) | 每次 run | `buildPrompt`(`channel.ts:1514`)→`buildAgentPrompt` | `src/agent/prompt.ts`、`bridge-system-prompt.ts` |
| F16 | 话题上下文注入(本分支主题) | 话题群消息 | `fetchThreadContext`(`channel.ts:725` 调用) | `src/bot/thread-history.ts`、`src/session/store.ts` |
| F17 | 引用消息上下文 | 回复引用消息 | `fetchQuotedContext` | `src/bot/quote.ts` |
| F18 | 回复渲染三模式与降级 | run 事件流 | `processAgentStream` + `renderCard/renderText` | `src/card/run-state.ts`、`run-renderer.ts` |
| F19 | 卡片交互回调与鉴权 | cardAction 事件 | `handleCardAction`(`src/card/dispatcher.ts:47`) | `src/card/dispatcher.ts`、`callback-auth.ts` |
| F20 | AskUserQuestion 交互问答 | agent 调用该工具 | `AskQuestionFlow.start` | `src/bot/ask-question-flow.ts`、`pty-session.ts:246` |
| F21 | 超时、看门狗与取消 | `/stop`、stop 按钮、idle watchdog | `processAgentStream`(:1160)、`PtySession.terminate` | `channel.ts`、`pty-session.ts` |
| F22 | 会话持久化、续接与轮转 | 每次 run 结束/system 事件 | `recordRunSessionEvent`、`SessionCatalog.activeFor` | `src/session/*` |
| F23 | `/resume` 会话恢复列表 | `/resume [all]` | `handleResume`(`src/commands/index.ts:577`) | `src/session/history.ts`、`codex-history.ts` |
| F24 | 工作目录与命名工作区 | `/cd`、`/ws` | `handleCd`(:423)、`handleWs`(:446) | `src/workspace/store.ts`、`src/policy/workspace.ts` |
| F25 | 附件与媒体下载 | 消息带资源 | `MediaCache.resolve`(`src/media/cache.ts:37`) | `src/media/*` |
| F26 | 权限模式与运行策略 | 每次 run 前 | `evaluateRunPolicy`(`src/policy/run-policy.ts:95`) | `src/config/permissions.ts`、`src/policy/fingerprint.ts` |
| F27 | 访问控制 ACL 管理 | `/invite`、`/remove`、`/config` | `handleInvite`(:1672)、`handleRemove`(:1785) | `src/policy/access.ts`、`owner.ts` |
| F28 | 配置、profile 与密钥库 | `/config`、`/account`、主机命令 | `handleConfig`(:1920)、`handleAccount`(:1511) | `src/config/*` |
| F29 | 云文档评论触发 | 评论 @bot | `handleCommentMention`(`src/bot/comments.ts:84`) | `src/bot/comments.ts` |
| F30 | 日志、诊断与遥测 | 全程 / `/doctor` | `log.*`、`handleDoctor`(:1245) | `src/core/logger.ts`、`telemetry.ts` |
| F31 | 用量账本与反馈投票 | run 结束 / 👍👎 | `LedgerStore.record`(`channel.ts:1069`) | `src/observability/ledger.ts` |
| F32 | 进程注册表与运行时锁 | 启动注册 / `ps`/`kill` | `register`(`src/runtime/registry.ts:115` 附近) | `src/runtime/registry.ts`、`locks.ts` |
| F33 | 回复线程化策略 | 群/话题回复 | `shouldReplyInThread`(`src/bot/thread-policy.ts:12`) | `src/bot/thread-policy.ts` |
| F34 | lark-cli 身份策略(bot/用户双身份) | `/config` 切换 | `applyLarkCliIdentityPolicy` | `src/lark-cli/identity-policy.ts` |

---

## F01 主机 CLI 命令【已确认】

- **场景**:用户在终端安装、运行、管理 bridge。
- **入口**:`bin/lark-channel-bridge.mjs` → `dist/cli.js`;commander 注册于 `src/cli/index.ts:30-243`:`run / migrate / profile(list|create|use|remove|export) / ps / kill / start / stop / restart / status / unregister / secrets(get|set|list|remove)`。
- **实现**:`src/cli/commands/` 各文件;顶层错误统一在 `parseAsync().catch`(`index.ts:244-260`)处理(含 `AgentPreflightError` 格式化、`UserCancelledError` 静默退出)。
- **数据**:`~/.lark-channel/config.json`(RootConfig v2)、`active-profile`、registry。
- **测试**:`tests/unit/cli/index-registration.test.ts`(注册契约)、`tests/integration/cli/*`。
- **注意**:`run` 是前台(旧版叫 start),`start` 是装 OS 服务——README 与代码一致。

## F02 OS 守护进程管理【已确认】

- **场景**:开机自启/后台常驻。
- **实现**:`runServiceStart`(`src/cli/commands/service.ts:269`)→ `getServiceAdapter(profile)`(`src/daemon/service-adapter.ts:161`)按 platform 选 `launchd.ts`(macOS,plist `ai.lark-channel-bridge.bot.<profile>`)/`systemd.ts`(Linux)/`schtasks.ts`(Windows,.cmd 包装)。
- **数据**:OS 侧 plist/unit/task;日志 `~/.lark-channel/profiles/<p>/logs/daemon/`。
- **测试**:`tests/unit/daemon/daemon-env.test.ts`、`profile-args.test.ts`、`tests/unit/cli/service-profile.test.ts`。

## F03 首跑 QR 注册与 profile bootstrap【已确认(主流程)】

- **场景**:无配置时首跑,扫码创建/绑定 PersonalAgent 应用。
- **实现**:`runStart` → `resolveProfileRuntime({allowBootstrap:true})`(`src/runtime/profile-runtime.ts`)→ 触发 `runRegistrationWizard`(`src/bot/wizard.ts:5`,qrcode-terminal 渲染)+ `profile-bootstrap.ts` 交互初始化(agent 选择、workspace 默认目录)。支持 `--app-id/--app-secret/--tenant` 跳过创建(`src/cli/index.ts:44-46`)。
- **数据**:写入 RootConfig + keystore。
- **测试**:`tests/integration/cli/first-run-profile.test.ts`、`profile-create.test.ts`。
- **待验证**:QR 背后的注册 API 细节在 `@larksuite/channel` SDK 内(`createLarkChannel` 的注册流程),bridge 侧只到 wizard 调用层。

## F04 lark-cli 预检与自动安装【已确认】

- **场景**:agent 需要能在会话内操作飞书(lark-cli);bridge 启动时保证其可用并绑定 profile。
- **实现**:`preFlightChecks`(`src/cli/preflight.ts:51`)→ `checkLarkCli`(`:55`):检测 `lark-cli` → @clack/prompts 引导安装 → `writeLarkCliSourceProjection`(profile-projection)把 bridge 凭据投影为 lark-cli 配置;`--skip-check-lark-cli` 跳过。
- **关系**:F34(身份策略)的入口;agent 子进程通过 `LARKSUITE_CLI_CONFIG_DIR` 使用该目录。

## F05 飞书长连接接入与事件路由【已确认】

- **场景**:建立 WS 长连接,收发消息/卡片/评论/表情事件。
- **实现**:`startChannel`(`src/bot/channel.ts:186-475`):组装 `LarkChannelOptions`(appId/secret 解析、domain(feishu/lark)、`chatQueue` 关闭以自管合批、`includeRawEvent:true` 读原生字段、ws pingTimeout=3s、handshake 8s、http 30s、代理支持,`:214-253`)→ `createLarkChannel` → `channel.connect()` → 注册六类回调(message/reject/cardAction/reaction/comment/reconnecting|reconnected|error,`:298-403`)→ owner 刷新 + knownChats 定时刷新(30min)+ keepalive → 返回 `BridgeChannel{channel,disconnect}`。
- **事件接收机制(2026-10-24 已确认)**:SDK `LarkChannel.connect()` 内部构造 node-sdk `WSClient` 并等 `onReady` 才 resolve(`@larksuite/channel/dist/index.d.mts:716-760`);飞书事件经 WS 推送 → SDK 归一化(`NormalizedMessage`,`.d.mts:102-130`)→ EventMap 内存回调。**SDK 内置 messageId dedup 与 stale 窗口(SafetyConfig,静默丢弃不产生 reject 事件)**;policy 级拒绝才回调 `reject`。bridge 无监听端口、无 webhook。详见 flows/message-to-agent.md 阶段 0-1。
- **外部依赖**:`@larksuite/channel` ^0.1.2(内部 `@larksuiteoapi/node-sdk`)。
- **disconnect**(`:448-473`):暂停新 run → 停三个定时器 → `cancelAll` 队列 → 并行 disconnect/stopAll/flush 各 store。
- **测试**:`tests/integration/bot/*`(fake-channel)。

## F06 keepalive 探测与进程内热重连【已确认】

- **场景**:SDK 层 watchdog 之外的双保险;换凭据/强重连不重启进程。
- **实现**:`startKeepalive`(`src/bot/keepalive.ts:48`,15s 探测+唤醒+HTTP 可达)失效时 `forceReconnect=()=>controls.restart()`(`channel.ts:440`);`Controls.restart()`(`src/cli/commands/start.ts:245-347`)重读配置 → 新 agent → **先连新 bridge 再断旧**(注释 `:280-284` 说明失败保活语义)→ 释放旧 PTY 池 → 换 app 锁。
- **约束**:重连期间 agent kind 不可变(`assertReconnectAgentKindUnchanged`,`start.ts:417`)。
- **测试**:`tests/integration/commands/reconnect-profile.test.ts`、`tests/unit/cli/start-agent-factory.test.ts`。

## F07 消息接入与访问控制门【已确认】

- **场景**:决定"这条消息要不要理、谁来用 bot"。
- **实现**:`intakeMessage`(`channel.ts:528-631`):ACL 判定 `canUseDm`/`canUseGroup`(`src/policy/access.ts:31,42`;身份四层:创建者恒过、admins 全通、allowedUsers 管 DM、allowedChats 管群)→ 未授权群内被 @ 时发一次性提示 `sendNonAllowedGroupHint`(`:497`)其余沉默 → 群 @bot 开关(`getRequireMentionInGroup`,命令也不例外,`:591-598`)→ 命令分流 → 入队。
- **数据**:profile `access` 字段(config.json);owner 身份 30min 刷新(F27)。
- **测试**:`tests/integration/bot/access-gate.test.ts`、`tests/unit/policy/access.test.ts`、`tests/integration/policy/owner-refresh.test.ts`。

## F08 群/话题模式识别与 scope 划分【已确认】

- **实现**:`ChatModeCache.resolve`(`src/bot/chat-mode-cache.ts`)一次 `chat.get` 缓存 p2p/group/topic;scope 规则(`channel.ts:547-550`):topic 群且带 threadId → `chatId:threadId`,否则 `chatId`。scope 是 session/workspace/activeRuns/pending 的统一键(README:"each chat, topic keeps its own session")。
- **测试**:`tests/unit/bot/thread-policy.test.ts`。

## F09 斜杠命令系统【已确认】

- **场景**:聊天内控制 bot(会话、工作区、权限、诊断、生命周期)。
- **入口**:`tryHandleCommand`(`src/commands/index.ts:251`,IM 文本)与 `runCommandHandler`(卡片按钮,`src/card/dispatcher.ts:167`)共享 handler。
- **注册表**:`handlers`(`:206-230`,19 个命令键:/new /reset /cd /ws /resume /status /help /account /config /stop /timeout /ps /exit /doctor /reconnect /doc /invite /remove /report;`/reset` 是 `/new` 别名);管理命令集合 `ADMIN_COMMANDS`(`:233`)经 `canRunAdminCommand` 鉴权。
- **子命令**(2026-10-24 交叉验证补充):`/new chat [name]`(`handleNewChat`,`:384-421`)创建新群并继承当前 cwd,不动原会话;`/resume use <nonce>` / `all [N]`;`/ws list|save|use|remove`;`/timeout off|default|comment:<scope>`;`/stop <scope>`(admin)。`/doc`(`:524-527`)是**兼容性占位**——仅回复"云文档评论现在不需要绑定工作区",无实际逻辑。
- **关键机制**:命令处理即时返回并 `pending.cancel(scope)` 丢弃该 scope 积压消息(`channel.ts:623-627`);`CommandContext.formValue/fromCardAction` 支持 CardKit 表单卡复用同一 handler;`Controls.restart/exit/refreshOwner` 由 start.ts 注入实现跨层控制。
- **数据**:读改 config.json(access/preferences)、sessions.json、workspaces.json、registry。
- **测试**:`tests/integration/commands/*`(14 个文件)。

## F10 消息合批队列【已确认】

- **场景**:用户连发多条消息合并成一次 run;运行中的消息留到下一轮。
- **实现**:`PendingQueue`(`src/bot/pending-queue.ts`):600ms 静默窗(`DEBOUNCE_MS`,`channel.ts:79`);flush 时先 `pending.block(scope)` → `runAgentBatch` → finally `unblock` 重新武装定时器(`channel.ts:263-293`)——保证每 scope 串行。多发送者批次在 prompt 中标注发送者(`senderAnnotation`,`channel.ts:1582`)。
- **测试**:`tests/integration/bot/im-run-flow.test.ts` 等。

## F11 运行编排与并发控制【已确认】

- **实现**:`startRunFlow`(`src/bot/run-flow.ts:90`)按序:workspace 解析 → run-policy → 会话续接(catalog 优先,claude 再查 SessionStore;codex 用 threadId)→ 轮转检查 → `RunExecutor.submit`(`src/runtime/run-executor.ts:63`)。
- **RunExecutor.submit 拒绝路径**(4 个 RunRejectedCode):`policy-expired`(TTL 5min)/`reconnect-in-progress`(pauseNewRuns)/`run-already-active`(scope 占用)/`pool-full`;`nowait` 用于命令触发的轻量 run。
- **并发三层**:ActiveRuns(scope 单飞,F08)+ ProcessPool(全局 `maxConcurrentRuns` FIFO)+ SDK chatQueue 显式关闭自管。
- **生命周期**:`EventFanout.start()` 立即泵流(防订阅泄漏,`run-executor.ts:189-194`);终态后 `cleanup(waitForExit)` 等 agent 进程自然退出(2s 宽限)再强停。
- **测试**:`tests/unit/runtime/run-executor.test.ts`、`tests/integration/executor/run-executor.test.ts`。

## F12 Claude PTY 会话适配【已确认】

- **场景**:claude 默认驱动。每个 Lark 会话一个长驻 `claude` TUI(PTY),跨轮复用。
- **链路**:`ClaudePtyAdapter.run`(`src/agent/claude/pty-adapter.ts:84` 起)→ `ClaudePtyPool.acquire`(命中则复用)→ `spawnSession`(args:`--permission-mode/--resume|--session-id/--append-system-prompt/--model`,env 注入 LARK_CHANNEL*,`:187-210`)→ `PtySession.runTurn`。
- **runTurn 机制**(`pty-session.ts:326-455`):prompt 压成单行 + 200ms 后补 `\r`(规避 TUI 多行态)→ 300ms 轮询磁盘 JSONL → `JsonlTurnTranslator.translate` 逐条转 AgentEvent;PTY stdout 仅用于:consent 对话框自动应答(trust-folder 回车、bypass-permissions 选 2,`:67-75`)、就绪检测(`waitForReady` 1s 静默)、退出诊断尾巴。
- **轮次终止信号(2026-10-24 已确认,`jsonl-translate.ts:145-155,288-299`)**:`system(subtype=turn_duration)` 且已见 `stop_reason=end_turn` → yield `usage`+`done(normal)`。单独 end_turn 不可靠(Extended Thinking 拆两条);`model='<synthetic>'` 条目跳过(中断/续接后 claude 自造的记账轮)。工具标签人性化(`humanLabel`:Bash·命令 等,`:27-64`);todo 类工具在 tool_use 时即时入快照。model 参数绑定在 PTY spawn 时,池命中不生效(`pty-pool.ts:13-16`)。
- **中断两级**:`softInterrupt`(写 ESC)→ `terminate` 升级 `hardClose`(SIGTERM→3s→SIGKILL,`:494-537`);stop 按钮走 terminate。
- **挂死防线**:`maxSilenceMs`(默认 15min,工具 in-flight 时暂停计时)+ `maxTurnMs`(默认关)+ 空闲检查点 3/10/30min(`:83-87`)。
- **数据**:`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`(claude 原生格式,bridge 只读)。
- **测试**:`tests/unit/agent/claude-pty*.test.ts`(5 个)、`tests/integration/claude/pty-adapter.test.ts`、fixtures `tests/fixtures/claude-fake/claude.mjs`。

## F13 Claude headless 适配【已确认(存在)/待验证(默认值)】

- **实现**:`ClaudeHeadlessAdapter`(`src/agent/claude/adapter.ts`):spawn `claude -p <prompt> --output-format stream-json --verbose --include-partial-messages --permission-mode <mode> --append-system-prompt <bridge prompt> [--resume <id>] [--model <m>]`(args 组装 `:60-77`,已确认),stdout 逐行 JSON → `createStreamJsonTranslator`(`stream-json.ts:53`)→ AgentEvent。无 PTY 池,每 run 一个进程。
- **启用**:`getClaudeDriver(cfg)==='headless'`(`start.ts:467`);**默认 pty 已确认**(`src/config/schema.ts:343-347`:仅显式 `'headless'` 才走 headless,否则 `'pty'`)。
- **测试**:`tests/process/claude-headless-adapter.test.ts`。

## F14 Codex 适配【已确认】

- **实现**:`CodexAdapter.run`(`src/agent/codex/adapter.ts:91-194`):`buildCodexArgs`(`argv.ts:22-57`)构造 `codex exec --sandbox <mode> -c approval_policy="never" --skip-git-repo-check -C <cwd> [--image…] [--json] resume <threadId> -`;prompt 经 `prefixBridgeSystemPrompt` 前置后写 stdin;stdout 行 JSON → `CodexJsonlTranslator`(thread.started/item.completed/turn.completed…);`CODEX_HOME` 隔离到 profile(`codexHome` 或 `<profileDir>/codex-home`)。
- **续接**:codex threadId 存 SessionCatalog(F22);无 PTY 复用,每 run 新进程。
- **测试**:`tests/process/codex-adapter.test.ts`、`tests/unit/agent/codex-*.test.ts`。

## F15 Prompt 组装【已确认】

- **实现**:`buildPrompt`(`channel.ts:1514-1566`)→ `buildAgentPrompt`(`src/agent/prompt.ts:99`),分节:`<bridge_context>`(chat/sender/bot 身份/mentions/messageIds/source)、`<bridge_instructions>`(`BRIDGE_AGENT_INSTRUCTIONS`,channel.ts:83-88,约束 agent 不得绕过 LARK_CHANNEL 环境)、`<thread_context>`、`<quoted_messages>`、`<interactive_cards>`(interactive 卡片消息的原始 DSL,`:1634-1643`)、`<attachments>`;用户消息部分剥离附件引用语法(`stripAttachmentRefs`,`:1606`)。
- **系统提示**:`buildBridgeSystemPrompt`(PTY --append-system-prompt)/ `prefixBridgeSystemPrompt`(codex stdin),`src/agent/bridge-system-prompt.ts:3` 起的中文运行约定,含 bot open_id 自认。
- **测试**:`tests/unit/agent/prompt-builder.test.ts`、`bridge-system-prompt.test.ts`、`adapter-system-prompt-wiring.test.ts`。

## F16 话题上下文注入(当前分支主题)【已确认】

- **场景**:话题群里告警卡开话题 @bot,bot 看得到整个话题。
- **实现**:`runAgentBatch`(`channel.ts:719-748`):有 threadId 且 `getThreadContext(cfg)` 开启且 `!sessions.hasInjectedThreadContext(scope,threadId)` → `fetchThreadContext`(`src/bot/thread-history.ts`,拉全话题含宿主 position -1,总量 20k/单条 4k 字符上限,失败也注入 error 标记)→ 有真实内容才 `markThreadContextInjected`(**按 thread 而非 scope 键控,普通群多话题互不抑制**;内存态不持久化,重启后重注入一次,`src/session/store.ts:30-43` 注释)。
- **清除**:/new、/cd、/ws use、轮转等一切重置 session 的路径同步清 marker(设计文档 `spec/thread-context/implementation.md` §4.2;实现调用点【待验证:逐个 reset 路径核对】)。
- **测试**:`tests/integration/bot/thread-context.test.ts`、`tests/unit/bot/thread-history.test.ts`。
- **演进**:取代 spec/topic-root-context 的方案 A(只注入宿主一条)。

## F17 引用消息上下文【已确认】

- **实现**:`replyQuoteTargetForMessage`(thread-policy)筛出批次外被引用消息 → `fetchQuotedContext`(`src/bot/quote.ts`)逐条拉取(含发送者/时间/原始类型),进 `<quoted_messages>` 节(`channel.ts:694-713`)。与 F16 的语义区分:quote 是用户主动指的,thread 是所在环境(注释 `:691-693`)。

## F18 回复渲染三模式与降级【已确认】

- **实现**:`runAgentBatch` 按 `getMessageReplyMode`(`config/schema.ts:279`)分三路(`channel.ts:933-1046`):
  - **card**:托管实体卡——`sendManagedCard`(`src/card/managed.ts:28-57`:SDK `createCard` 建 CardKit 2.0 实体 → `send({cardId})` 发引用消息 → 模块级 Map 记 cardId/sequence)+ `ManagedCardUpdater`(350ms 合并节流,FIFO 链保序,`:1472-1512`)→ `updateCardById(cardId, card, seq++)`(sequence 必须严格递增,飞书拒绝乱序);replyTo 目标被撤回(230011/230017/230020)降级顶层重发(`managed.ts:63-81`)。结束后注册 feedback 卡(F31)。
  - **markdown**:`channel.stream` 打字机流(SDK 侧 400ms 节流 + 单卡 30k 字符自动滚卡),`awaitRenderAwareStream`(`:1356`)仲裁"流失败/producer 未启动/双晚"竞态并降级普通消息(`runFallbackReply`);非 card 模式先加 typing 表情(`src/bot/reaction.ts`)。
  - **text**:全程静默,结束后一次性发渲染文本(msg_type=post)。
- **状态机**:`RunState/reduce`(`src/card/run-state.ts:27,53`)纯函数,terminal 五态(running/done/interrupted/error/idle_timeout)。
- **配置项**:toolDisplay(full/compact/hide,p2p 与群可分别设,`getToolCallDisplay`)。
- **测试**:`tests/unit/card/run-renderer.snapshot.test.ts`、`text-renderer-compact.test.ts`、`tests/integration/bot/markdown-stream-startup-failure.test.ts`、`card-send-failure.test.ts`。

## F19 卡片交互回调与鉴权【已确认】

- **场景**:卡片按钮(stop/继续等/立即终止/config 表单/👍👎)与 agent 自绘按钮回调。
- **实现**:`handleCardAction`(`src/card/dispatcher.ts:47-180+`):
  - scope 解析(话题群需查宿主消息拿 thread_id,`resolveScope`)→ ACL 复检;
  - `payload.cmd` 内置命令:特殊处理 `fb`(投票,F31)、孤儿 `stop` 友好应答(`:124-130`);其余经签名校验后 `runCommandHandler` 复用 F09;
  - `__bridge_cb`(agent 经 lark-cli 自绘按钮):校验后回注 pending 队列成为下一轮 agent 输入(`:179` 起);
  - 鉴权:`CallbackAuth.sign/verify`(HMAC-SHA256,密钥=App Secret,24h TTL + nonce 防重放,`src/card/callback-auth.ts:64`;nonce 持久化 `callback-nonces.json`);`policyFingerprint` 绑定运行时策略(回调时策略已变则拒绝,`dispatcher.ts:131` `verifyBridgeToken`)。
- **测试**:`tests/integration/card/callback-dispatch.test.ts`、`tests/unit/card/callback-auth.test.ts`。

## F20 AskUserQuestion 交互问答【已确认】

- **场景**:claude 内置 AskUserQuestion 工具 → 飞书卡片按钮 → 答案写回 TUI。
- **链路**:`JsonlTurnTranslator` 产出 `ask_user_question` 事件(替代普通 tool_use,`src/agent/types.ts:103-108`)→ `processAgentStream` 调 `handle.askQuestion.start`(`channel.ts:1200-1228`),冻结当前卡、后续事件累计进 `postAskState` 答完发新卡 → 用户点击 → `AskQuestionFlow`(`src/bot/ask-question-flow.ts`)→ `AgentRun.answerQuestion` → `PtySession.answerAskUserQuestion`(`pty-session.ts:246-309`):单选按 1-9 数字键、多选数字+Tab、末问 Enter,逐键 80ms 间隔写 PTY(规避 bracketed-paste);claude 自行合成 tool_result,JSONL 轮询自然续流。签名与 stop 按钮共用 F19 令牌(`channel.ts:891-908`)。
- **测试**:`tests/unit/bot/ask-question-flow.test.ts`、`tests/unit/card/ask-question-card.test.ts`、`tests/unit/agent/claude-pty-session.test.ts`。

## F21 超时、看门狗与取消【已确认】

- **通道级 watchdog**(`processAgentStream`,`channel.ts:1129-1174`):`idleTimeoutMs`(scope 级 `/timeout N` 覆盖 > 全局 `getRunIdleTimeoutMs`,默认关)静默即 stop 并标 `idle_timeout`;in-flight 工具与待答问题暂停计时;首个 `idle_checkpoint` 后永久禁用本通道 watchdog(改由用户卡片决定,`:1153-1159`)。
- **适配器级**(F12):maxSilenceMs 15min / maxTurnMs 可配。
- **取消入口**:`/stop` 命令(`handleStop`,`commands/index.ts:1021`)、卡片 stop 按钮(F19)、`/exit` 杀进程、`ActiveRuns.interrupt`。
- **测试**:`tests/unit/runtime/run-executor.test.ts`、`tests/integration/commands/close-session.test.ts`、`tests/unit/card/idle-checkpoint-card.test.ts`。

## F22 会话持久化、续接与轮转【已确认】

- **双存储**:`SessionStore`(`src/session/store.ts`,scope→sessionId/cwd/idleTimeoutMinutes,sessions.json,遗留)与 `SessionCatalog`(`src/session/catalog.ts`,agent 感知,key=scope+agentId+cwdRealpath+policyFingerprint,active/archived,sessions.json.catalog.json)。写入点:`recordRunSessionEvent`(`run-flow.ts:242-265`,system 事件)。
- **续接判定**(`startRunFlow:131-153`):catalog.activeFor 优先(claude→sessionId,codex→threadId);claude 兜底 `sessions.resumeFor`;cwd 变更清旧。
- **轮转**(`:159-195`):claude JSONL > `getSessionRotateMaxBytes` → 弃续接起新会话(旧文件保留),catalog archiveActive。
- **重置路径**:/new /reset /cd /ws use /resume 换目标,均 `releasePreviousClaudeSession`(`commands/index.ts:189-209`,调 adapter.closeSession 释放 PTY)。
- **测试**:`tests/unit/session/*`、`tests/integration/session/resume.test.ts`。

## F23 `/resume` 会话恢复列表【已确认】

- **实现**:`handleResume`(`commands/index.ts:577-968`):默认列同身份(scope+agent+cwd+fingerprint)可续接项;`/resume all` 跨 cwd 列出全部(`listAllRecentSessions` 扫 `~/.claude/projects/*/*.jsonl`,codex 走 `listCodexThreadHistory`);用户选中后写 `resumeCandidates`(模块级 Map,TTL 10min)→ `applyResume` 绑回 scope(跨 cwd 候选同时切 workspace)。
- **测试**:`tests/integration/commands/resume-command.test.ts`。

## F24 工作目录与命名工作区【已确认】

- **实现**:`WorkspaceStore`(`src/workspace/store.ts`,workspaces.json:scope→cwd + 命名表)。`/cd` 切目录并重置会话;`/ws save/use/remove/list` 管理命名工作区;每次 run 前 `resolveWorkingDirectory`(`src/policy/workspace.ts`)校验存在性/目录性/过宽路径拒绝;profile 有 `workspaces.default`,首跑未指定则建 profile 管理的默认目录。
- **命名工作区隔离**(2026-10-24 交叉验证确认):存储 key 经 `scopedWorkspaceName`(`commands/index.ts:530-534`)拼为 `profile␟ownerOpenId␟scope␟name` 四段键——默认按 profile+owner+scope 隔离,读取回退裸 name 兼容 legacy 条目(`:536-569`);`/new chat` 建群时继承发起聊天的 cwd。
- **语义**:cwd 只是 agent 的工作目录,不是沙箱(README 明示;真实约束在 F26 权限模式)。
- **测试**:`tests/unit/policy/workspace.test.ts`、`tests/unit/session/store.test.ts`。

## F25 附件与媒体下载【已确认】

- **实现**:`MediaCache.resolve`(`src/media/cache.ts:37`)→ 每资源 `channel.downloadResourceToFile`(im v1 messageResource.get)→ profile mediaDir 缓存(24h GC,`start.ts:76,156`);`normalizeAttachments`(`src/media/attachment.ts:56`)按类型/大小/MIME→扩展名白名单做 accepted/rejected/skipped 决策;三路消费:prompt `<attachments>`(toPromptAttachment)、run-policy 校验(必需附件被拒则拒绝整个 run,F26)、codex `--image` 白名单(run-flow.ts:204-210)。
- **测试**:`tests/unit/media/attachment.test.ts`、`tests/integration/media/attachment-resolver.test.ts`、`tests/integration/bot/attachment-run-flow.test.ts`。

## F26 权限模式与运行策略【已确认】

- **实现**:`evaluateRunPolicy`(`src/policy/run-policy.ts:95-130+`):access(ok)→ folder allowlist(未验证即拒)→ 必需附件校验 → `clampAccess(defaultAccess, maxAccess, capability.maxAccess)` 取最严 → 映射 claude permissionMode(bypassPermissions/acceptEdits/plan)/ codex sandbox(danger-full-access/workspace-write/read-only);p2p claude 默认强制 bypassPermissions(`claudeP2pAutoApprove`,`schema.ts:426`);产出 `policyFingerprint`(access+resource+attachment 摘要,`src/policy/fingerprint.ts:34`)与 5min TTL——指纹变化视为不同会话身份(影响 F22 续接与 F19 回调)。
- **配置**:`permissions.defaultAccess/maxAccess`(新 profile 默认 full);legacy `sandbox` 字段自动迁移。
- **测试**:`tests/unit/policy/run-policy.test.ts`、`fingerprint.test.ts`、`tests/unit/config/claude-p2p-auto-approve.test.ts`。

## F27 访问控制 ACL 管理【已确认】

- **实现**:`/invite`/`/remove`(`commands/index.ts:1672/1785`)维护 allowedUsers/allowedChats/admins(经 `resolveUserNames` 把 @mention 解析成 open_id;`/invite all group` 用 `controls.knownChats`(F05 定时刷新)批量);owner 身份由 `createOwnerRefreshController`(`src/policy/owner.ts:47`)30min 从飞书刷新,失败进入降级态(ownerRefreshState);`/config` 内可调 `requireMentionInGroup` 等。改动写 config.json,下一条消息生效。
- **测试**:`tests/unit/policy/access.test.ts`、`tests/integration/commands/access-config-race.test.ts`(并发写)、`tests/integration/policy/owner-refresh.test.ts`。

## F28 配置、profile 与密钥库【已确认】

- **实现**:配置三层:RootConfig v2(`~/.lark-channel/config.json`,多 profile+active,`config/profile-schema.ts:105`)/ ProfileConfig(agentKind、codex、permissions、access、workspaces、attachments、larkCli、secrets)/ AppConfig(运行时合成,`runtimeProfileConfig`,`profile-store.ts:146`)。写路径统一 `withConfigFileLock`。App Secret 支持:`keystore.ts` 加密存储(scrypt 派生 key,`secrets.enc`+salt)、`${VAR}` 环境变量、SecretRef(env/file/exec/keystore)——`resolveAppSecret`(`secret-resolver.ts`)在每次 startChannel 重解析(支持 /account 热换);`secrets get` 子命令是 exec-provider 协议(供 lark-cli bind 调用,`src/cli/index.ts:213`)。`/config`(`handleConfig`)表单卡改 preferences;`/account`(`handleAccount`)换 app 凭据→ `controls.restart()` 热重连。v1→v2 迁移:`migrate.ts` + `migrate-v2.ts`。
- **测试**:`tests/unit/config/*`(8 个)、`tests/integration/config/profile-migration.test.ts`、`tests/integration/cli/secrets-profile.test.ts`。

## F29 云文档评论触发【已确认】

- **场景**:文档/表格评论里 @bot,同线程回复。
- **实现**:`handleCommentMention`(`src/bot/comments.ts:84-200+`):门槛(必须 @bot、fileType ∈ {doc,docx,sheet,file}(`:45`)、非 bot 自回复)→ `resolveCommentTarget` → `fetchCommentContext`(评论+回复+文档摘要,无权限 code 1069307 静默)→ `buildCommentPrompt`(`:445`)→ 独立 run(scope=comment 线程,文档级 docSessionScopeId 复用,无绑定 cwd 时回退用户 home)→ 回复写回评论线程。
- **测试**:`tests/integration/comments/*`(4 个)。

## F30 日志、诊断与遥测【已确认】

- **实现**:`src/core/logger.ts` — 按日 JSONL(`logs/bridge-YYYYMMDD.jsonl`)、事件/阶段/上下文三段式、`withTrace` 贯穿 chatId/msgId、secret 脱敏(`redactDiagnosticText`,覆盖 secret-resolver 全部来源形态)、保留期 `LARK_CHANNEL_LOG_DAYS`(默认 30 天,`logger.ts:15`);可选遥测:`LARK_CHANNEL_TELEMETRY_MODULE` 动态加载外部 AdapterFactory(`core/telemetry.ts`),失败一律 noop。
- **/doctor 会发起真实 agent run**(2026-10-24 交叉验证补充):`handleDoctor`(`commands/index.ts:1245-1503`)以 `nowait:true`、独立 scope `${scope}:doctor`(`:1358-1359`)提交一次诊断 run;群聊中先在群内确认、结果私信操作者(`:1346-1349`);这是 `nowait` 提交路径的**唯一**调用方。
- **测试**:`tests/unit/core/logger-redaction.test.ts`、`tests/integration/commands/doctor-redaction.test.ts`、`tests/unit/observability/logger.test.ts`。

## F31 用量账本与反馈投票【已确认】

- **实现**:`LedgerStore`(`src/observability/ledger.ts:75`):run 结束 record(tokens/cost/用户/chat/replyMessageId,`channel.ts:1069-1088`);👍/👎 双通道:原生表情 reaction(`channel.ts:342-354`)与卡片按钮(`fb`,F19)共享一人一票;`registerFeedbackCard` 支持点击后刷新计数;`/report`(`handleReport`)出汇总卡(`report-format.ts`)。
- **测试**:`tests/unit/observability/ledger.test.ts`、`tests/integration/bot/card-usage-footer.test.ts`。

## F32 进程注册表与运行时锁【已确认】

- **实现**:`registry.ts` — 启动 `register`(`:132`,id/pid/appId/profile/botName),退出三重清理(stop/exit/unregisterSync+cleanupTmpFiles);`ps`/`kill` 与 `/ps`/`/exit` 读注册表(`readAndPrune` 按 pid liveness 清理);`sameAppLiveOthers` 同 app 冲突交互处置(`start.ts:162-173,484-527`)。`locks.ts` — profile 锁+app 锁(proper-lockfile),冲突走 `RuntimeLockConflictError` → 交互确认杀旧重试(`start.ts:391-397,531-564`)。
- **测试**:`tests/integration/runtime/registry.test.ts`、`tests/unit/runtime/locks.test.ts`、`tests/unit/cli/start-runtime-lock-conflict.test.ts`。

## F33 回复线程化策略【已确认】

- **实现**:`shouldReplyInThread(mode, threadId, replyInThreadInGroup)`(`src/bot/thread-policy.ts:12`):话题群线程内回复必进线程;普通群受 `/config` 的 replyInThreadInGroup 开关;p2p 永不线程化。统一在 `runAgentBatch` 算出 `sendOpts` 供所有发送点复用(`channel.ts:756-761`)。
- **测试**:`tests/unit/bot/thread-policy.test.ts`;设计文档 `docs/superpowers/specs/2026-06-30-group-thread-reply-design.md`。

## F34 lark-cli 身份策略【已确认】

- **场景**:agent 会话内经 lark-cli 操作飞书,身份可切 bot/用户。
- **实现**:profile 级隔离(`~/.lark-channel/profiles/<p>/lark-cli`,env `LARKSUITE_CLI_CONFIG_DIR`);策略两档 `bot-only`(默认)/`user-default`(`src/lark-cli/identity-policy.ts`,`applyLarkCliIdentityPolicy`);`/config` 切换、`/status` 显示(`lark-cli: app|user-ready`);`profile-projection.ts` 把 bridge 凭据投影给 lark-cli,`legacy-source-overlay.ts` 兼容旧 source。agent 侧系统提示明令不得绕过该环境(`BRIDGE_AGENT_INSTRUCTIONS`,`channel.ts:83-88`)。
- **测试**:`tests/unit/lark-cli/*`、`tests/unit/config/profile-daemon-env.test.ts`。

---

## 证据缺口与下一步调查方向

| 缺口 | 断点位置 | 下一步 |
|---|---|---|
| `SessionCatalog.gc` 无生产调用点 | `src/session/catalog.ts:161-195`(有实现+测试,grep 无 src 调用) | 向上游确认是否有意;否则 catalog 无限增长 |
| `botAdded` SDK 事件未注册 | SDK EventMap 有(`.d.mts:272-298` 区段),`channel.on({...})` 未挂 → 新拉群最长 30min 才进 knownChats | 确认是否设计取舍;验证 `/invite all group` 在新群的时效 |
| thread_context marker 的全部清除路径 | 设计说 /new、/cd、/ws use、rotation 均清,仅抽样验证 | grep `markThreadContextInjected`/clear 交叉核对 |
| QR 注册 API 细节 | `@larksuite/channel` SDK 内部 | 需要时读 node_modules SDK 源码(.mjs) |
| SDK dedup 默认 TTL/容量 | SDK 实现内部(类型注释已确认存在 dedup/stale 机制) | 读 SDK dist/index.mjs 对应段 |
| headless `stream-json.ts` 事件映射细节 | `translateEvent`(`src/agent/claude/stream-json.ts:129`)未逐行;headless 是否回写 sessionId 未确认 | 读该文件 + tests/process/claude-headless-adapter.test.ts |
| codex `ProtocolDriftState` 触发条件 | `src/agent/codex/jsonl.ts:6-9` | 读该文件 |
| SDK 打字机 30k 滚卡后 messageId 衔接 | 影响 ledger replyMessageId 归因 | 读 SDK stream 实现 |
| codex-history 读的 rollout 文件格式 | `src/session/codex-history.ts` 未逐行读 | 读该文件 + codex CODEX_HOME 目录结构 |
| 小文件职责(jcs/preview/scope/comment-resource/agent-detection/prompt) | 各 <120 行未读 | 按需补读 |
| README 命令表缺 `/account` `/doc` `/report` | README.md:141-162 vs handlers 注册表 | 属文档滞后,已由 `tests/unit/docs/readme-contract.test.ts` 部分覆盖 |

**2026-10-24 交叉验证已解决的缺口**(原表项移除):`/doc` 为兼容性占位命令(`commands/index.ts:524-527` 仅回提示文案);命名工作区隔离键 = `profile␟owner␟scope␟name` 四段(`:530-569`);`nowait` 唯一调用方 = `/doctor`(`:1358`);`/config` 表单 9 个设置项(message_reply / tool_call_display / tool_call_display_in_groups / max_concurrent_runs / run_idle_timeout_minutes / require_mention_in_group / reply_in_thread_in_group / claude_driver / lark_cli_identity,`src/card/config-card.ts:109-286`);`LARK_CHANNEL_LOG_DAYS` 默认 30 天(`logger.ts:15`)。完整验证记录见 [analysis-gaps.md](./analysis-gaps.md)。

> 核心链路(消息→Agent→回传)的逐步追踪与完整时序图见 [flows/message-to-agent.md](./flows/message-to-agent.md) 与 [flows/streaming-response.md](./flows/streaming-response.md);两文末尾的"待验证问题"与上表互补。
