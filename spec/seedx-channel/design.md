# Bridge 接入 seedx（公司 AI 网关）方案

> 状态：设计稿（只出方案，未改代码）
> 分支：`feat_seedx_channel`
> seedx 调研版本：`@seed/seedx 1.7.0`，claude `2.1.296`

## 0. 结论

- **推荐方案 A：在 bridge 里加一个 profile 级的「启动器（launcher）」开关**。打开 `seedx` 后，原来直接执行 `claude <args>` / `codex <args>` 的地方，改成执行 `seedx claude --permission-mode limited -- <args>` / `seedx codex --permission-mode limited -- <args>`。网关鉴权、本地代理、模型目录全部交给 seedx，bridge 不碰公司网关协议。
- 改动面集中在 **`src/agent/` 下 3 个拉起点 + preflight + 配置 schema**，预计约 150 行业务代码加单测。PTY / JSONL 解析 / 会话池这些主链路都不用动。
- 落地前必须先做 PoC，验证 **5 个待确认项**（见 §6），其中最关键的是 **codex 的 sandbox 是否会被 seedx 前置的参数覆盖**，以及 **进程树能不能杀干净**。
- 不推荐自己实现网关代理（方案 C）：要逆向公司内部 token 和网关协议，seedx 一升级就可能失效。

---

## 1. 背景与约束

- 公司要收回 Claude / Codex 的个人 key，以后终端 AI 只能经 seedx 走公司 AI 网关：
  - `seedx claude [args...]`：拉起 claude 终端
  - `seedx codex [args...]`：拉起 codex 终端
- bridge 目前直接 spawn 本机的 `claude` / `codex` 二进制，依赖本机已有的登录态或 key。key 收回后这条路走不通。
- 目标：bridge 拉起 agent 时经 seedx 接入网关，**飞书侧的用户体验和现有能力（PTY 会话池、resume、权限档、AskUserQuestion、codex sandbox）保持不变**。

## 2. 现状：bridge 的 agent 拉起点

| # | 位置 | 方式 | 参数特征 |
|---|------|------|----------|
| 1 | `src/agent/claude/pty-adapter.ts` `spawnSession()` → `pty.ts` `spawnPty()` | node-pty，交互式 TUI，**默认驱动** | `--permission-mode X`、`--session-id/--resume`、`--append-system-prompt`、`--model` |
| 2 | `src/agent/claude/adapter.ts` `ClaudeHeadlessAdapter.run()` | cross-spawn，stdout 是 stream-json | `-p <prompt> --output-format stream-json ...` |
| 3 | `src/agent/codex/adapter.ts` `CodexAdapter.run()` + `argv.ts` | cross-spawn，stdout 是 JSONL，prompt 走 stdin | `exec --json --sandbox X -c approval_policy="never" ... -` |
| 4 | `src/session/codex-history.ts` `spawnCodexAppServer()` | `codex app-server --listen stdio://` | 只读本地历史，**不调模型** |
| 5 | `src/agent/preflight.ts` `checkAgentVersion()` | `<bin> --version`，超时 5s | 取 stdout 第一行当版本号 |

二进制来源：
- codex 用 `profile.codex.binaryPath`（已经可以配置）
- claude 写死了 `'claude'`：`start.ts#createRuntimeAgent` 构造 `ClaudePtyAdapter` 时**没有传 `binary`**

## 3. seedx 机制调研（读源码 + 实测）

### 3.1 `seedx claude|codex` 实际做了什么

源码：`~/.local/node-v24.18.0/lib/node_modules/@seed/seedx/dist/cli.js`，函数 `runPlainSession` → `openForegroundProxy` → `spawnPlainAgent`。

1. **拿网关授权**：先找 seedx daemon（master，通过 unix sock）拿 token，拿不到就用 `~/.seedx-workspace/credentials.json` 里的长票直接刷新。预算 5s（`GATEWAY_ACQUIRE_BUDGET_MS`）。
2. **在 seedx 进程内起一个本地 HTTP 代理**（`startAgentProxy`，监听 `127.0.0.1:<随机端口>`）。代理会剥掉请求里的 `authorization/x-api-key`，换上网关 token 后转发上游，token 过期时自动刷新。
   - **代理的生命周期跟 seedx 进程绑定**：seedx 退出，代理就没了。
3. **把网关注入给 agent**：
   - claude：写一个临时 settings 文件 `~/.seedx.../claude-proxy-<pid>.json`，里面有 `env.ANTHROPIC_BASE_URL=<proxy>`、`ANTHROPIC_AUTH_TOKEN=seedx-local-proxy`，以及模型选择器和 context window 配置。再执行
     `claude --settings <file> <权限档参数> <透传参数>`
   - codex：通过 env 注入 `OPENAI_BASE_URL/OPENAI_API_KEY`，再执行
     `codex -c model_provider="seed-gateway" -c model_providers.seed-gateway.* <模型目录参数> <权限档参数> <透传参数>`
4. 用 `stdio: "inherit"` spawn 子进程，等它退出后关掉代理。
5. 权限档参数：
   - claude：`full` → `--dangerously-skip-permissions`；`limited` → `--permission-mode default`
   - codex：`full` → `--dangerously-bypass-approvals-and-sandbox`；`limited` → `-s workspace-write -a on-request`
6. 可以覆盖底层二进制：`SEEDX_CLAUDE_EXECUTABLE`（必须是绝对路径）、`SEEDX_CODEX_BIN`。

### 3.2 实测结论

```text
$ env -u CLAUDE_CODE_CHILD_SESSION ... seedx claude --permission-mode limited -- --version
exit=0  耗时≈1.2s
stdout:
  agent=claude · 权限=受限
  额度预检: Claude 剩余$48.8 · GPT 剩余$147.1 (02:00 重置)
  拉起 claude 会话(不绑需求)…
  2.1.296 (Claude Code)
stderr:
  带了 --version,本次不建网页联动会话,原样交给 claude
```

| 发现 | 对 bridge 的影响 |
|------|------------------|
| `--` 之后的参数原样透传，`--` 本身会被剥掉 | ✅ bridge 的参数整体放在 `--` 后面即可，避免和 seedx 自己的 `--permission-mode`、`--cwd` 撞名 |
| bridge 的参数里有 `--session-id`、`exec`、`-p`，按 `plainSessionLink` 的规则**不会进入"网页联动会话"**，走的是纯透传 | ✅ 不会被 seedx 换掉 sessionId |
| **stdout 前面多出 3 行横幅**（权限档、额度、"拉起…"） | codex/headless：两边的 JSONL 解析都会 `JSON.parse` 失败后 `continue`，**可以容忍**；PTY：横幅只出现在屏幕缓冲里，事件取自 transcript JSONL，影响很小；preflight：第一行会被当成"版本号"，**需要改** |
| **在 agent 会话里调用时，seedx 只打一句话就 `exit 0`，不会拉起任何东西**。判定的 env 有 `SEEDX_CHILD_SESSION=1`、`CLAUDE_CODE_CHILD_SESSION=1`、`CODEX_THREAD_ID`、`CODEX_SANDBOX`、`AGENT=codex` | ⚠️ **静默失败的坑**：如果 bridge 是从 Claude Code 终端里启动的（env 里带 `CLAUDE_CODE_CHILD_SESSION=1`），每次 spawn 都会悄悄退出。**必须在 spawn 前把这些 env 剥掉** |
| 每次拉起多约 1.2s（拿 token + 额度预检） | PTY 会话池复用，只有首轮受影响；codex exec 每轮都要多付这 1.2s |
| seedx 是 `#!/usr/bin/env node` 脚本 | daemon 的 PATH 里必须有 node 和 seedx。`launchd.ts` 会在安装服务时抓取当前 shell 的 PATH，从装了 seedx 的 shell 里执行 `start` 就行 |

## 4. 方案对比

| | A. 内置 launcher（推荐） | B. 外部 wrapper 脚本 | C. bridge 自己实现网关代理 |
|---|---|---|---|
| 做法 | profile 加 `agentLauncher: seedx`，在拉起点统一改写 `file/args/env` | 写 `claude-seedx` / `codex-seedx` shell 脚本，`exec seedx claude --permission-mode limited -- "$@"`，再把 bridge 的 binary 指过去 | 读 seedx 的凭证文件，自己起代理、注入 `ANTHROPIC_BASE_URL` |
| bridge 代码改动 | 约 150 行 | claude 的 binary 需要能配置（约 10 行），其他靠脚本 | 大，而且要逆向内部协议 |
| `--version` 预检 | 改成检查 `seedx --version` | 脚本里要特殊处理 | — |
| codex app-server（读历史） | 继续用原生 codex | 脚本里要分流 `app-server`，否则横幅会污染 JSON-RPC | — |
| 剥离 agent-host env | 代码里统一处理，有单测 | 脚本里 `unset`，容易漏 | — |
| 进程组回收 | 能在 adapter 里改成按进程组 kill | 脚本做不到 | — |
| 分发和可见性 | 一个配置项，`/status` 里看得到 | 用户机器上散落脚本，不好排查 | — |
| 跟随 seedx 升级 | 跟着 CLI 契约走，稳定 | 同 A | 很脆弱 |

**选 A**。B 可以当 **PoC 阶段的临时验证手段**，用来在不改代码的情况下先跑通 §6 的待验证项。

## 5. 方案 A 详细设计

### 5.1 配置

`ProfileConfig`（`src/config/profile-schema.ts`）新增一个可选字段：

```ts
export interface AgentLauncherConfig {
  kind: 'seedx';
  /** seedx 可执行文件，默认 'seedx'（走 PATH） */
  binaryPath?: string;
}

export interface ProfileConfig {
  // ...
  agentLauncher?: AgentLauncherConfig;   // 缺省 = 直连（现有行为）
}
```

- 在 `normalizeProfileConfig` 里校验：`kind` 只能是 `'seedx'`，否则报错。
- 字段缺省时行为和现在完全一致，**不需要做迁移**。
- 暂不做飞书配置卡片里的切换入口（YAGNI）。手动改 config，或之后按需加 CLI 参数。

### 5.2 新增 `src/agent/launcher.ts`（唯一的改写点）

```ts
const AGENT_HOST_MARKERS = [
  'SEEDX_CHILD_SESSION', 'CLAUDE_CODE_CHILD_SESSION',
  'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AGENT',
];

export interface LaunchSpec { file: string; args: string[]; env: Record<string, string | undefined> }

export function applyLauncher(
  launcher: AgentLauncherConfig | undefined,
  agent: 'claude' | 'codex',
  spec: LaunchSpec,
): LaunchSpec {
  if (!launcher) return spec;
  const env = { ...spec.env };
  for (const k of AGENT_HOST_MARKERS) delete env[k];
  // 用户在 bridge 里配置了具体的底层二进制时，交给 seedx 用
  if (spec.file !== agent) {
    if (agent === 'claude') env.SEEDX_CLAUDE_EXECUTABLE = spec.file; // 要求是绝对路径
    else env.SEEDX_CODEX_BIN = spec.file;
  }
  return {
    file: launcher.binaryPath ?? 'seedx',
    args: [agent, '--permission-mode', 'limited', '--', ...spec.args],
    env,
  };
}
```

设计要点：
- **seedx 档位固定传 `limited`**，真正的权限语义由 bridge 自己的参数决定，这些参数排在后面（见 5.4）。
- `AGENT=codex` 这个变量名比较通用，只在 seedx 模式下剥掉，直连模式不受影响。
- 横幅照样输出，靠现有解析器的容错吸收，不额外过滤。

### 5.3 各拉起点的改动

| 拉起点 | 改动 |
|--------|------|
| `ClaudePtyAdapter.spawnSession` | 拼好 `args/env` 后调用 `applyLauncher`，再交给 `spawnPty`。构造参数加 `launcher?` |
| `ClaudeHeadlessAdapter.run` | 同上，在 `spawnProcess` 前调用 |
| `CodexAdapter.run` | 同上。`CODEX_HOME` 等 env 要在 `applyLauncher` 之前合入（seedx 会原样透传 env） |
| `codex-history.ts` | **不改**，继续用原生 codex（只读本地 rollout，不调模型，走 seedx 反而会污染 JSON-RPC） |
| `start.ts#createRuntimeAgent` | 从 `profileConfig.agentLauncher` 取值传给三个 adapter |

### 5.4 权限档映射

| agent | seedx 前置参数（limited） | bridge 后置参数 | 预期生效 |
|-------|------------------------|---------------|---------|
| claude | `--settings <f> --permission-mode default` | `--permission-mode <bridge 配置，默认 bypassPermissions>` | 后者覆盖前者（commander 的单值选项后出现的生效，**待 PoC #2**） |
| codex | `-c model_provider... -s workspace-write -a on-request` | `exec --json --sandbox <X> -c approval_policy="never" ...` | exec 子命令的 `--sandbox` 生效，exec 模式下审批强制为 never（**待 PoC #1**） |

不用 `full` 档的原因：`--dangerously-bypass-approvals-and-sandbox` 会无视 bridge 配置的 `read-only/workspace-write`，破坏 bridge 的 sandbox 策略。

### 5.5 Preflight

`checkAvailability()` 在 seedx 模式下改成：
1. `seedx --version`：确认 seedx 能跑，耗时很短，**不会启动代理**。
2. 不在预检里检查登录态：`seedx status` 要请求服务端，放进启动路径会拖慢 `start`。登录失效的问题放到运行期透出（见 5.7）。

底层 claude/codex 是否安装由 seedx 自己兜底（PATH 或 seedx 自带的版本）。

### 5.6 进程生命周期（必须处理）

seedx 的 `spawnPlainAgent` **没有转发 SIGTERM**，它退出后代理也跟着关闭：

- **codex / headless（pipe 模式）**：bridge 的 `child.kill()` 只会杀掉 seedx，codex/claude 会变成孤儿进程，一直对着已经关闭的代理重试。
  → 改成 `spawnProcess(..., { detached: true })`，stop/kill 时用 `process.kill(-pid, sig)` 按**进程组**发信号。只在 seedx 模式下这样做。
- **PTY 模式**：seedx 是 PTY 会话的 leader，它退出后内核会给前台进程组发 SIGHUP，claude 一般会跟着退出。但 `SIGKILL` 升级路径要实测确认（**待 PoC #3**）。如果有残留，`PtySession.terminate` 同样改成按进程组 kill。
- ESC 软中断直接写进 tty，由 claude 读取，不经过 seedx，没有影响。bridge 不发送 Ctrl-C（`\x03`），不会误杀 seedx 和它的代理。

### 5.7 错误透出

seedx 常见的失败情况：未登录或长票过期、网关不可用（代理返回 503 `seedx_gateway_unavailable`）、额度耗尽、`未拉起 agent: <模型目录错误>`。

- 拉起阶段失败：seedx 会把错误写到 stderr 并以非 0 退出。现有逻辑会把 stderr 记进日志，但飞书侧只显示 "failed to spawn"。
  → seedx 模式下，退出时把 **stderr 末尾约 500 字节**拼进错误事件的 message。如果命中 `login|登录|长票`，再追加一句提示："请在 bridge 所在机器终端执行 `seedx login`"。
- 运行期失败（503/429）：claude/codex 会把它当成 API 错误，走现有的错误事件链路，不用特殊处理。

### 5.8 模型

- seedx 会根据网关的模型目录注入默认模型（claude 用 `ANTHROPIC_DEFAULT_*`，codex 用 catalog）。
- bridge 里通过 `/model` 指定的模型名必须存在于网关目录中，否则上游会报错。这一点写进使用说明，不做校验（YAGNI）。

## 6. 风险与待 PoC 验证项

| # | 验证项 | 怎么验证 | 不成立时的兜底 |
|---|--------|----------|----------------|
| 1 | codex：根级的 `-s workspace-write -a on-request` 会不会覆盖 `exec --sandbox read-only` | 用 bridge 配成 read-only 跑一轮，看 `~/.codex/sessions/**/rollout-*.jsonl` 里 `turn_context.sandbox_policy` 的值 | 改为在 `exec` 后面再显式加一次 `-c sandbox_mode=...`；还不行就找 seedx 团队要一个"不注入权限参数"的选项 |
| 2 | claude：`--permission-mode` 出现两次时是不是后者生效 | `seedx claude --permission-mode limited -- --permission-mode acceptEdits`，在 TUI 状态栏里看实际模式 | 改成按 bridge 的模式映射：`bypassPermissions` 用 `full`，其他用 `limited`，并且不再追加 bridge 自己的参数 |
| 3 | 进程树回收：PTY 下 SIGTERM/SIGKILL seedx 之后，claude 有没有残留；pipe 模式下按进程组 kill 是否有效 | 在 pool release 后执行 `pgrep -f claude` | 按进程组 kill |
| 4 | PTY 模式下 transcript 路径不变（seedx 没改 `CLAUDE_CONFIG_DIR`/HOME），`sessionJsonlPath` 能找到文件 | 跑一轮后检查 `~/.claude/projects/<cwd>/<sid>.jsonl` | 检查 seedx 注入的 settings 文件，按需调整 jsonl-path |
| 5 | launchd/systemd 下的 daemon 能拿到网关 token（daemon env 没有 tty，也不是 CAS 交互环境） | 用 service 模式启动，在飞书里发一条消息 | `seedx daemon` 装成系统服务，保证 token 来自 master |

其他已知风险（接受）：
- 每次拉起多约 1.2s；每个 PTY 会话多一个 seedx node 进程（几十 MB）。
- seedx 的 CLI 契约（`--` 透传、`--permission-mode limited`、横幅输出到 stdout）将来可能变化。建议在 README 里写明已验证的 seedx 版本。
- seedx 每小时会跑一次 `seedx clean`，清理本机 Claude 的旧账号残留（钥匙串 OAuth 等）。之后直连模式基本用不了，这符合公司收 key 的预期。

## 7. 实施步骤

1. **PoC（不改代码）**：用方案 B 的 wrapper 脚本加上 `codex.binaryPath`，验证 §6 的 #1、#2、#4。claude 可以临时用 headless 驱动加 wrapper 验证。
2. 新增 `src/agent/launcher.ts` 并写单测（`tests/unit/agent/launcher.test.ts`）：
   - 直连模式原样返回
   - seedx 模式下 args 形如 `[agent, '--permission-mode', 'limited', '--', ...]`
   - 5 个 agent-host env 被剥掉，其他 env 原样保留
   - 自定义二进制会映射成 `SEEDX_CLAUDE_EXECUTABLE` / `SEEDX_CODEX_BIN`
3. 在 `profile-schema.ts` 加 `agentLauncher` 字段和 normalize 校验，补单测。
4. 3 个 adapter 接入 `applyLauncher`；`start.ts` 传参。
5. 按 §5.5 改 preflight；按 §5.6 改进程组 kill（只在 seedx 模式下）；按 §5.7 拼接 stderr 末尾。
6. 测试：`pnpm test:unit` → `pnpm typecheck` → 真机跑通飞书收发（claude PTY、claude headless、codex 三条链路，外加 resume 和 stop）。
7. 在 README 里补一段"接入 seedx"。

## 8. 使用方式（落地后）

```bash
# 1. 本机先登录 seedx（一次性，需要浏览器 CAS）
seedx login && seedx status

# 2. 在 profile 配置里打开
#    ~/.lark-channel/config.json → profiles.<name>.agentLauncher = { "kind": "seedx" }

# 3. 在装了 seedx/node 的 shell 里重启 bridge（这样服务文件会抓到正确的 PATH）
lark-channel-bridge start
```

## 9. 不做的事

- 不自己实现网关代理或 token 刷新（方案 C）。
- 不接 seedx 的"网页联动会话"和需求（story）绑定。bridge 只把 seedx 当成网关接入通道。
- 暂不做飞书卡片里的 launcher 切换和模型目录校验。

---

## 10. 实现记录（PoC 结论与对设计的偏差）

### 10.1 PoC 结论

| # | 结论 | 证据 |
|---|------|------|
| 1 | ✅ 不会覆盖 codex sandbox。seedx 实际拼出的参数是 `-s workspace-write -a on-request exec --json --sandbox read-only -c approval_policy="never" ...`，以 exec 子命令的参数为准 | rollout 里 `sandbox_policy={"type":"read-only"}`、`approval_policy=never`，执行 `touch` 报 `Operation not permitted` |
| 2 | ✅ claude 的 `--permission-mode` 出现两次时，后一个生效 | 在 `-- --permission-mode plan` 下，stream-json 的 init 里是 `"permissionMode":"plan"` |
| 3 | ✅ 进程能杀干净。PTY 和管道两种模式下，SIGTERM seedx 后都没有残留子进程 | `poc3.mjs`：pty / pipe / pipe-group 三种情况，descendants 都是 `[]` |
| 4 | ✅ transcript 路径没变 | `~/.claude/projects/-private-tmp-seedx-poc/<sid>.jsonl` 存在 |
| 5 | ⏳ 需要在真实的 launchd/systemd 部署里验证 | — |

### 10.2 相对设计稿的偏差

- **不做进程组 kill（§5.6 取消）**：PoC #3 已经证明不需要。
- **不把 bridge 配置的二进制交给 seedx**（`SEEDX_CLAUDE_EXECUTABLE`/`SEEDX_CODEX_BIN`）：由 seedx 自己选择 claude/codex（本机的或自带的版本）。`codex.binaryPath` 只用于 codex 历史读取（app-server），它不走 seedx。
- **不追加 stderr 提示（§5.7 取消）**：现有代码已经会把 stderr 前 500 字符（管道模式）或屏幕末尾 800 字符（PTY 模式）拼进错误信息，seedx 的报错原文能直接透出到飞书。
- **新增：PTY 就绪判定修复**（实测发现，设计稿没有预见到）：
  1. **假就绪**：seedx 先输出横幅，然后停下来拿 token、查额度（大于 1 秒），PtySession 把这段静默当成"TUI 已就绪"，于是把 prompt 写进了 claude 启动前的 tty，被丢掉了。
     → `PtySessionOptions.readyMarker`：seedx 模式下必须先看到 `\x1b[?2004h`（claude TUI 第一帧就会开启 bracketed paste），才开始计算静默窗口。
  2. **信任弹窗每次都出现，而且回车会被吞**：seedx 会往工作目录写入基线 `.claude/settings.json`（预批准了 `Bash(git *)` 等），claude 因此每个新会话都会弹出信任框，默认选项"No, continue without these permissions"不会记住选择。另外 claude 会忽略弹窗绘制后约 100ms 内的按键，而原逻辑正好在 100ms 时按回车，导致这次回车被吞，后面 prompt 末尾的回车反而把弹窗确认掉了，prompt 就丢了。
     → `consentDelayMs`：seedx 模式下改为 500ms，默认仍是 100ms。
     → 通用兜底：consent 按键发出后如果 claude 没有任何输出，就视为按键被吞；此时**不允许判定就绪**，每隔 1.5s 重发一次，最多 3 次。正常路径下不会触发。

### 10.3 改动清单

| 文件 | 改动 |
|------|------|
| `src/config/profile-schema.ts` / `profile-store.ts` | `agentLauncher?: { kind: 'seedx'; binaryPath? }`，校验和持久化白名单 |
| `src/agent/launcher.ts`（新增） | `applyLauncher` / `launcherBinary`：改写参数，剥离 5 个 agent-host 环境变量 |
| `src/agent/claude/pty-adapter.ts` / `claude/adapter.ts` / `codex/adapter.ts` | 拉起前调用 `applyLauncher`；seedx 模式下预检检查 `seedx --version` |
| `src/agent/claude/pty-session.ts` | `readyMarker`、`consentDelayMs`、consent 未处理时阻止就绪并重发 |
| `src/cli/commands/start.ts` | 把 `profileConfig.agentLauncher` 传给三个 adapter |
| 测试 | `launcher.test.ts`、`adapter-launcher-wiring.test.ts`、`profile-agent-launcher.test.ts`，以及 `claude-pty-session.test.ts` 新增 3 个用例 |

### 10.4 端到端实测（真实 seedx 1.7.0 + 网关）

| 链路 | 结果 |
|------|------|
| claude PTY：新会话、同 PTY 第二轮、shutdown 后 `--resume` 新开 PTY | ✅ 约 15s / 7s / 18s，上下文连续（能记住 4711），shutdown 后没有残留进程 |
| claude headless | ✅ 约 12s |
| codex exec（read-only） | ✅ 约 6s |
| 启动 bridge 的环境里带 `CLAUDE_CODE_CHILD_SESSION=1` | ✅ 已剥离，不再静默退出 |

### 10.5 已知副作用

- seedx 每次在工作目录启动时，都会写入公司基线：`.claude/ .codex/ .agents/ .harness/ .intent/ docs/`，以及 `.gitignore` 里的托管段。这是 seedx 自身的行为，在终端里直接用 `seedx claude` 也一样，bridge 不干预。

### 10.6 飞书 `/config` 开关（追加）

- `/config` 卡片新增"**模型通道**"选项：直连（默认）/ seedx（公司 AI 网关）。它读写的就是 `profile.agentLauncher`，切回直连时会删除这个字段；保持 seedx 不变时，原有的 `binaryPath` 会保留。
- 切到 seedx 之前先执行 `seedx --version` 预检。预检失败就整张表单都不保存，并提示"seedx 不可用"，避免配置写进去之后下次启动失败。
- 选项有变化时，复用 `/reconnect --wait` 的流程：先暂停接收新任务，等进行中的任务跑完，再按新配置重建 agent，不会打断正在运行的任务。
- 改动：`src/card/config-card.ts`、`src/commands/index.ts`。测试：`tests/unit/card/config-form-agent-launcher.test.ts`，以及 `tests/integration/commands/profile-config-command.test.ts` 新增 3 个用例。
- 追加：claude profile 在 `/config` 里切换"Claude 驱动方式"时，也会走同一套 `--wait` 自动重连。修复了原来"提示下条消息生效、实际要等重连才生效"的问题。
