# 交叉验证报告:分析文档 vs 真实源码

> 生成时间:2026-10-24。验证对象:`docs/code-knowledge/` 全部 9 份既有分析文档(module-map、feature-catalog、session-and-workspace、agent-integration、security-and-configuration、flows/*4)。
> 验证方法:逐条提取文档中的 `文件:行号`/符号声称(约 100 条唯一引用),用 `sed -n`/`grep` 对照源码;对 6 个"待验证"遗留项做定向补读;对照 README 与测试目录核查遗漏与覆盖。
> 本轮同时修正了发现的文档错误(见文末修正清单),未改动任何业务源码。

## 一、错误结论(已在本轮修正)

### G1 `SessionCatalog.gc` 被写成生命周期环节,实际无生产调用点【优先级:高】

- **涉及文档**:session-and-workspace.md(§2/§3)、flows/session-lifecycle.md(T7)
- **原结论**:GC(archived 90 天 / 每 scope 20 条 / 每 profile 1000 条)是 catalog 生命周期的一部分;T7 曾写"启动/定期执行【推断】"。
- **验证**:`grep -rn '\.gc(' src/` 仅命中定义(`src/session/catalog.ts:161`)与单元测试(`tests/unit/session/catalog.test.ts`);`src/cli/commands/start.ts` 只调用 `sessionCatalog.load()`(`:150`)。对照:日志 GC(`gcOldLogs`)与媒体 GC(`gcMediaCache`)在 `start.ts:156-157` 有真实调用。
- **事实**:archived 条目**无限累积**,catalog 文件会缓慢增长;gc 是"有实现、有测试、未接线"的死代码(是否有意为之未知)。
- **处置**:已修正两份文档并加入醒目警告。

### G2 命名工作区隔离机制:推断误写风险,实际为四段键【优先级:中】

- **涉及文档**:session-and-workspace.md §4(原文标注【推断】)
- **验证**:`scopedWorkspaceName`(`src/commands/index.ts:530-534`)= `profile ␟ ownerOpenId ␟ scope ␟ name`(分隔符 `\x1f`);读取经 `workspaceAliasKeys` 回退裸 name 兼容 legacy(`:536-569`)。
- **处置**:已改为确认事实(原文至少标了"推断",未构成错误,但本轮升级为已确认)。

### G3 命令数量:文档称 20 个,实际 19 个键【优先级:低】

- **涉及文档**:module-map.md §5、flows/message-to-agent.md 阶段 2、feature-catalog F09
- **验证**:`sed -n '206,231p' src/commands/index.ts | grep -c "':" = 19(`/reset` 与 `/new` 指向同一 handler)。
- **处置**:已修正。

### G4 行号引用偏差(共 11 处,符号与语义均正确,仅行号漂移)【优先级:低】

| 文档原引用 | 实际位置 | 涉及符号 |
|---|---|---|
| channel.ts:69 | **channel.ts:79** | `DEBOUNCE_MS` |
| pty-adapter.ts:88(及 :88-165) | **:84** | `ClaudePtyAdapter.run` |
| codex/adapter.ts:88(及 :88-194) | **:91** | `CodexAdapter.run` |
| codex/adapter.ts:151 | **:154** | `child.stdin.end(prompt)` |
| codex/adapter.ts:151-170(stop 范围) | **:161-180** | `async stop()` |
| pty-adapter.ts:157-163 | **:150-156** | PTY 版 `waitForExit` |
| commands/index.ts:179-205 | **:189-209** | `releasePreviousClaudeSession` |
| commands/index.ts:256 | **:251** | `tryHandleCommand` |
| commands/index.ts applyResume :645-728 | **:659-745** | `applyResume` |
| app-paths.ts:27 | **:35** | `DEFAULT_PROFILE` |
| keystore.ts:95-104 / workspace.ts:31-53 | **:86-94 / :26-53** | `deriveKey` / `resolveWorkingDirectory` |

- **处置**:已全部批量修正。其余约 90 条引用(含 bot/card/config/policy/runtime/cli 各层与 SDK 类型定义)经核对**准确**。

## 二、缺失的代码证据 / 未追踪完整的调用链(保留为待验证)

| 编号 | 问题 | 涉及文档/代码 | 已有结论 | 需要补充的证据 | 验证方式 | 优先级 |
|---|---|---|---|---|---|---|
| G5 | headless stream-json 事件映射细节 | streaming-response.md、agent-integration.md;`src/agent/claude/stream-json.ts:129` `translateEvent` | 知道入口与 args,不知道每个 SDK 事件→AgentEvent 的映射 | 逐行读 53-129 行 | 静态阅读 + `tests/unit/agent/claude-stream-json.test.ts` 对照 | 中 |
| G6 | headless 模式 sessionId 是否回写 | 同上 | 推断不需回写(bridge 指定 --resume) | 流中是否产 system 事件 | 读 stream-json.ts + process 测试 | 中 |
| G7 | codex `ProtocolDriftState` 触发与消费 | agent-integration.md;`src/agent/codex/jsonl.ts:6-9` | 只知道存在 | drift 检测逻辑与下游行为 | 读 jsonl.ts 全文 | 中 |
| G8 | SDK 内部三处:black-box | message-to-agent.md §7;node_modules/@larksuite/channel/dist/index.mjs | dedup 存在(类型注释)、QR 注册、30k 滚卡 messageId 衔接 | 默认参数、注册 API、滚卡后 controller.messageId 是否切换 | 读 SDK .mjs(本轮未做,避免深挖外部依赖) | 低 |
| G9 | keystore 写接口与 /account 交互 | security-and-configuration.md §11-1;`src/config/keystore.ts:120+` | 加密读路径已确认 | setSecret/remove 与 `handleAccount` 的调用时序 | 读 keystore.ts 后半 + account 流程 | 中 |
| G10 | `withConfigFileLock` 锁粒度 | security §11-2;`src/config/profile-store.ts` | 写串行已确认 | 写期间读是否阻塞 | 读锁实现 | 低 |
| G11 | 卡片回调 operator 比对规则 | security §11-4;`src/card/dispatcher.ts` `verifyBridgeToken` | 验签主干已读 | operator 与签发人是否强绑定 | 读 dispatcher 剩余部分 + callback-auth verify | 中 |
| G12 | `pauseNewRuns` pauseDepth 配对 | queue-and-cancellation.md §7-2 | 机制已读 | 真实重启序列是否总是 release | 梳理 start.ts/channel.ts 调用对 | 低 |
| G13 | thread_context marker 全部清除路径 | feature-catalog F16;`spec/thread-context/implementation.md` | 抽样验证(/new、clear) | /cd、/ws use、rotation 是否都清(它们都走 sessions.clear → 前缀清除,推断成立但未逐路径核对) | grep `sessions.clear` 全部调用点交叉验证 | 中 |

## 三、未分析的业务功能(本轮发现的新遗漏)

| 编号 | 问题 | 说明 | 优先级 |
|---|---|---|---|
| G14 | **`botAdded` SDK 事件未被 bridge 注册** | SDK EventMap 提供 `botAdded`(bot 被拉进群事件,`.d.mts:272-298` 区段),`src/bot/channel.ts:298-403` 的 `channel.on({...})` 未挂该回调。后果:bot 新进群时 `controls.knownChats` 不实时更新,`/invite all group`、`/ws` 列表等依赖 knownChats 的功能最长滞后 30min(定时刷新,`channel.ts:477-495`)。是否设计取舍未知。**文档此前完全未提及该事件的存在与缺席**。 | 中 |
| G15 | `/new chat [name]` 子命令 | 建群 + 继承 cwd(`handleNewChat`,`commands/index.ts:384-421`),原 F09/F24/session-lifecycle 均未覆盖;本轮已补入文档。 | 已补 |
| G16 | `/doc` 为占位命令 | 仅回一句提示(`:524-527`),无逻辑;原缺口表已列,本轮解决。 | 已解决 |
| G17 | 6 个小文件未读 | `session/jcs.ts`、`session/preview.ts`、`bot/scope.ts`、`bot/comment-resource.ts`、`cli/agent-detection.ts`、`cli/prompt.ts`(各 <120 行),职责仅按调用点推断。 | 低 |
| G18 | `profile-runtime.ts`(734 行)内部 | profile 发现/bootstrap/迁移冲突交互的完整分支未梳理。 | 中 |

## 四、需要运行时验证的行为(静态无法确定)

| 编号 | 行为 | 为什么静态确定不了 | 优先级 |
|---|---|---|---|
| G19 | bridge 进程异常死亡后 PTY 子进程归宿 | node-pty master 退出后 slave 的信号路径依 OS/版本而定;代码未显式处理 | 中 |
| G20 | PTY 池无数量上限的实际内存表现 | 活跃会话数=活跃聊天数,空闲 PTY 仅 30min TTL 回收;长尾场景(大量低频聊天)的内存占用需实测 | 低 |
| G21 | markdown 模式 30k 滚卡后 ledger 归因 | 滚卡由 SDK 处理,`replyMessageId` 取首卡还是末卡影响 /report 与 👍/👎 归因 | 低 |
| G22 | SDK dedup/stale 默认参数下的重投递行为 | 默认值在 SDK 实现内 | 低 |
| G23 | ChatModeCache.resolve 失败时 bridge 侧回退 | SDK 注释称回退 'group';bridge 侧缓存失败路径未逐行 | 低 |

## 五、缺少测试覆盖的场景

| 编号 | 场景 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| G24 | `/new chat` 建群流程 | `grep -rln 'new chat\|handleNewChat\|createBoundChat' tests/` 无命中 | 补集成测试(可用 fake-channel 模拟 createBoundChat) | 中 |
| G25 | catalog GC(测试-实现脱节) | `tests/unit/session/catalog.test.ts` 测了 gc,但生产无调用 | 要么接线(start 时 gc 一次),要么删测试注明原因——上游决策 | 中 |
| G26 | botAdded 未注册(也无测试) | 无处理代码即无测试 | 若决定支持,需补 handler + knownChats 即时刷新测试 | 低 |
| G27 | pauseNewRuns 嵌套/泄漏 | 未见专门测试(单元测试有 run-executor 拒绝路径,但重启序列的 pause/release 配对无断言) | 补 restart 期间的并发提交测试 | 低 |

## 六、README 与实现核对结果

逐条核对 README.md 功能描述:migrate/profile/secrets/服务命令、QR 向导、权限映射表、数据目录表、lark-cli 身份策略、`LARK_CHANNEL_HOME`/`LARK_CHANNEL_LOG_DAYS`(默认 30 天,`src/core/logger.ts:15` 已实现)、telemetry 钩子、`--skip-check-lark-cli` 等均能找到实现。已知偏差:(a) README 命令表缺 `/account` `/doc` `/report`(handlers 存在;`tests/unit/docs/readme-contract.test.ts` 部分覆盖契约);(b) README 称 CI 含 Windows,`.github/workflows/ci.yml` matrix 仅 macOS/Ubuntu;(c) README 提"0.4.0 起 Windows 不支持"而 package.json 版本 0.3.0——三处均属上游文档口径问题,非分析文档错误。

---

## 修正清单

**本轮已修正(8 项)**:

| # | 修正 | 文件 | 原因 |
|---|---|---|---|
| 1 | GC"无生产调用点"警告 + T7 重写 | session-and-workspace.md、flows/session-lifecycle.md | G1:错误结论 |
| 2 | 命名工作区四段键(推断→确认) | session-and-workspace.md §4、feature-catalog F24 | G2 |
| 3 | 20 个命令 → 19 个键(/reset 别名) | module-map.md、message-to-agent.md、feature-catalog F09 | G3 |
| 4 | 11 处行号修正(见 G4 表) | 全部 7 份涉及文档 | G4 |
| 5 | 补 `/new chat` 子命令 | feature-catalog F09、flows/session-lifecycle.md T4 | G15 遗漏 |
| 6 | 补 `/doc` 占位结论、`/doctor` 发起 nowait run(scope=`${scope}:doctor`、群聊私信) | feature-catalog F09/F30 | G16 + 新事实 |
| 7 | 补 `/resume` 按钮路由(`cmd:'resume.use', arg:nonce`) | flows/session-lifecycle.md T5 | 解决原待验证 2 |
| 8 | 补 `/config` 表单 9 项、LARK_CHANNEL_LOG_DAYS 默认值;botAdded/gc/`/new chat` 无测试列入缺口表 | security-and-configuration.md、feature-catalog 缺口表 | G14/G24 等 |

**仍待验证(按优先级)**:G13(marker 清除路径全核对)> G5/G6/G7(headless 与 codex 翻译细节)> G9/G11(密钥写入与回调 operator)> G14(botAdded 设计意图)> G18(profile-runtime 内部)> G19-G23(需运行时)> G24-G27(测试建议)。
