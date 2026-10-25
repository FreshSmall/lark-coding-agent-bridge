# 项目全景:lark-coding-agent-bridge

> 状态:正式知识库文档,基于 2026-10-24 完成并交叉验证的源码分析(分支 `feat/topic-root-context`)。
> 引用规范:`src/相对路径 → 符号()`。除特别标注【待验证】外,所有结论均有源码证据(验证记录见 [analysis-gaps.md](./analysis-gaps.md))。

## 1. 项目是什么

**lark-channel-bridge**(npm 包名,仓库目录名 lark-coding-agent-bridge,上游 zarazhangrui/feishu-claude-code-bridge):一个 Node.js 长驻进程,把飞书 / Lark IM 与本地 CLI 编码 Agent(Claude Code、Codex CLI)双向桥接。用户在飞书私聊、群 @bot、话题或云文档评论里发消息,bridge 调用本地 `claude` / `codex` 执行,并把过程与结果以流式卡片回传飞书。

## 2. 技术栈(已确认)

| 项 | 值 | 证据 |
|---|---|---|
| 语言/运行时 | TypeScript 5.6+ strict,纯 ESM,Node >= 20.12.0 | `package.json`、`tsconfig.json` |
| 包管理 | pnpm 10.33.0 | `package.json → packageManager` |
| 构建 | tsup,双 entry:CLI(`src/cli/index.ts` → dist/cli.js,无 dts)与库(`src/index.ts` → dist/index.js + dts) | `tsup.config.ts` |
| 测试 | vitest 2.1.8,forks 池 maxForks=4(内存约束) | `vitest.config.ts`、`CLAUDE.md` |
| 飞书 SDK | `@larksuite/channel` ^0.1.2(内部包 `@larksuiteoapi/node-sdk`):WS 长连接、消息归一化、dedup、流式回复、卡片实体、媒体上传 | `src/bot/channel.ts → startChannel()`;SDK 类型 `node_modules/@larksuite/channel/dist/index.d.mts` |
| CLI 框架 | commander ^12 | `src/cli/index.ts` |
| PTY | node-pty ^1.0(驱动 claude TUI) | `src/agent/claude/pty.ts → spawnPty()` |
| 子进程 | cross-spawn(`src/platform/spawn.ts → spawnProcess()`) |
| 锁 | proper-lockfile(`src/runtime/locks.ts`) |
| 终端交互 | qrcode-terminal(QR 注册)、@clack/prompts(向导 UI) |

**无 Web 界面**(已 grep 验证无 http server / express):全部"界面"是飞书卡片(CardKit 2.0),详见 [web-ui.md](./web-ui.md)。

## 3. 运行与构建(已确认)

```bash
pnpm build        # tsup → dist/cli.js + dist/index.js
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run(全量);test:unit / test:integration / test:process 分层
pnpm ci:local     # git diff --check + test + typecheck + build
lark-channel-bridge run    # 前台运行(首跑触发 QR 向导)
lark-channel-bridge start  # 安装并启动 OS 守护进程(launchd/systemd/schtasks)
```

CI(`.github/workflows/ci.yml`):macOS + Ubuntu、Node 20,install/test/typecheck/build。

## 4. 本地状态布局(已确认,`src/config/app-paths.ts → resolveAppPaths()`)

```
~/.lark-channel/                    # 或 $LARK_CHANNEL_HOME
├─ config.json                      # RootConfig v2:全部 profile + activeProfile
├─ active-profile                   # 当前默认 profile
├─ registry/processes.json, locks/  # 进程注册表 + profile/app 运行时锁
└─ profiles/<name>/                 # ★ Profile = 状态隔离边界
   ├─ sessions.json                 # SessionStore(scope→会话)
   ├─ sessions.json.catalog.json    # SessionCatalog(身份四元组→会话)
   ├─ workspaces.json               # WorkspaceStore(scope→cwd + 命名表)
   ├─ ledger.json                   # 用量/反馈账本
   ├─ secrets.enc + .keystore.salt  # AES-256-GCM 密钥库(0600)
   ├─ lark-cli/                     # profile 私有 lark-cli 身份
   ├─ media/ logs/                  # 附件缓存(24h GC)/ 按日 JSONL 日志(默认 30 天)
```

## 5. 核心心智模型(四句话)

1. **scope 是一切的键**:私聊/普通群=chatId,话题群=`chatId:threadId`;会话、工作目录、任务槽、消息队列全部按 scope 隔离。
2. **每 scope 同时最多一个 run**:PendingQueue 600ms 防抖合批 + ActiveRuns 单飞 + ProcessPool 全局并发上限,三层叠加。
3. **Claude 默认走 PTY 长驻会话**(每会话一个 claude TUI,事件从磁盘 JSONL 轮询读取);Codex 每次一进程(stdin 喂 prompt,stdout 行 JSON)。
4. **会话身份 = scope + agent + cwd + 策略指纹**:任何一项变化(尤其权限/附件策略)即不再自动续接旧会话——安全语义。

## 6. 文档导航(推荐阅读顺序)

| 顺序 | 文档 | 解决的问题 |
|---|---|---|
| 1 | 本文档 | 项目是什么、怎么跑、状态在哪 |
| 2 | [architecture.md](./architecture.md) | 分层、进程模型、依赖方向 |
| 3 | [module-map.md](./module-map.md) | 每个目录/模块的职责与关键符号 |
| 4 | [feature-catalog.md](./feature-catalog.md) | 功能 → 代码位置索引(F01-F34) |
| 5 | [message-flow.md](./message-flow.md) → flows/ 五篇 | 一条消息的完整旅程(接入→执行→回传→会话→队列→进程) |
| 6 | [command-reference.md](./command-reference.md) | 主机 CLI + 聊天命令全表 |
| 7 | [agent-integration.md](./agent-integration.md) | Claude/Codex 接入细节 |
| 8 | [session-and-workspace.md](./session-and-workspace.md) | 会话/工作目录/Profile 关系 |
| 9 | [security-and-configuration.md](./security-and-configuration.md) | ACL、密钥、权限、脱敏 |
| 10 | [testing.md](./testing.md) | 测试体系与纪律 |
| 11 | [analysis-gaps.md](./analysis-gaps.md) | **未解决问题与待验证清单(改代码前必读)** |

专项:[web-ui.md](./web-ui.md)(为什么没有 Web 界面)。
