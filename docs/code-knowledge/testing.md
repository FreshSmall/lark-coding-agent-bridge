# 测试体系

> 状态:正式知识库文档(已验证)。命令与纪律以 `package.json`/`vitest.config.ts`/`CLAUDE.md` 为准。

## 1. 命令与分层(已确认)

```bash
pnpm test               # vitest run 全量(~117 个 test 文件)
pnpm test:unit          # tests/unit(模块级,约 70 文件)
pnpm test:integration   # tests/integration(bot 流程/命令/评论/配置/执行器/策略/运行时/会话)
pnpm test:process       # tests/process(真实子进程适配器测试)
pnpm typecheck          # tsc --noEmit
pnpm ci:local           # git diff --check + test + typecheck + build
```

**测试纪律(来自 `CLAUDE.md`,对所有 coding agent 有约束力)**:
- 永远不用 vitest watch 模式,只用 `vitest run`(或上述 pnpm 脚本);
- 跑最小范围:只改单元代码就 `pnpm test:unit`,全量留给端到端验证;
- 多 subagent 并行时测试步骤必须在主 agent 串行,不得各跑各的;
- 不得用 `--pool/--poolOptions` 命令行参数绕过 `vitest.config.ts` 的 maxForks=4(全依赖图 ~4GB/fork,默认并行会 OOM)。

## 2. 目录结构(已确认)

```
tests/
├─ unit/        模块级:agent(claude PTY/jsonl/codex)、bot、card、cli、commands、
│               config、core(logger 脱敏)、daemon、lark-cli、media、observability、
│               platform、policy、runtime、session + static/contracts + docs/readme-contract
├─ integration/ 按域分:bot/(access-gate、im-run-flow、thread-context、claude-security、
│               card-send-failure、markdown-stream-startup-failure…)、commands/(14 文件)、
│               comments/、config/、executor/、media/、observability/、policy/、
│               runtime/、session/、card/、claude/、cli/
├─ process/     真实子进程:claude-headless-adapter、codex-adapter
├─ static/      contracts.test.ts(observability 事件契约)
├─ helpers/     fake-channel.ts(LarkChannel 假实现)、fake-agent.ts、tmp-profile.ts
│               (隔离 ~/.lark-channel)、card-normalize.ts、fake-comment-surface.ts、
│               fake-executable.ts
└─ fixtures/    claude-fake/claude.mjs(假 claude TUI,供 PTY 集成测试)
```

## 3. 关键测试与被测机制的对应(已确认)

| 机制 | 测试 |
|---|---|
| PTY 会话(consent/readiness/中断/按键) | `tests/unit/agent/claude-pty-session.test.ts` + `tests/integration/claude/pty-adapter.test.ts`(用 fixtures 假 TUI) |
| JSONL 翻译(turn_duration/synthetic) | `tests/unit/agent/claude-jsonl-translate.test.ts`、`claude-jsonl-reader.test.ts` |
| 运行编排(拒绝路径/清理/fanout 防泄漏) | `tests/unit/runtime/run-executor.test.ts`、`tests/integration/executor/run-executor.test.ts` |
| ACL 门 | `tests/integration/bot/access-gate.test.ts`、`tests/unit/policy/access.test.ts` |
| 话题上下文注入(当前分支主题) | `tests/integration/bot/thread-context.test.ts`、`tests/unit/bot/thread-history.test.ts` |
| 会话重置/恢复(含 PTY 释放) | `tests/integration/commands/close-session.test.ts`、`tests/integration/session/resume.test.ts` |
| 卡片渲染与回调验签 | `tests/unit/card/*`(快照/状态机/回调)、`tests/integration/card/callback-dispatch.test.ts` |
| 日志脱敏 | `tests/unit/core/logger-redaction.test.ts`、`tests/integration/commands/doctor-redaction.test.ts` |
| README/CLI 契约 | `tests/unit/docs/readme-contract.test.ts`、`tests/unit/cli/index-registration.test.ts` |

## 4. 覆盖缺口(已确认,详见 analysis-gaps.md §五)

| 场景 | 现状 |
|---|---|
| `/new chat` 建群流程(`handleNewChat`/`createBoundChat`) | **无任何测试** |
| catalog GC | 有单测但生产无调用(测试-实现脱节) |
| botAdded 事件 | 未注册也无测试 |
| pauseNewRuns 在重启序列中的配对 | 无专门断言 |

## 5. 运行注意

- 测试进程会写 `~/.lark-channel`——helpers 的 `tmp-profile.ts` 通过环境变量把状态重定向到临时目录,新增测试必须使用它,勿污染真实 profile。
- process 层测试依赖假可执行文件(helpers/fake-executable.ts),不依赖真实 claude/codex 登录态。
- 本知识库分析期间的静态验证未执行任何测试(遵守"不安装依赖、不跑真实任务"约束)。
