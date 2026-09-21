# 话题上下文注入（thread_context）

> 状态：已实施并提交（`329591b`，分支 `feat/topic-root-context`）· 待真机验证
> 取代：[`spec/topic-root-context/implementation.md`](../topic-root-context/implementation.md)（方案 A，只注入话题宿主一条）

## 1. 解决什么问题

飞书群里，告警机器人发一张卡片，有人在那张卡片下开话题 @bot 提问。bot 看不到告警内容，只看到「分析告警」四个字。

更一般地：bridge 的职责是把飞书里的信息**完整、准确**地送到本地 claude code。话题是飞书组织上下文的基本单位，而 bridge 此前完全无视它。

## 2. 最终设计

### 2.1 prompt 结构

```
<bridge_context>        谁在哪个群 / 哪个话题说话
<bridge_instructions>   固定行为约束
<thread_context>        ← 本次新增：整个话题
<quoted_messages>       用户主动引用回复指向的消息
<user_input>            用户这句话
```

`thread_context` 的内容：

```json
{
  "threadId": "omt_19d526ba620f1c82",
  "total": 7,
  "omitted": 2,
  "messages": [
    {"messageId":"om_a","position":-1,"isHost":true,"senderId":"cli_alertbot",
     "senderType":"bot","createdAt":"2026-09-21T04:11:31.570Z",
     "contentType":"interactive","content":"应用 X 普通预警\n..."},
    {"messageId":"om_b","position":0,"isHost":false,"senderId":"ou_xxx",
     "senderType":"user","createdAt":"...","contentType":"text",
     "content":"这个怎么看","truncatedChars":0}
  ]
}
```

### 2.2 为什么和 `quoted_messages` 分开

两者对 agent 的含义不同：

- `quoted_messages` = 用户**指向**的东西 → 回答围绕它展开
- `thread_context` = 用户**所处**的环境 → 当背景事实读

塞进同一个段需要一个 `origin` 字段来消歧，等于让 agent 先读段名（得到错误印象）再读字段（纠正回来）。分开就不用纠正。system prompt 分别说明两者该怎么用。

### 2.3 数据流

```
用户在话题里 @bot
  │
  ├─ 有 threadId ?                    ──否──> 不注入
  ├─ preferences.threadContext ?      ──否──> 不注入
  ├─ 该 scope 首轮 ?                   ──否──> 不注入（靠 agent session 记忆）
  │
  └─ fetchThreadContext(channel, threadId)
       │
       ├─ im.v1.message.list(container_id_type='thread')
       │    失败 ──> 返回 { error }，注入带 error 的段，不置位（下轮重试）
       │
       ├─ 过滤：bridge bot 自己的消息、已在当前批次里的消息
       ├─ 渲染：interactive → extractCardText / text → .text / post → 扁平化
       ├─ 截断：单条 4000，总量 20000（host 豁免）
       └─ 注入 <thread_context>，置位 markThreadContextInjected(scope)
```

## 3. 关键设计决策

### 3.1 一次调用拿到全部，包括宿主

`im.v1.message.list` 以 `container_id_type=thread` 调用时，返回值**包含话题宿主消息**，标记为 `thread_message_position: -1`。这正是告警卡片本身。

因此不需要再用 `root_id` 单独拉宿主 —— 前一版方案的整条路径被这一个接口取代，两条路合并成一条。顺带解决了顺序问题：`position` 升序就是时间序。

### 3.2 保真优先于整洁

bridge 是转发器，衡量标准是漏没漏、错没错。三处体现：

**缺口显形。** `total` 是话题实际消息数，`omitted` 是因预算丢弃的条数，`truncatedChars` 是单条被截掉的字符数。agent 据此能分辨「这就是全部」和「还有我没拿到的」。

**失败也注入。** 拉取失败时段照样出现，带 `error` 字段：

```json
{"threadId":"omt_xxx","total":0,"omitted":0,"messages":[],"error":"permission denied"}
```

不注入的话，agent 分不清「话题是空的」和「话题读不到」，会基于残缺输入给出**语气笃定的错误结论**。这比漏信息本身危险 —— 用户在群里看到的是一个看起来很确定的错误分析。

**宿主豁免预算。** 它是告警本体，再挤也不能丢。其余从新到旧填充：长话题里最近的几轮说明当下在问什么，中间部分通常是在复述宿主。

### 3.3 卡片提纯

`extractCardText` 把 CardKit JSON 还原成人看到的文本。真实告警卡：**4113 → 1086 字符**。

规则：

- 递归 `body` / `elements` / `columns` / `rows` / `actions`，取文本类节点（`markdown` / `plain_text` / `lark_md` / `div` / `text`）的 `content`
- 按钮渲染成 `[标签](url)`
- **按钮 URL 超过 300 字符只保留标签**。告警平台把卡片正文 percent-encode 进「AI快速排查」这类链接（实测 1536 字符），那是 agent 手上已有内容的更难读的副本，而作为链接它也不指向新信息。短 URL 相反 —— trace 链接里的 traceId 是可操作的线索，必须留。
- 跳过 `config.summary`（重复 header）、`element_id` / `text_align` / `background_style` 等布局字段
- 不是卡片时返回 `undefined`，调用方降级

### 3.4 排除 bot 自己

过滤 `sender.id ∈ {bridge bot 的 open_id, app_id}`。resume 的 session 本来就记得自己说过什么，重复喂回去是纯噪音。

注意 `sender.id` 对 app 发送者携带的是 **app_id**（`cli_xxx`），对人是 open_id（`ou_xxx`），所以两个都要比对。其他 bot（比如告警机器人）保留 —— 它们的消息正是要的内容。

### 3.5 仍是首轮注入

沿用前一版的门控。`sessions.hasInjectedThreadContext(scope)` 是非持久化的内存标记，挂在 `SessionStore` 上，因为所有 `sessions.clear(scope)` 的调用点恰好都是「应该重新注入」的时机：`/new`、`/cd`、`/ws use`、cwd 漂移清理、session 轮转。

> **陷阱（沿用）**：`clear()` 有 `if (!prev) return` 早退。标记删除必须在方法**第一行** —— 否则「注入了但 run 失败没写 session entry，然后 `/new`」会漏清。

**只在真正拿到内容后置位**，失败不置位，下一轮自动重试。

## 4. 权限依赖

`im:message.group_msg`（读取群组消息）。**这是硬依赖**，没有它 `messages.list` 返回 `230027`。

权限边界实测（bridge bot 身份）：

| 调用 | 需要 `im:message.group_msg` |
|---|---|
| `im.v1.message.get` 单条 | 否 |
| `im.v1.messages` list by **thread** | **是** |
| `im.v1.messages` list by **chat** | **是** |
| `im.v1.chats` get | 否 |

也就是说：bot 能读任意**已知 id** 的单条消息，但**枚举**需要额外权限。前一版方案之所以能工作，是因为 `root_id` 是飞书主动塞在事件里送上门的。

## 5. 配置

| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `preferences.threadContext` | `true` | bool | 总开关，`false` 完全关闭注入 |
| `preferences.threadContextMaxChars` | `20000` | [1000, 200000] | 总字符预算，host 不计入约束 |
| `preferences.threadContextMaxMessageChars` | `4000` | [200, 50000] | 单条上限，防一条万字日志吃光预算 |

两个上限都做了 clamp，配置写错不会让 prompt 爆掉或退化成空。

## 6. 代码位置

| 文件 | 职责 |
|---|---|
| `src/bot/thread-history.ts` | 拉取、过滤、渲染、截断 |
| `src/bot/interactive-card.ts` | `extractCardText` 卡片提纯 |
| `src/bot/channel.ts` | 注入点（`runAgentBatch`）、`intake.enter` 诊断日志 |
| `src/agent/prompt.ts` | `thread_context` 段与类型 |
| `src/agent/bridge-system-prompt.ts` | 告诉 agent 怎么读这个段 |
| `src/session/store.ts` | 首轮标记生命周期 |
| `src/config/schema.ts` | 三个配置项 |

## 7. 测试

| 范围 | 结果 |
|---|---|
| 全量 `pnpm test` | 117 文件 / 768 用例 通过 |
| `pnpm build` | 通过 |
| `pnpm typecheck` | **失败 —— 预存问题，与本次无关** |

`pnpm typecheck` 在 `tests/unit/card/config-form-message-reply.test.ts:21` 报 `larkCliIdentity` 类型不兼容（TS2352）。已 stash 全部改动在基线复现同一错误。**这意味着 `pnpm ci:local` 在本仓库当前本来就是红的**，与本方案无关。

新增 / 重写的测试：

- `tests/unit/bot/card-text.test.ts`（新）11 例 —— 提纯、嵌套、按钮、超长 URL、降级
- `tests/unit/bot/thread-history.test.ts`（新）11 例 —— 排序、host 标记、过滤、截断、预算、失败
- `tests/unit/agent/prompt-builder.test.ts` +4 例 —— 段存在性、错误透传、段顺序
- `tests/unit/agent/bridge-system-prompt.test.ts` 重写 4 例
- `tests/integration/bot/thread-context.test.ts`（由 `topic-quote.test.ts` 改名）10 例全部重写

> 写测试时踩到一个假阳性：`expect(prompt.indexOf('<thread_context>')).toBeLessThan(prompt.indexOf('<quoted_messages>'))` 在段不存在时 `indexOf` 返回 `-1`，`-1 < 正数` 恒成立，测试在功能缺失时照样通过。断言顺序前必须先断言两者都存在。

## 8. 排查指南（踩过的坑）

**lark-cli 的封装会丢字段。** `lark-cli im +messages-mget` 和 `+threads-messages-list` 把 `root_id` / `parent_id` 显示成 `null`，一度让人以为飞书没下发这两个字段。原生 API 有。排查 thread 字段时直接用：

```bash
lark-cli api GET /open-apis/im/v1/messages \
  --params '{"container_id_type":"thread","container_id":"omt_xxx"}' --as user
```

**lark-cli 的 bot 不是 bridge 的 bot。** lark-cli 绑定的是另一个 app（`cli_aad0f9a231795be0`），它的 bot 不在告警群里，用 `--as bot` 会报 `230002 Bot/User can NOT be out of the chat`。用 `--as user`，或者直接用 bridge 自己的凭据。

**user 身份和 bot 身份看到的不一样。** 同一个 thread listing，user 身份返回 2 条（不含宿主），bridge bot 身份返回 5 条（含宿主 position -1）。可见性差异，不是 API 行为差异。

**`getChatMode` 对普通群返回 `group`。** 飞书的「话题群」（整个群以话题为单位组织）和「在普通群某条消息下开话题」是两回事。告警场景清一色是后者，chat mode 是 `group`。**不要用 `mode === 'topic'` 做门控** —— 前一版就死在这里，详见旧文档 §12。

**诊断日志。** `intake.enter` 带 `threadId` / `rootId` / `replyTo`，`thread.context` 带 `total` / `included` / `omitted` / `chars` / `error`：

```bash
grep '"event": "enter"'   ~/.lark-channel/profiles/claude/logs/bridge-$(date +%Y%m%d).jsonl | tail -1
grep '"phase": "thread"'  ~/.lark-channel/profiles/claude/logs/bridge-$(date +%Y%m%d).jsonl | tail -3
```

## 9. 已知边界

**只覆盖一页。** `page_size=50`，未做翻页。超过 50 条的话题只取第一页，`total` 也只反映这一页 —— 这种情况下 `total` 是不准的，属于已知缺陷。真实告警话题很少超过 50 条，暂不处理。

**非文本消息降级。** 图片、文件、音视频渲染成 `[image]` / `[file]` 这类占位。agent 知道有这条消息、什么类型，但拿不到内容。**话题里的图片不会被下载** —— media 链路只处理当前触发批次的 `resources`。

**session 压缩后仍会丢。** 首轮注入的内容被 claude 自身的上下文压缩掉之后，agent 无法重新获取，也不知道自己丢了。`sessionRotateMaxBytes` 触发的轮转会清标记因而能恢复，但 compact 不经过 bridge，感知不到。要根治得让 agent 能主动重取（见 §10）。

**每轮成本。** 首轮 1 次 API 调用。选「仅首轮」而非「每轮」是用户决策，代价就是上一条。

## 10. 未做的后续方向

**agent 主动取数。** 给 agent 一个走 bridge 自己 bot token 和 policy 层的取数入口（如 `lark-channel-bridge fetch-thread <id>`），而不是让它用 lark-cli —— 后者会用个人 OAuth token，**绕过 bridge 的整个权限层**（`policy/access.ts` 的 `allowedChats` 白名单形同虚设）。这是唯一能根治「compact 后不可恢复」的办法，也是 §9 前两条边界的解法。

**翻页。** 配合上限做完整分页，让 `total` 准确。

**话题内图片下载。** 把 thread 消息里的 `resources` 接进 media 链路。

## 11. 真机验证清单

1. `lark-channel-bridge restart --profile claude`（`dist` 已重建，进程需重启）
2. 告警话题内 @bot 提问
3. 日志出现 `thread context { total: N, included: M, omitted: 0 }`
4. 回复内容体现告警细节
5. 同话题再问 —— **不应**再出现 `thread context` 日志
6. `/new` 后再问 —— 应重新出现

重点看第 3 步的 `included` 是否等于「话题实际条数减去 bot 自己的回复」。不等说明过滤或预算有问题。

本地无法验证的：话题里含图片 / 文件 / post 类型消息时 `renderContent` 的降级表现。单测覆盖了行为，真实数据形态只能真机看。
