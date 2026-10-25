# 机制:Agent 接入与进程管理(Claude Code / Codex)

> 生成时间:2026-10-24。分支 `feat/topic-root-context`。
> 配套 flow 文档:[flows/process-lifecycle.md](./flows/process-lifecycle.md)(子进程从生到死)。
> 主链路上下文:[flows/message-to-agent.md](./flows/message-to-agent.md) 阶段 7。

## 0. 解决的问题

把两种形态迥异的 CLI 编码 agent 统一成一套异步事件流接口:claude 是**交互式 TUI**(无机器可读 stdout 协议、靠终端按键交互),codex 是**一次性 exec 进程**(stdin/stdout JSON)。上层(bot/channel、RunExecutor、卡片渲染)完全不感知差异。

## 1. 公共契约(已确认,src/agent/types.ts)

```ts
interface AgentAdapter {
  id; displayName;
  isAvailable(): Promise<boolean>;          // 启动前诊断
  checkAvailability?(): Promise<AgentAvailability>;  // 结构化诊断(preflight.ts)
  prepareRun?(opts: AgentRunOptions): Promise<void>; // spawn 前校验(codex 复检二进制)
  run(opts: AgentRunOptions): AgentRun;     // ★ 返回事件流句柄
  setBotIdentity?(identity): void;          // WS 握手后晚绑定 bot open_id(写进系统提示)
  closeSession?(sessionId): Promise<void>;  // Lark 会话重置时释放资源(杀 PTY)
  shutdown?(): Promise<void>;               // bridge 退出时全量清理
}
interface AgentRun {
  events: AsyncIterable<AgentEvent>;        // 唯一数据出口
  stop(): Promise<void>;                    // 取消(SIGTERM→SIGKILL / ESC→硬杀)
  waitForExit(timeoutMs): Promise<boolean>; // 等 agent 自己退(终态后 2s 宽限用)
  answerQuestion?(input): Promise<void>;    // AskUserQuestion 回写(仅 claude PTY)
  resetIdleCheckpoint?(): Promise<void>;    // 用户"继续等"重置检查点节奏
}
```

`AgentEvent` 十种:`system(sessionId/threadId/cwd/model)`、`text`、`thinking`、`tool_use`、`tool_result`、`idle_checkpoint`(3/10/30min)、`ask_user_question`、`usage`、`done(terminationReason: normal|interrupted|timeout)`、`error(failed|interrupted|timeout)`(`types.ts:69-123`)。

**能力声明**(`src/agent/capability.ts`):`claudeCapability`(sessionKind=claude-session,promptInjection=`append-system-prompt`,supportsNativeHistory=true)/ `codexCapability`(codex-thread,`stdin-prefix`,false)。maxAccess 取 profile `permissions.maxAccess`。

## 2. 三种实现对比(全部已确认)

| 维度 | ClaudePtyAdapter(默认) | ClaudeHeadlessAdapter | CodexAdapter |
|---|---|---|---|
| 文件 | `agent/claude/pty-adapter.ts` | `agent/claude/adapter.ts` | `agent/codex/adapter.ts` |
| 进程模型 | **每 Lark 会话一个长驻 TUI**(`ClaudePtyPool`,30min 空闲回收) | 每 run 一进程 | 每 run 一进程 |
| 启动命令 | `claude --permission-mode <m> (--resume <id>\|--session-id <uuid>) --append-system-prompt <bridge提示> [--model <m>]`(`pty-adapter.ts:187-193`) | `claude -p <prompt> --output-format stream-json --verbose --include-partial-messages --permission-mode <m> --append-system-prompt <…> [--resume] [--model]`(`adapter.ts:60-76`) | `codex exec --sandbox <mode> -c approval_policy="never" -c shell_environment_policy.inherit="all" [--ignore-user-config] [--ignore-rules] --skip-git-repo-check -C <cwd> [--image…] (resume <threadId>\|空) --json -`(`codex/argv.ts:22-57`) |
| 输入 | PTY 按键:prompt 折单行 → write → 200ms → `\r`(`pty-session.ts:349-352`);AskUserQuestion 数字键+Tab+Enter | 不发(命令行参数) | **stdin 一次写入** prompt 前置系统提示(`adapter.ts:154`) |
| 输出读取 | **磁盘 JSONL 轮询 300ms**(`JsonlReader`,claude 自己写的 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`);PTY stdout 仅用于就绪/consent/诊断 | stdout 逐行 JSON | stdout 逐行 JSON |
| 翻译器 | `JsonlTurnTranslator`(turn_duration 终止、synthetic 跳过、humanLabel、todos) | `createStreamJsonTranslator` | `CodexJsonlTranslator`(thread.started→system(threadId);turn.completed→done;turn.failed→error;含 ProtocolDriftState) |
| 环境注入 | `buildLarkChannelEnv`:`LARK_CHANNEL=1 / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR`(profile 私有 lark-cli)+ `CODEX_HOME` 隔离(仅 codex,`adapter.ts:101-107`) | 同左 | 同左 |
| 权限参数 | `--permission-mode`(bypassPermissions/acceptEdits/plan) | 同左 | `--sandbox`(danger-full-access/workspace-write/read-only)+ approval never |
| stop() | `PtySession.terminate`:ESC 软中断 5s → SIGTERM 3s → SIGKILL(`pty-session.ts:494-537`) | child.kill SIGTERM → grace → SIGKILL(`adapter.ts:132-153`) | 同 headless 模式(`adapter.ts:161-180`) |
| waitForExit | 恒 true("turn 结束即 exit",PTY 存活是特性,`pty-adapter.ts:150-156`) | 等 child exit | 等 child exit |
| 会话续接 | `--resume <id>`(JSONL 存在时)否则 `--session-id <uuid>` 预分配 | `--resume` | `resume <threadId>` 子命令 |
| 专属能力 | answerQuestion / resetIdleCheckpoint / closeSession(release PTY) | —— | images(--image) |

**驱动选择**:`createRuntimeAgent`(`cli/commands/start.ts:430-474`):codex → CodexAdapter;`getClaudeDriver(cfg)==='headless'` → headless;否则 PTY(默认,`config/schema.ts:343-347`)。

## 3. Claude PTY 独有机制(已确认)

- **池**(`pty-pool.ts`):`Map<sessionId, {session, lastUsedAt}>`;命中条件=sessionId 存在且 isAlive;60s 扫描回收 idle>30min 或已死;`touch` 防活跃轮被回收。model/permissionMode 绑定在 **spawn 时**,池命中沿用旧的(`pty-pool.ts:13-16` 注释)。
- **就绪协议**(`pty-session.ts:201-228`):等 TUI 首次出数据后 1s 静默(或 30s 超时放行),consent 应答会重置静默窗。
- **consent 自动应答**(`:67-75`):ANSI 剥离后正则匹配两种首用对话框(trust-folder→`\r`;bypass-permissions 警告→`2\r`),每种只按一次键。
- **挂死防线**:`maxSilenceMs` 15min(JSONL 静默且无工具 in-flight)/`maxTurnMs` 墙钟(默认关)/空闲检查点 3/10/30min(只通知)。
- **bracketed-paste 规避**:prompt 与按键逐字节带间隔写(`:298-308`),否则 TUI 当粘贴处理,Tab/Enter 失效。

## 4. 存活检测与终止升级(已确认)

- 存活:PTY=`onExit` 回调置 `alive=false`(runTurn 下个循环察觉,yield error+缓冲尾);子进程模式=Node child 的 `error`/`exit` 事件 + `exitCode/signalCode` 判定。
- 终止升级(PTY):`softInterrupt`(ESC+5s)→ 仍 busy 则 `hardClose`(SIGTERM→3s→SIGKILL)。stop 按钮/`/stop` 都走 terminate(用户点了就该真停,`pty-adapter.ts` stop 注释)。
- RunExecutor 侧 `stopGraceMs`(`getAgentStopGraceMs(cfg)`)透传给适配器,给 lark-cli OAuth 之类子进程留清理时间(`types.ts:138-144` 注释)。

## 5. 异常分支

| 异常 | 适配器行为 |
|---|---|
| 二进制缺失 | `checkAgentAvailability`(preflight.ts)结构化诊断;codex prepareRun 抛 SpawnFailed |
| spawn 失败 | PTY:事件流首 yield error(`pty-adapter.ts:105-112`);子进程:无 pid/`child.on('error')` → error |
| claude TUI 意外退出 | runTurn `!alive` → error(exitCode+signal+尾 800 字) |
| consent 卡住/就绪超时 | 30s 超时放行继续跑(可能首条消息失败,用户重发) |
| codex 非零退出且未发终态 | error + stderr 尾 500 字(`adapter.ts:236-247`) |
| codex stdout 无输出即退出 | 50ms 定时器强销毁 stdout 防 readline 悬挂(`closeSilentStdout`,`adapter.ts:189-196`) |
| 协议漂移(codex) | CodexJsonlTranslator 记 drift 状态(具体降级动作【待验证】) |

## 6. 测试覆盖

`tests/unit/agent/claude-pty*.test.ts`(5 个:池、会话、consent、readiness)、`claude-jsonl-*.test.ts`(3 个)、`claude-stream-json.test.ts`、`codex-argv/jsonl/history/prepare-run.test.ts`、`preflight.test.ts`、`capability.test.ts`、`types-contract.test.ts`(契约静态校验);进程级:`tests/process/claude-headless-adapter.test.ts`、`codex-adapter.test.ts`(真实子进程);集成:`tests/integration/claude/pty-adapter.test.ts`(fixtures `claude-fake/claude.mjs` 假 TUI)。

## 7. 待验证问题

1. headless `stream-json.ts` 事件映射(129 行 `translateEvent` 未逐行;headless 无 system 回写,sessionId 靠 bridge 侧指定,推断不需回写)。
2. codex `ProtocolDriftState` 的消费方与降级行为。
3. PTY 池无全局上限(理论上活跃会话数 = 活跃聊天数;并发 run 受 ProcessPool 限制,但**空闲 PTY** 只靠 30min TTL 回收,无数量上限——设计取舍,未见 cap 代码【已确认不存在,推断为有意为之】)。
