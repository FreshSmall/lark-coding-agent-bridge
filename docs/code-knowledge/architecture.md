# 整体架构与模块交互

> 状态:正式知识库文档(已验证)。引用规范:`src/相对路径 → 符号()`。

## 1. 进程模型(已确认)

```
┌──────────────── bridge 进程(Node.js,单进程)────────────────┐
│  CLI 入口(src/cli)→ startChannel 装配(src/bot/channel.ts)  │
│  ├── WS 长连接(@larksuite/channel SDK ←→ 飞书开放平台)       │
│  ├── 消息管线:ACL → 命令/合批 → run-flow → RunExecutor       │
│  ├── Agent 适配:ClaudePty / ClaudeHeadless / Codex           │
│  ├── 渲染回传:RunState 状态机 → 卡片/流式文本                │
│  └── 横切:config/policy/session/media/ledger/logger          │
└──────────────────────────────────────────────────────────────┘
        │ 子进程                              │ 子进程
        ▼                                    ▼
claude TUI(node-pty,每会话长驻)     codex exec --json(每 run 一个)
        │ 读 ~/.claude/projects/…/<sid>.jsonl │ 读 stdout 行 JSON
        ▼                                     ▼
   AgentEvent 统一事件流(AsyncIterable)

OS 层:launchd/systemd/schtasks 守护 bridge 自身(src/daemon)
lark-cli:bridge 安装的外部 CLI,agent 会话内以 bot/用户身份操作飞书
```

要点:
- **单 bridge 进程承载全部逻辑**;无 Web 服务、无独立 worker;多 profile = 多 bridge 进程(各自 profile/app 锁互斥,`src/runtime/locks.ts`)。
- **Agent 事件流是唯一数据出口**:三种适配器都实现 `AgentRun.events: AsyncIterable<AgentEvent>`(`src/agent/types.ts`),上层不感知差异。
- **飞书侧零监听端口**:事件经 WS 推送进 SDK,SDK 归一化+去重后内存回调(见 flows/message-to-agent.md 阶段 0-1)。

## 2. 分层与依赖方向(已确认,单向无环)

| 层 | 目录 | 职责 | 可依赖 |
|---|---|---|---|
| 入口 | `src/cli` | commander 命令、启动编排、OS 服务、profile 管理、lark-cli 预检 | 全部 |
| 接入/编排 | `src/bot` | 事件路由、ACL 门、合批、run-flow、上下文获取、评论、keepalive | agent/card/commands/policy/session/runtime/config/media |
| 命令 | `src/commands` | 19 个聊天命令(依赖全经 `CommandContext`/`Controls` 参数注入,不持运行时单例) | 几乎全部(反向无人依赖它,除 card/dispatcher 复用) |
| Agent | `src/agent` | 三适配器 + prompt 组装 + preflight(**不依赖 bot/card/commands**) | config/permissions、core/logger |
| 呈现 | `src/card` | RunState 状态机、卡片/文本渲染、回调分发与验签 | commands(仅 dispatcher)、policy/session |
| 治理 | `src/runtime` | RunExecutor/EventFanout、进程注册表、锁、profile 解析 | agent/bot/policy |
| 策略 | `src/policy` | ACL、run-policy、workspace 边界、指纹、owner 刷新 | config |
| 配置 | `src/config` | schema/profile/keystore/secret 解析/权限映射 | platform |
| 会话 | `src/session` + `src/workspace` | 双会话存储、历史扫描、工作区表 | config/agent(jsonl-path) |
| 支撑 | `core`/`observability`/`media`/`lark-cli`/`platform`/`daemon`/`utils` | 日志/遥测/账本/附件/身份策略/spawn 封装/OS 服务 | — |

两个不可反向依赖的装配点:`src/cli/commands/start.ts → runStart()`(进程装配)与 `src/bot/channel.ts → startChannel()`(运行时装配)。

## 3. 关键设计决策(均已在对应文档验证)

| 决策 | 动机 | 位置 |
|---|---|---|
| Claude 用 PTY 长驻 TUI + **磁盘 JSONL 轮询**读输出 | claude TUI 无机器可读 stdout 协议;JSONL 是它原生写的结构化记录;PTY 保活让多轮对话零启动开销 | `src/agent/claude/pty-session.ts → runTurn()` |
| SDK 层关闭 chatQueue,自建合批 | 需要"运行期消息留到下一批 + 命令插队"的语义 | `src/bot/channel.ts → startChannel()`(safety.chatQueue=false)+ `src/bot/pending-queue.ts` |
| 双会话存储(SessionStore + SessionCatalog) | scope 单值快查 vs 身份四元组多值目录(跨 agent/跨 cwd/跨策略) | `src/session/store.ts`、`src/session/catalog.ts` |
| 策略指纹参与会话身份 | 权限/附件配置变更后不带旧上下文继续跑 | `src/policy/fingerprint.ts → policyFingerprint()` |
| 卡片用 CardKit 2.0 实体(createCard + updateCardById,sequence 递增) | 实体更新对按钮回调存活,结束后还能刷投票计数 | `src/card/managed.ts` |
| EventFanout 在无订阅者时即开泵 | 防"上层抛错→无人消费→cleanup 不跑→scope 永久锁死"泄漏 | `src/runtime/run-executor.ts → EventFanout` |
| 密钥库 AES-GCM + PBKDF2(hostname|username+salt) | 防误披露(备份/日志),明确不防同用户进程 | `src/config/keystore.ts → deriveKey()` |
| 终端两层日志脱敏 | 常规日志留本机诊断用;离开机器的通道(doctor/错误文案)才脱敏 | `src/core/logger.ts → redactDiagnosticText()/sanitizeLogsForDoctor()` |

## 4. 模块交互:五条主干通路(已确认)

1. **消息通路**:SDK → `channel.ts → intakeMessage()` → `pending-queue` → `runAgentBatch()` → `run-flow.ts → startRunFlow()` → `run-executor.ts → submit()` → 适配器 `run()` → `processAgentStream()` → `card/run-state.ts → reduce()` → `run-renderer.ts → renderCard()` → SDK 回传。详见 [message-flow.md](./message-flow.md)。
2. **命令通路**:intake/卡片回调 → `src/commands/index.ts → tryHandleCommand()/runCommandHandler()` → 各 handler →(可触发)`Controls.restart()/exit()` → `start.ts` 热重连/退出。
3. **会话通路**:run 期间 `system` 事件 → `run-flow.ts → recordRunSessionEvent()` → 双写 SessionStore/SessionCatalog;重置命令 → `archiveAllForScope + closeSession + sessions.clear`。详见 [flows/session-lifecycle.md](./flows/session-lifecycle.md)。
4. **取消通路**:`/stop` 或卡片按钮 → `active-runs.ts → interrupt()` → 适配器 `stop()`(PTY:ESC→SIGTERM→SIGKILL;子进程:SIGTERM→grace→SIGKILL)。详见 [flows/queue-and-cancellation.md](./flows/queue-and-cancellation.md)。
5. **进程治理通路**:启动 `registry.ts → register()` + `locks.ts` 双锁;退出三重清理(stop/exit 钩子/兜底 unregisterSync);同 app 冲突交互处置。详见 [flows/process-lifecycle.md](./flows/process-lifecycle.md)。

## 5. 并发模型(已确认)

| 结构 | 粒度 | 上限 | 超限行为 |
|---|---|---|---|
| SDK dedup + stale 窗口 | messageId | SDK 内部 | 静默丢弃 |
| PendingQueue(block/unblock) | scope | 1(串行) | 运行期消息积压到下一批 |
| ActiveRuns.reserve | scope | 1(第二道锁) | RunRejected('run-already-active') |
| ProcessPool.acquire | 全 profile | `preferences.maxConcurrentRuns` | FIFO 排队(nowait 路径拒绝) |
| ClaudePtyPool | sessionId | **无上限**,30min 空闲回收【设计取舍,见 analysis-gaps.md G20】 |

超时三级:适配器级(maxSilenceMs 15min / maxTurnMs 默认关)、通道级 idle watchdog(`/timeout` 可 per-scope 覆盖,默认关)、用户级(检查点卡"立即终止");工具 in-flight 与 AskUserQuestion 待答会暂停计时。
