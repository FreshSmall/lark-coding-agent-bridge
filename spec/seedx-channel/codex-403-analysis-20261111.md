# Codex 已选择 seedx 通道仍返回 403 的排查

日期：2026-11-11，时间均为北京时间。

## 结论

本次失败已经经过 seedx 启动，但 seedx 内置 Codex 0.162.1 解析多层 `-c` 参数时，bridge 在 `exec` 后传入的配置参数使 seedx 在 `exec` 前注入的网关配置丢失。Codex 因此回退到用户配置里的 `custom` provider，访问旧的 `sub2api2.baijia.com`，被已停用的个人 API key 策略拒绝。

这是 bridge 与 seedx 内置 Codex 版本的参数组合兼容问题。单独重新登录、重新保存通道、重连或者新建会话，都不能消除这个参数冲突。

诊断后的修复与验证见文末追加记录；历史排查过程中的边界说明仅描述诊断阶段。

## 运行证据

用户提供的 trace：`77d5fc21-9d7a-4bc8-9cc4-bde3a33ae44f.0.1`。

| 时间 | 证据 | 含义 |
| --- | --- | --- |
| 14:03:29.254 | `~/.lark-channel/profiles/codex/logs/bridge-20261111.jsonl:433`：`config-saved`，`agentLauncher=seedx` | 通道配置确实保存为 seedx |
| 14:15:46.440 | 同文件第 473 行：启动 PID 77072，`hasThread=true` | 此次 bridge 调用启动 |
| 14:15:46.843 | `~/.seedx-workspace/foreground.log:682`：Codex 本地代理已起，端口 59627 | seedx 实际参与了此次启动 |
| 14:15:46.845 | 同文件第 683 行：Codex 本体选定为 `source=bundled`，`pinnedVersion=0.162.1` | 实际使用 seedx 内置版本，不能用 shell 中 `codex --version` 代替 |
| 14:15:59.396 | bridge 日志第 485 行出现用户提供的完整 trace，错误地址指向旧服务 | 模型请求绕过了 seedx 本地代理 |

当前配置的关联项：

- `~/.lark-channel/config.json`：`profiles.codex.agentLauncher.kind=seedx`，`inheritCodexHome=true`，`ignoreUserConfig=false`。
- `~/.codex/config.toml:9`：`model_provider="custom"`。
- `~/.codex/config.toml:19`：该 provider 的 `base_url` 指向旧服务。
- 此次恢复会话 `01a17ceb-3940-7d73-b072-dd962061fe1b` 的 rollout 元数据也记录了 `model_provider=custom`。隔离实验表明：即使完全新建会话，同样会触发本次参数问题，旧会话不是必要条件。

## 参数冲突

相关源码：

- `src/agent/launcher.ts` 的 `applyLauncher` 将运行命令包装为 `seedx codex --permission-mode limited -- <bridge 参数>`。
- `src/agent/codex/argv.ts` 的 `buildCodexArgs` 将 `approval_policy`、`shell_environment_policy.inherit` 两个 `-c` 参数放在 `exec` 后面。
- 已安装 seedx 1.7.5 的 `dist/cli.js` 中，`codexProxyInjection` 生成 provider 配置，`spawnPlainAgent` 把这组配置放在 bridge 透传参数之前。

组合后的关键结构为：

```text
codex
  -c model_provider="seed-gateway"
  -c model_providers.seed-gateway.base_url="http://127.0.0.1:<代理端口>"
  -c <其余 seedx provider 配置>
  exec
  ...
  -c approval_policy="never"
  -c shell_environment_policy.inherit="all"
  ...
```

Codex 0.162.1 在这个调用结构下仅保留子命令层的 `-c` 配置集合，丢弃根命令层的集合。它没有保留 seedx 的 provider 覆盖，因此重新采用用户配置里的 `custom`。seedx 的代理虽然已经启动，却没有收到本轮模型请求。

## 隔离验证

使用运行日志指向的同一份内置 Codex 二进制，执行版本检查，输出 `codex-cli 0.162.1`。

实验使用临时 `CODEX_HOME`、临时工作目录和本机 HTTP 服务。临时配置中的 `custom` 与 `seed-gateway` 指向同一个本机服务的不同路由，按收到的请求判定实际采用哪个 provider。恢复场景使用临时生成的 `custom` 会话元数据，没有操作真实会话。

本机服务统一返回用于终止诊断的 HTTP 400；因此子进程退出码 1 是预期行为。实验验证的是 provider 路由选择，未测试真实模型推理。

| Codex | 场景 | 参数排列 | 实际请求 provider |
| --- | --- | --- | --- |
| 0.162.1（seedx 内置） | 新会话 | 当前 bridge 排列：seedx 的 `-c` 在 `exec` 前，bridge 的 `-c` 在其后 | `custom`，复现配置丢失 |
| 0.162.1（seedx 内置） | 恢复会话 | 当前 bridge 排列 | `custom`，复现配置丢失 |
| 0.162.1（seedx 内置） | 新会话 | 仅将 bridge 的两个 `-c` 也移到 `exec` 前 | `seed-gateway` |
| 0.162.1（seedx 内置） | 恢复会话 | 同上，所有配置覆盖集中在根命令层 | `seed-gateway` |

补充版本对照：本机 PATH 中的 Codex 是 0.166.0，在相同新会话实验中能够保留 seedx provider；但恢复旧 provider 会话时会返回 `modelProviderMismatch`。因此不能仅凭系统 Codex 版本更高，就断言 seedx 已使用它，或者直接升级即可无损恢复旧会话。

## 建议修复与验收

优先在 bridge 的 `buildCodexArgs` 内统一参数层级，将两个配置覆盖参数放在 `exec` 前，与 seedx 注入的参数处于同一层，保留原有权限配置值。

建议实现时补充验证：

1. 新会话与 `exec resume` 两条命令的参数构造。
2. 同一份内置 Codex 二进制上的本机路由回归，避免只断言参数数组正确却漏掉真实 CLI 解析行为。
3. 实际 seedx 网关下的最小新会话和恢复会话验证，再验证飞书 bridge 收发链路。

变更后需要构建并重启或重建 bridge 运行实例。执行结果见文末追加记录。

## 边界

- 未读取或输出 API key、网关 token 的值。
- 未发送飞书消息、重启服务、修改用户配置或源码。
- 官方 Codex 配置文档抓取受到网络错误阻断；本结论以本机运行日志、已安装 CLI 实现和同版本隔离实验为依据。
- seedx-toolbox 按技能流程生成了项目能力缓存及升级检查缓存，没有安装或升级能力。

## 修复与验证追加记录

用户确认修复后，已修改 `src/agent/codex/argv.ts`：将两个 `-c` 覆盖参数集中到 `exec` 前，其他参数和权限配置值保持原样。同步更新已有参数契约测试与启动器接线测试，并新增新建、恢复会话两条参数层级回归。

先执行新增回归测试，确认两个场景都在旧实现下失败，再修改源码。修改后的定向测试共 26 条通过，覆盖参数构造、seedx 启动器接线与 CodexAdapter 子进程契约。构建成功。

使用修改后 `buildCodexArgs` 实际生成的参数，对 seedx 内置 Codex 0.162.1 完成验证：

| 验证 | 新建会话 | 恢复会话 |
| --- | --- | --- |
| 本机 HTTP 路由验证 | 请求 `seed-gateway`，通过 | 请求 `seed-gateway`，通过 |
| 真实 seedx 网关最小推理 | 退出码 0，返回 `OK` | 退出码 0，返回 `OK` |

真实网关实验使用临时 `CODEX_HOME` 与工作目录，保留指向旧服务的 `custom` 配置作为回退探针。恢复实验使用临时生成的 `custom` 会话元数据，不操作原有用户会话。未发送飞书消息。

检查中发现的既有问题：

- 默认全量 Vitest 收集了 `.agents/hooks/seedx-tests/` 与 `.claude/hooks/seedx-tests/` 下的 Node 测试文件，四种文件各两份：`bind-stage-session.test.mjs`、`finalize-story-touch.test.mjs`、`record-story-touch.test.mjs`、`validate-story.test.mjs`。8 个文件报 `No test suite found`；项目 799 条测试均通过。
- `tsc --noEmit` 在未修改的 `tests/unit/card/config-form-message-reply.test.ts:21` 报 TS2352，原因是既有测试 fixture 缺少 `agentLauncher` 字段。本次未扩大修复范围。
- 本机 pnpm 会尝试下载项目声明的包管理器版本；已停止这次下载，使用已安装的 Vitest、TypeScript、tsup 执行检查，没有安装依赖。

最终检查与服务生效结果：

- 使用 `vitest run --exclude '.agents/**' --exclude '.claude/**'` 执行项目测试：121 个文件、799 条测试全部通过。
- 构建及 `git diff --check` 通过。
- 14:31:56 已重启 `codex` profile 并重新连接飞书，机器人名称为“尹超的数字助手codex”，新 PID 93997；状态检查确认为后台运行。
- 未主动发送飞书测试消息，因此未宣称完整飞书消息往返已验收。模型调用链路已完成真实 seedx 网关的新建与恢复验证。
- 未提交代码。原有 `.gitignore`、`docs/global-memory-bank/` 等工作区改动未纳入本次修复。
