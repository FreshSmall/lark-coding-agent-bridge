# 机制:会话与工作目录(Profile × 聊天 × Agent Session × 任务)

> 生成时间:2026-10-24。分支 `feat/topic-root-context`。
> 配套 flow 文档:[flows/session-lifecycle.md](./flows/session-lifecycle.md)(状态流转时序)。
> 本项目无 Web 界面;"工作目录"指 agent 子进程的 cwd,不是任何 UI 概念。

## 0. 解决的问题

同一个 bot 服务于多个飞书聊天(私聊/群/话题群/文档评论线程),每个聊天各自需要:独立的对话记忆(Agent session)、独立的当前项目目录(cwd)、独立的任务槽(active run)。同时一台机器可以跑多个 profile(如 claude bot 和 codex bot 两个 app),状态必须完全隔离。本文解释这五层实体如何互相映射与隔离。

## 1. 关系模型(已确认)

```
机器
└─ rootDir ~/.lark-channel (或 $LARK_CHANNEL_HOME)          ← config.json(全局,含所有 profile)
   ├─ active-profile                                        ← 当前默认 profile 名
   ├─ registry/processes.json + locks/                      ← 进程层(跨 profile 共享)
   └─ profiles/<profile>/                                   ← ★ Profile = 状态隔离边界
      ├─ sessions.json        SessionStore   (scope → SessionEntry)
      ├─ sessions.json.catalog.json  SessionCatalog (身份四元组 → 条目)
      ├─ workspaces.json      WorkspaceStore (scope → cwd;name → cwd)
      ├─ ledger.json / secrets.enc / .keystore.salt / media/ / logs/
      └─ lark-cli/            profile 私有 lark-cli 身份
```

**五层实体与键**:

| 实体 | 键 | 存储 | 生命周期 |
|---|---|---|---|
| Profile | 名字(默认 `claude`,`src/config/app-paths.ts:35`) | `config.json` 内 + `active-profile` | 手动 create/remove;remove 默认归档 |
| 聊天 scope | p2p/普通群=`chatId`;话题群=`chatId:threadId`(`channel.ts:547-550`);评论=派生 scope(`comments.ts`) | ——(无独立存储,是各存储的主键) | 跟随聊天 |
| 工作目录绑定 | scope(及命名别名 name) | `workspaces.json`(`src/workspace/store.ts:6-9`:`chats{scope→{cwd}}` + `named{name→cwd}`) | `/cd`/`/ws use` 改写;`/new chat` 继承 |
| Agent session | claude=`sessionId`(uuid);codex=`threadId` | 双写:`sessions.json` + catalog | 见 §3 |
| 任务(run) | `runId`(uuid)+ scope | 内存(`ActiveRuns.handles`) | 单次运行 |

**一次 run 的取数链**(`run-flow.ts:90-153`):`workspaces.cwdFor(scope) ?? profile.workspaces.default` → 校验 → `evaluateRunPolicy`(指纹)→ `catalog.activeFor(身份四元组)` → (claude)兜底 `sessions.resumeFor(scope, cwd)`(**要求 entry.cwd 与当前 cwd 逐字相等**,否则不续接,`session/store.ts:79-84`)→ 交给适配器。

**身份四元组**:`scopeId ␟ agentId ␟ cwdRealpath ␟ policyFingerprint`(`session/catalog.ts:50-57`,分隔符 `\x1f`)。fingerprint 由 access+resource+attachment 配置摘要构成(`policy/fingerprint.ts:34`)——**权限/附件策略一变,旧会话就不再自动续接**(防止换权限模式后带着旧上下文继续跑)。

## 2. 双会话存储的设计(已确认)

为什么有两套(`SessionStore` + `SessionCatalog`):
- `SessionStore`(`session/store.ts`):**scope 主键**的单值表 `{sessionId?, cwd?, idleTimeoutMinutes?, updatedAt}`。职责:claude 快速续接查询、per-scope 超时覆盖、thread-context 注入 marker(内存)。加载时丢弃"既无 session 对又无 timeout 覆盖"的行(`:55-67`)。
- `SessionCatalog`(`session/catalog.ts`):**身份四元组主键**的多值目录,`status: active|archived`,支持同 scope 多条历史(不同 cwd/指纹各一条)。职责:跨 agent 的统一续接口径(claude sessionId / codex threadId)、`/resume` 候选、轮转归档、GC 参数(默认 archived 90 天、每 scope 20 条、每 profile 1000 条,`:45-47`)——**注意:`gc()` 有实现与单元测试,但当前无任何生产调用点(2026-10-24 交叉验证确认),catalog 条目实际会无限累积**。

写回点:run 期间 `system` 事件 → `recordRunSessionEvent`(`run-flow.ts:242-265`)双写(claude: sessions.set + catalog.upsertActive;codex: 仅 catalog)。

## 3. 会话状态流转(已确认)

```
[无] --首个 run: 适配器分配 sessionId(uuid)--> [活跃]
       └ system 事件写回两存储
[活跃] --下一消息,身份四元组不变--> 续接(catalog.activeFor / sessions.resumeFor 命中)
[活跃] --JSONL 超 sessionRotateMaxBytes--> 轮转:clear+archive,起新会话(run-flow.ts:159-195)
[活跃] --/new /reset /cd /ws use--> 重置:interrupt + archiveAllForScope + closeSession(杀PTY) + sessions.clear
[活跃] --fingerprint 变化--> 不再命中 activeFor(旧条目留存为 active,直到被 archiveAllForScope 清)
[活跃] --/resume use 其他候选--> 切换:不同 id 才关旧 PTY(applyResume:659+)
[archived] --GC 90天/超量--> 删除(⚠ gc() 无生产调用点,见 §2;磁盘 JSONL/rollout 文件本来就不删,交给 claude/codex 自己)
```

细节:
- `/new` 必须 `archiveAllForScope`(按 scope+agent 清**全部**活跃条目)而非按 key 归档——fingerprint 漂移会让一个 scope 积累多条 active,只清一条会"悄悄没生效"(`catalog.ts:135-155` 注释 + `commands/index.ts:366-371`)。
- `SessionStore.clear` 保留 `idleTimeoutMinutes`(per-scope 偏好,`/new` 不清超时;`store.ts:91-100,124-135`)。
- `threadContextInjected` 是 SessionStore 的**内存态** Set(key=`scope␟threadId`),`clear()` 会顺带清该 scope 下所有 thread 的 marker("忘记给过你的上下文"),不持久化(重启后允许重注入一次,`store.ts:30-43,114-122`)。
- `/resume` 列表项发的是 **nonce**(`issueResumeCandidate`,模块级 Map,TTL 10 分钟,`commands/index.ts:180-188`),不是裸 sessionId——用户点选后 `/resume use <nonce>` 经 `consumeResumeCandidate` 换回真实身份,防越权乱填 id。
- 跨 cwd 恢复(`/resume all` 选出的会话):`applyResume` 先 `workspaces.setCwd(scope, targetCwd)` 再绑定(`:688-699`),因为 claude 只能在原 cwd 续接。

## 4. 工作目录:校验与边界(已确认)

`resolveWorkingDirectory`(`src/policy/workspace.ts:26-53`):realpath → 必须存在且是目录 → 高危分类拒绝,10 种拒绝原因(`:5-16`):文件系统根 / home 根 / 用户根(/Users)/ Desktop 与 Downloads / tmp 根 / 9 个 macOS 系统目录 / /Volumes 及其一级子目录。**每个拒绝都带中文 userVisible 文案直接回给用户**。

要点:
- cwd 只是 agent 的启动目录,**不是沙箱**——真实文件访问边界由权限模式(F26)决定,README 与代码注释均明示。
- `realpath` 归一化贯穿全链(spawn、JSONL 路径、catalog 键都存 realpath;`pty-adapter.ts:174-180` 注释解释 /var → /private/var 问题)。
- 命名工作区并非简单全局共享:存储 key 经 `scopedWorkspaceName` 拼为 **`profile ␟ ownerOpenId ␟ scope ␟ name` 四段键**(分隔符 `\x1f`,`commands/index.ts:530-534`),即默认按 profile+owner+scope 三层隔离;读取时回退裸 name 以兼容 legacy 无分隔符条目(`workspaceAliasKeys`/`isLegacyWorkspaceAlias`,`:536-569`)。`/ws list` 只展示当前前缀下的条目 + legacy 项。

## 5. 多用户 / 多群 / 多 Profile 隔离矩阵(已确认)

| 维度 | 隔离机制 | 证据 |
|---|---|---|
| 用户↔用户 | **无会话隔离**:同群/同话题共享一个 scope → 共享会话与任务槽(设计如此:群聊=协作);DM 天然一人一 scope | scope 定义 |
| 群↔群 | chatId 不同 → scope 不同 → 各自 session/cwd/run | scope 定义 |
| 话题↔同群其他话题 | 话题群内 threadId 拆 scope(`chatId:threadId`);普通群 thread 不拆 | `channel.ts:547-550` + `ChatModeCache` |
| Profile↔Profile | 整个 `profiles/<name>/` 目录 + app 锁 + 进程注册表维度 | `app-paths.ts:37-60`、`runtime/locks.ts` |
| Agent 类型 | profile 绑定 agentKind,重连不可变(`assertReconnectAgentKindUnchanged`,`start.ts:417-428`);catalog 以 agentId 分条目 | — |
| 评论↔IM | 评论用派生 scope(comment 线程级),文档级复用 docSessionScopeId | `comments.ts:114-128` |

## 6. 异常分支

| 异常 | 行为 |
|---|---|
| sessions.json/catalog 损坏 | load 失败清空重置(catalog `:81-85`);单条损坏 entry 在 `activeFor` 拒绝并告警(`:92-98`) |
| resume 的 cwd 目录已删 | `resolveWorkingDirectory` 拒绝,userVisible 提示;run-flow 也会在 stale 条目上 clear(`run-flow.ts:149-152`) |
| 续接的 JSONL 文件丢失 | PTY 路径:`existsSync` 判定不 resume,按 `--session-id` 新建(`pty-adapter.ts:180-183`) |
| 持久化失败 | 链式 promise 吞错记日志,不阻塞主流程(`store.ts:168-178`) |
| /resume nonce 过期/伪造 | consume 失败走"未找到"分支(`consumeResumeCandidate`) |

## 7. 测试覆盖

`tests/unit/session/store.test.ts`(clear 保留 timeout、thread marker 清理)、`catalog.test.ts`(身份匹配/archiveAllForScope/GC)、`history.test.ts`、`tests/integration/session/resume.test.ts`(端到端恢复)、`tests/integration/commands/resume-command.test.ts`、`close-session.test.ts`(PTY 释放)、`tests/unit/policy/workspace.test.ts`(10 种拒绝)、`tests/integration/cli/profile-*.test.ts`(profile 隔离)。

## 8. 待验证问题

1. `profile-runtime.ts`(734 行)中 profile 发现/bootstrap 的完整分支(首跑、迁移冲突交互)。
2. codex `threadId` 的来源细节(`thread.started` 事件,`codex/jsonl.ts:29-30`)与 rollout 文件落盘位置(`codex-history.ts` 未逐行)。
3. `lastSummary` 字段(catalog entry)当前是否有写入点(类型存在,未见调用)。
4. ~~scopedWorkspaceName 前缀规则~~(已验证:四段键,见 §4;2026-10-24 交叉验证)。
5. `SessionCatalog.gc` 为何未接线(有意为之还是遗漏——单元测试存在而生产无调用,建议向上游确认)。
