# 命令清单(主机 CLI + 飞书聊天命令)

> 状态:正式知识库文档(已验证)。引用规范:`src/相对路径 → 符号()`。
> 已知上游文档滞后:README 命令表缺 `/account` `/doc` `/report`(handlers 中存在);本文以代码为准。

## 1. 主机 CLI(终端,`src/cli/index.ts` commander 注册,入口 `bin/lark-channel-bridge.mjs` → dist/cli.js)

| 命令 | 作用 | 实现 | 备注 |
|---|---|---|---|
| `run` | 前台运行 bridge;首跑触发 QR 向导 | `src/cli/commands/start.ts → runStart()` | 旧版本的 start;选项 `-c/--profile/--agent/--workspace/--app-id/--app-secret/--tenant/--skip-check-lark-cli` |
| `start` | 安装并启动 OS 守护进程 | `src/cli/commands/service.ts → runServiceStart()` → `src/daemon/service-adapter.ts → getServiceAdapter()` | launchd(macOS)/ systemd(Linux)/ schtasks(Windows) |
| `stop` / `restart` / `status` / `unregister` | OS 服务管理(均 `--profile`) | `src/cli/commands/service.ts` | |
| `profile list / create <name> / use / remove / export` | 多 profile 管理 | `src/cli/commands/profile.ts` | create 选项同 run;remove 默认归档,`--purge --yes` 永删;export 默认脱敏 `--include-secrets --yes` 带密 |
| `migrate` | v1 配置/状态迁入当前 profile 布局 | `src/cli/commands/migrate.ts` + `src/config/migrate-v2.ts` | |
| `ps` / `kill <id\|#>` | 列出/终止本机 bridge 进程 | `src/cli/commands/ps.ts`(读 `src/runtime/registry.ts`) | kill:SIGTERM→2s→SIGKILL |
| `secrets get / set / list / remove` | 加密密钥库管理 | `src/cli/commands/secrets.ts` | get 是 exec-provider JSON-RPC 协议(供 lark-cli bind 调用) |

## 2. 飞书聊天斜杠命令(`src/commands/index.ts`,handlers 注册表 19 个键,`/reset` 是 `/new` 别名)

入口:IM 文本 `src/commands/index.ts → tryHandleCommand()`;卡片按钮 `src/card/dispatcher.ts → handleCardAction()` → `runCommandHandler()` 复用同一 handler。命令即时处理并清空该 scope 积压消息。

**⭐ = 管理命令**(`ADMIN_COMMANDS` 集合,经 `src/policy/access.ts → canRunAdminCommand()` 鉴权:创建者/admin 可用)。

### 会话与工作目录

| 命令 | 作用 | 实现 | 效果 |
|---|---|---|---|
| `/new`、`/reset` | 重置当前会话 | `handleNew()` → interrupt + `archiveAllForScope` + `closeSession`(杀 PTY)+ `sessions.clear` | 若有运行中任务先中断;保留 `/timeout` 偏好 |
| `/new chat [name]` | 新建群并绑定新会话 | `handleNewChat()` → `src/bot/group.ts → createBoundChat()` | 建群+邀请发起者,**继承当前 cwd**,不动原 scope(需 `im:chat` 权限) |
| `/cd <path>` | 切换工作目录 | `handleCd()` → `src/policy/workspace.ts → resolveWorkingDirectory()` 校验 | **必然重置会话**(claude 不能跨 cwd resume) |
| `/ws list / save <name> / use <name> / remove <name>` ⭐ | 命名工作区 | `handleWs*()` + `src/workspace/store.ts` | 存储键为 `profile␟owner␟scope␟name` 四段(隔离);use 等价 /cd |
| `/resume [N] / use <nonce> / all [N]` | 恢复历史会话(仅私聊) | `handleResume()` / `applyResume()` + `src/session/history.ts`(扫 `~/.claude/projects`)/ `src/session/codex-history.ts` | 列表项为 10 分钟一次性 nonce;跨 cwd 恢复会先切工作区 |

### 运行控制

| 命令 | 作用 | 实现 |
|---|---|---|
| `/stop [<scope>]`(跨 scope ⭐) | 停当前任务 | `handleStop()` → `src/bot/active-runs.ts → interrupt()`;当前 scope 不回确认(卡片会标"已中断");卡片 stop 按钮同下游(经验签) |
| `/timeout [N\|off\|default] [comment:<scope>` ⭐(targeted)] | 会话级空闲看门狗 | `handleTimeout()` → `src/session/store.ts → setIdleTimeoutMinutes()`(1-120 clamp);off=0;default 清覆盖;无参显示当前值与来源 |

### 信息与诊断

| 命令 | 作用 | 实现 |
|---|---|---|
| `/status` | profile/agent/cwd/会话/身份/运行状态 | `handleStatus()` |
| `/help` | 帮助卡 | `handleHelp()` |
| `/report` ⭐ | 用量与反馈汇总 | `handleReport()` + `src/commands/report-format.ts`(数据 `src/observability/ledger.ts`) |
| `/ps` ⭐ | 本机 bridge 进程列表 | `handlePs()`(读 registry,高亮自己) |
| `/exit <id\|#>` ⭐ | 停止 bridge 进程 | `handleExit()`(自瞄检测) |
| `/doctor [描述]` ⭐ | 低敏感诊断 | `handleDoctor()` → **发起一次 nowait agent run**(scope=`${scope}:doctor`);群聊中结果私信操作者;输出经 `src/core/logger.ts → sanitizeLogsForDoctor()` 脱敏 |
| `/doc` | **兼容性占位** | `handleDoc()`:仅回复"云文档评论现在不需要绑定工作区",无逻辑 |

### 配置与权限

| 命令 | 作用 | 实现 |
|---|---|---|
| `/config` ⭐ | 偏好设置表单卡 | `handleConfig()` + `src/card/config-card.ts`(9 项:回复模式/工具显示(p2p、群)/并发上限/空闲超时/群 @ 要求/群线程回复/claude driver/lark-cli 身份);下一条消息生效 |
| `/account` ⭐ | 换 app 凭据(热重连) | `handleAccount()` + `src/card/account-cards.ts` → `Controls.restart()`(connect-before-disconnect) |
| `/invite user\|admin\|group\|all group @目标` ⭐ | 加白名单 | `handleInvite()`(@mention 解析 open_id;all group 用 knownChats) |
| `/remove user\|admin\|group` ⭐ | 移除白名单 | `handleRemove()` |
| `/reconnect` ⭐ | 强制 WS 重连 | `handleReconnect()` → `Controls.restart()` |

## 3. 卡片按钮回调(非命令但同通路)

- **内置 cmd**:stop(孤儿点击友好应答)、fb(👍/👎 投票)、resume.use、config 表单提交等——经 `src/card/callback-auth.ts → CallbackAuth.verify()`(HMAC=App Secret、nonce 防重放、24h TTL、策略指纹绑定)后进入命令系统。
- **agent 自绘按钮**(`__bridge_cb` 标记):验签后回注 PendingQueue,成为该会话下一轮 agent 输入。
