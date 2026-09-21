# 话题首条消息注入实现方案（方案 A）

> **状态：已被取代。当前设计见 [`spec/thread-context/implementation.md`](../thread-context/implementation.md)。**
>
> 本文保留作演进记录：方案 A（只注入话题宿主一条）在真机验证中两次暴露设计缺陷（§12），
> 随后在拿到 `im:message.group_msg` 权限后被「拉取整个话题」的方案完全取代 —— 那个接口
> 返回值已包含宿主消息（position -1），本文 §4.1 的 `implicitThreadRootTarget` 路径因此废弃。
>
> 仍然有效、被新方案继承的部分：§4.2 首轮门控与 `clear()` 的 early-return 陷阱、
> §6.2 session 压缩不可恢复的风险、§12.2 排查 thread 字段时 lark-cli 会丢字段的教训。
>
> 分支：`feat/topic-root-context`（基于 `fix/run-lifecycle-leak`）
> 关联问题：话题群里 @bot 分析告警时，bot 看不到告警内容

## 1. 背景

### 1.1 现象

飞书话题群里，告警机器人发出一条告警卡片开启话题，用户在该话题内 @bridge bot 要求分析。bot 回复时完全不知道告警内容。

### 1.2 根因

进入 agent prompt 的上下文只有两个来源（`src/bot/channel.ts:679-701`）：

1. 当前 debounce 批次里的消息 —— 即用户 @bot 的那条
2. **显式** reply-quote 的目标消息，逐条 `fetchQuotedContext` 拉取

告警消息两者都不属于。直接触发点在 `src/bot/thread-policy.ts:30-39`：

```ts
export function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;
  if (msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;                       // ← 命中这里
  }
  return replyTo;
}
```

SDK 的字段映射是 `replyToMessageId = parent_id`（`@larksuite/channel/dist/index.mjs:1146`）。话题内直接发言时，飞书给出的 `parent_id === root_id`，于是这条「把 thread 锚点当结构、不当引用」的规则命中，告警内容 0 字节进 prompt。

这是被测试固化的既定行为，不是意外 —— `tests/integration/bot/topic-quote.test.ts:67` 的用例名即为 *"does not quote the topic root when a user directly mentions the bot inside the topic"*。

### 1.3 当前唯一可行的人工绕过

用户手动「引用回复」那条告警卡片再 @bot。此时 `parent_id ≠ root_id`，引用正常拉取。本方案要消除的就是这个额外操作。

## 2. 目标与非目标

### 目标

- 话题群内首次触发 agent 时，自动把**话题首条消息（thread root）**作为隐式引用注入 prompt
- 复用现有 `fetchQuotedContext` 管线，包括 CardKit 2.0 卡片展开、merge_forward 展开
- agent 能区分「用户显式引用的消息」和「bridge 自动补的话题首条」
- 可配置关闭

### 非目标（明确不做）

- 不拉取话题内的其他历史消息（多条告警、话题内讨论）—— 那是方案 B，见 §8
- 不改变普通群（`mode === 'group'`）和 p2p 的行为
- 不改变回复是否 in-thread 的逻辑（`shouldReplyInThread` 不动）
- 不新增飞书权限 scope（`im.v1.message.get` 已在用）

## 3. 方案概述

三处改动，一个门控：

```
用户在话题内 @bot
   │
   ├─ mode === 'topic' ?            ──否──> 现状不变
   ├─ 开关开启 ?                     ──否──> 现状不变
   ├─ 该 scope 首轮 ?                ──否──> 现状不变（靠 agent session 记忆）
   ├─ rootId 存在且不在当前批次 ?     ──否──> 现状不变
   │
   └─ 是 ──> rootId 加入 quoteTargets，origin='thread-root'
              │
              └─ 复用 fetchQuotedContext → <quoted_messages> 注入
                 并标记该 scope 已注入
```

**首轮门控的理由**：话题内后续轮次靠 agent session 自身延续记忆，重复注入会让同一段告警文本在 session 里堆多份，白白消耗 context。`/new`、`/cd`、`/ws use` 之后重新注入。

## 4. 详细设计

### 4.1 隐式 root 目标解析

`src/bot/thread-policy.ts` —— **不修改** `replyQuoteTargetForMessage`，新增一个并列函数。

理由：`replyQuoteTargetForMessage` 的语义是「用户**有意**引用的目标」，root 不属于此。把两种来源混进同一个函数会让 `origin` 无从区分，也会污染它现有的 4 个单测语义。

```ts
/**
 * Resolve the thread root to inject as *implicit* context, or `undefined`
 * when there's nothing to inject.
 *
 * Distinct from `replyQuoteTargetForMessage`, which resolves what the user
 * *intentionally* quoted. The root of a topic is structure — but when the
 * topic was opened by an alert card and the user simply @-mentions the bot
 * inside it, that structure IS the context the user means. We inject it once
 * per session and let the agent session carry it from there.
 *
 * Returns `undefined` when the message is not in a thread, has no root, or
 * IS the root itself (the content is already in the batch).
 */
export function implicitThreadRootTarget(
  msg: NormalizedMessage,
): string | undefined {
  if (!msg.threadId || !msg.rootId) return undefined;
  if (msg.rootId === msg.messageId) return undefined;
  return msg.rootId;
}
```

`rootId === messageId` 的判断是防御性的 —— `channel.ts` 侧的 `batchIds` 过滤已经覆盖了这种情况，但这里自洽更好，也让单测能独立断言。

### 4.2 首轮门控的状态存放

**推荐：挂在 `SessionStore` 上的非持久化内存标记。**

理由：需要「重新注入」的时机与 `sessions.clear(scope)` 的调用时机**完全重合** —— 全部 5 个调用点都是语义上的「会话重置」：

| 调用点 | 场景 | 重新注入是否正确 |
|---|---|---|
| `src/commands/index.ts:375` | `/new` | ✅ |
| `src/commands/index.ts:442` | `/cd` | ✅ |
| `src/commands/index.ts:508` | `/ws use` | ✅ |
| `src/bot/run-flow.ts:151` | cwd 漂移导致的 stale 清理 | ✅ |
| `src/bot/run-flow.ts:184` | session 体积轮转 | ✅ |

把标记放进 `SessionStore` 后，这 5 个点零改动自动对齐。

```ts
// src/session/store.ts

export class SessionStore {
  // ... 现有字段
  /**
   * Scopes that already had their thread root injected into a prompt.
   * Deliberately NOT persisted: on restart the agent session is gone too,
   * so re-injecting once is the correct behavior, not a regression.
   */
  private readonly threadRootInjected = new Set<string>();

  hasInjectedThreadRoot(scope: string): boolean {
    return this.threadRootInjected.has(scope);
  }

  markThreadRootInjected(scope: string): void {
    this.threadRootInjected.add(scope);
  }

  clear(chatId: string): void {
    // 必须在 early return 之前 —— 见下方「陷阱」
    this.threadRootInjected.delete(chatId);

    const prev = this.data[chatId];
    if (!prev) return;
    // ... 现有逻辑不变
  }
}
```

> **陷阱**：`clear()` 现有实现第 94 行是 `if (!prev) return;`。如果把 `threadRootInjected.delete` 放在它后面，会漏掉这个真实场景 —— 首轮注入了 root，但那次 run 失败 / 被 `/stop` 打断，没写下 session entry；此时用户 `/new`，`clear` 早退，标记没清，第二轮不再注入。**删除必须放在方法第一行。**

**备选方案（未采纳）**：独立的 `ThreadRootTracker` 类。语义更干净（`SessionStore` 不承担 thread 语义），但需要把实例穿透到 `CommandContext` 并在 5 个 clear 点手动调用 `reset`，改动面是推荐方案的数倍，且容易漏点。若后续做方案 B、状态变复杂，再抽出来。

**为什么不用「有没有 session」来判首轮**：`recordRunSessionEvent`（`src/bot/run-flow.ts:241-263`）只在 claude 下写 `SessionStore`，codex 只写 `sessionCatalog`。用 `sessions.getRaw(scope)?.sessionId` 判定会让 codex 永远命中「首轮」，退化成每轮注入。而查 `sessionCatalog.activeFor()` 需要 `cwdRealpath` 和 `policyFingerprint` —— 这两个值要到 `startRunFlow` 内部才算出来，prompt 构建时拿不到。

### 4.3 注入点

`src/bot/channel.ts:679-701`，`runAgentBatch` 内。当前代码：

```ts
const batchIds = new Set(batch.map((m) => m.messageId));
const quoteTargets = [
  ...new Set(
    batch
      .map((m) => replyQuoteTargetForMessage(m))
      .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
  ),
];
const quotes: QuotedContext[] = [];
for (const targetId of quoteTargets) {
  const q = await fetchQuotedContext(channel, targetId);
  if (q) { quotes.push(q); log.info('quote', 'fetched', { ... }); }
}
```

改为带 `origin` 的目标列表：

```ts
const batchIds = new Set(batch.map((m) => m.messageId));

type QuoteTarget = { id: string; origin: 'explicit' | 'thread-root' };
const seenTargets = new Set<string>();
const quoteTargets: QuoteTarget[] = [];

const pushTarget = (id: string | undefined, origin: QuoteTarget['origin']): void => {
  if (!id || batchIds.has(id) || seenTargets.has(id)) return;
  seenTargets.add(id);
  quoteTargets.push({ id, origin });
};

// 显式引用优先入列：同一 id 既被显式引用又是 thread root 时，
// 保留 'explicit' 这个更强的语义。
for (const m of batch) pushTarget(replyQuoteTargetForMessage(m), 'explicit');

const injectRoot =
  mode === 'topic' &&
  getThreadRootContext(controls.cfg) &&
  !sessions.hasInjectedThreadRoot(scope);
if (injectRoot) {
  pushTarget(implicitThreadRootTarget(firstMsg), 'thread-root');
}

const quotes: QuotedContext[] = [];
for (const target of quoteTargets) {
  const q = await fetchQuotedContext(channel, target.id);
  if (q) {
    quotes.push({ ...q, origin: target.origin });
    log.info('quote', 'fetched', {
      messageId: target.id,
      origin: target.origin,
      type: q.rawContentType,
      contentChars: q.content.length,
    });
  }
}

// 只在真的拿到内容后才置位，否则一次 API 失败会永久吞掉这个话题的上下文
if (injectRoot && quotes.some((q) => q.origin === 'thread-root')) {
  sessions.markThreadRootInjected(scope);
}
```

要点：

- **`mode` 与 `scope` 已在 `RunBatchDeps` 中**（声明于 `src/bot/channel.ts:632-633`，解构于 `:649-650`），无需新增参数传递
- **`sessions` 也已在 `RunBatchDeps` 中**，无需新增依赖
- **置位在成功之后**：`fetchQuotedContext` 内部对 API 失败是 `return undefined`（`src/bot/quote.ts:72-79`）。若失败也置位，这个话题在整个 session 生命周期内再也拿不到 root，且用户无从察觉。失败时不置位 ⇒ 下一轮自动重试
- **取 `firstMsg` 而非遍历 batch**：一个 batch 内的消息同属一个 scope、同一个 thread，root 必然相同

### 4.4 `QuotedContext` 与 prompt 字段

`src/bot/quote.ts` 的 `QuotedContext` 加可选字段：

```ts
export interface QuotedContext {
  // ... 现有字段
  /**
   * How this context entered the prompt. 'explicit' = the user reply-quoted
   * it; 'thread-root' = bridge auto-injected the topic's opening message.
   * Absent is treated as 'explicit' by consumers.
   */
  origin?: 'explicit' | 'thread-root';
}
```

`fetchQuotedContext` 本身不设置它（它不知道调用意图），由 `channel.ts` 在组装时打标。

`src/agent/prompt.ts` 的 `BridgePromptQuotedMessage` 同步加 `origin?: 'explicit' | 'thread-root'`，`src/bot/channel.ts:1574` 的 `toPromptQuote` 透传：

```ts
function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    ...(q.origin ? { origin: q.origin } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}
```

### 4.5 system prompt 说明

`src/agent/bridge-system-prompt.ts` 的 `## quoted_message` 段（第 56 行起）现在写的是「这是用户**指向的对象**」。`thread-root` 来源不符合这个描述 —— 用户没有指向它，是 bridge 补的。追加一段：

```markdown
`origin` 字段区分这段内容是怎么进来的：

- `explicit`（或缺省）：用户主动引用回复指向的消息。用户的问题围绕它展开。
- `thread-root`：用户在飞书话题里直接 @ 你，bridge 自动补上的**话题首条消息**。
  典型是告警卡片、值班播报这类开启话题的内容。用户没有显式引用它，但话题里
  的提问几乎都是针对它的。把它当作背景事实来读，不要在回复里复述整段原文，
  也不要说「你引用了……」。

两种来源都只在**该会话的第一轮**注入一次。后续轮次不会重复给你 —— 需要时从
上文自己记住，不要反过来要求用户再发一遍。
```

最后一句很重要：没有它，agent 在第二轮很可能回一句「请把告警内容再发一次」，那就退回了原问题。

### 4.6 配置开关

`src/config/schema.ts`，跟随 `replyInThreadInGroup` 的既有模式（`!== false` 默认开启）。

`Preferences` 接口加字段（紧邻 `replyInThreadInGroup`，第 119 行附近）：

```ts
/**
 * Whether bridge auto-injects a topic's opening message (thread root) as
 * context on the first turn of each topic session. Default true. Only
 * affects topic-mode groups. Set false to keep prompts minimal — users can
 * still reply-quote the root manually.
 */
threadRootContext?: boolean;
```

访问器（放在 `getReplyInThreadInGroup` 之后，第 363 行附近）：

```ts
/**
 * Resolve the topic-root-context preference. Default `true` — the `!== false`
 * check makes older configs without the field inherit the new default.
 * Only affects topic groups; regular groups and p2p never inject a root.
 */
export function getThreadRootContext(cfg: AppConfig): boolean {
  return cfg.preferences?.threadRootContext !== false;
}
```

## 5. 改动清单

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/bot/thread-policy.ts` | 新增 `implicitThreadRootTarget` | +20 行 |
| `src/session/store.ts` | 新增 `threadRootInjected` Set + 2 个方法；`clear()` 首行加 delete | +15 行 |
| `src/bot/channel.ts` | `runAgentBatch` 的 quoteTargets 收集重写为带 origin；`toPromptQuote` 透传 | ~+25 / -10 行 |
| `src/bot/quote.ts` | `QuotedContext` 加 `origin?` | +6 行 |
| `src/agent/prompt.ts` | `BridgePromptQuotedMessage` 加 `origin?` | +2 行 |
| `src/agent/bridge-system-prompt.ts` | `## quoted_message` 段追加 origin 说明 | +12 行 |
| `src/config/schema.ts` | `threadRootContext` 字段 + `getThreadRootContext` | +15 行 |

**不改动**：`replyQuoteTargetForMessage`、`shouldReplyInThread`、`scopeFor`、`fetchQuotedContext` 主体、`expandInteractiveCard`、media / attachment 链路。

零新增飞书 API 类型，零新增权限 scope，单轮最多多一次 `im.v1.message.get`。

## 6. 边界与取舍

### 6.1 已知会打破的既有测试

`tests/integration/bot/topic-quote.test.ts:67` —— 用例 *"does not quote the topic root when a user directly mentions the bot inside the topic"* **断言的正是本方案要反转的行为**：

```ts
expect(prompt).not.toContain('<quoted_messages>');
expect(prompt).not.toContain('topic root content');
expect(h.channel.fetchRawMessage).not.toHaveBeenCalled();
```

这不是「顺手改挂掉的测试」，是本方案的核心行为变更。处理方式见 §7.2 —— 改写为正向断言，并另加一个「开关关闭时维持旧行为」的用例保留原语义。

### 6.2 session 被压缩或丢失

选定的「仅首轮注入」策略有一个明确风险：若 agent session 的上下文被压缩，或 claude 侧 JSONL 轮转（`sessionRotateMaxBytes`），告警原文可能从 agent 记忆里消失，而 bridge 认为已注入、不再补。

缓解：

- `run-flow.ts:184` 的轮转路径会调 `sessions.clear()`，标记随之清除 —— **轮转场景已自动覆盖**
- 上下文压缩（claude 自身的 compact）不经过 bridge，无法感知。用户的兜底是 `/new` 或手动引用回复
- 若上线后此问题频发，再考虑 `preferences.threadRootContext: 'always'` 的三态化

### 6.3 只覆盖话题首条

告警话题里若有多条消息（初始告警 + 后续恢复通知 + 他人补充），只有首条进 prompt。这是方案 A 的既定边界，方案 B 才解决，见 §8。

### 6.4 普通群不生效

`mode === 'group'` 且开启 `replyInThreadInGroup` 时也会产生 thread，但那个 thread 的 root 通常是用户自己上一轮的提问 —— 注入价值低，且多半已被 `batchIds` 过滤。保持不变，避免扩大影响面。

### 6.5 bridge 重启

`threadRootInjected` 不持久化。重启后每个话题会再注入一次 root。这是**期望行为**而非缺陷：重启时 agent 进程也没了，session 靠 resume 恢复，上下文完整性存疑，重补一次更安全。代价是一次额外 API 调用。

### 6.6 root 是纯图片 / 空内容卡片

`fetchQuotedContext` 会返回内容，但可能是 `[interactive card]` 展开后的裸 JSON（`expandInteractiveCard` 的 Branch 3）。agent 能读到卡片结构。root 是纯图片消息时，`QuotedContext.content` 会很短且无信息量 —— **图片本身不会被下载**（media 链路只处理当前批次的 `resources`）。这是已知缺口，不在本次范围内，文档记录备查。

## 7. 测试计划

> 遵循 `CLAUDE.md`：只跑最小范围，`vitest run`，不加 `--pool` 覆盖。
> 本方案涉及 unit + integration 两层，串行执行。

### 7.1 新增单测 —— `tests/unit/bot/thread-policy.test.ts`

在既有 `describe` 之后追加：

```ts
describe('implicitThreadRootTarget', () => {
  it('returns the root for an in-thread message', () => {
    expect(
      implicitThreadRootTarget(
        msg({ messageId: 'm2', threadId: 'omt_1', rootId: 'root1' }),
      ),
    ).toBe('root1');
  });

  it('returns undefined outside a thread', () => {
    expect(implicitThreadRootTarget(msg({ rootId: 'root1' }))).toBeUndefined();
  });

  it('returns undefined when the message IS the root', () => {
    expect(
      implicitThreadRootTarget(
        msg({ messageId: 'root1', threadId: 'omt_1', rootId: 'root1' }),
      ),
    ).toBeUndefined();
  });

  it('returns undefined when there is no rootId', () => {
    expect(
      implicitThreadRootTarget(msg({ messageId: 'm2', threadId: 'omt_1' })),
    ).toBeUndefined();
  });
});
```

既有的 4 个 `replyQuoteTargetForMessage` 用例**全部保持不变** —— 该函数未改动。

### 7.2 新增 / 改写集成测试 —— `tests/integration/bot/topic-quote.test.ts`

**改写**第一个用例（`:67`），从「不注入」反转为「注入且标记 origin」：

```ts
it('injects the topic root as implicit context on the first turn', async () => {
  const h = await createHarness({
    quotedMessages: { om_topic_root: 'topic root content' },
  });
  await startTestBridge(h);

  await h.channel.handlers.message?.(
    message({
      messageId: 'om_direct_at',
      rootId: 'om_topic_root',
      parentId: 'om_topic_root',
      threadId: 'omt_topic',
      content: '@Bridge 分析一下这个告警',
    }),
  );
  await waitFor(() => h.agent.runOptions.length === 1);

  const prompt = h.agent.runOptions[0]?.prompt ?? '';
  expect(prompt).toContain('"threadId":"omt_topic"');
  expect(prompt).toContain('<quoted_messages>');
  expect(prompt).toContain('topic root content');
  expect(prompt).toContain('"origin":"thread-root"');
  expect(h.channel.fetchRawMessage).toHaveBeenCalledWith(
    'om_topic_root',
    expect.objectContaining({ cardContentType: 'user_card_content' }),
  );
});
```

**新增**以下用例：

| 用例 | 断言要点 |
|---|---|
| 第二轮不重复注入 | 连发两条（等第一条 run 完），第二个 prompt 不含 `thread-root`；`fetchRawMessage` 总调用次数为 1 |
| `/new` 之后恢复注入 | 首轮 → `/new` → 再触发，第二次 prompt 重新含 `thread-root` |
| 开关关闭维持旧行为 | `preferences.threadRootContext: false` 时不含 `<quoted_messages>`，`fetchRawMessage` 未被调用（**保留原用例语义**） |
| 显式引用胜过 thread-root | `parentId` 指向非 root 的消息：该消息 origin 为 `explicit`，root 另行注入（首轮），两条都在 |
| 用户消息就是 root | `messageId === rootId` 时不注入、不调 API |
| root 拉取失败不置位 | mock `fetchRawMessage` 首次 reject，第二轮仍尝试注入（`fetchRawMessage` 被调 2 次） |
| 普通群不注入 | `chatMode: 'group'` + thread 字段齐全 → 不含 `thread-root` |

既有的另两个用例（`keeps regular group reply quotes` / `keeps non-root reply quotes in topic chats`）**保持不变**，它们覆盖显式引用路径，本方案不应影响。注意后者在首轮会额外带上 root —— 如果它的断言是 `toContain` 而非精确匹配数量，无需改；若断言了引用条数，需相应调整。

### 7.3 `SessionStore` 单测

若 `tests/unit/session/store.test.ts` 存在则追加，否则新建：

- `markThreadRootInjected` → `hasInjectedThreadRoot` 为 true
- `clear(scope)` 后 → 为 false
- **`clear(scope)` 在该 scope 从无 session entry 时也能清除标记**（覆盖 §4.2 的 early-return 陷阱）
- 标记不写入磁盘：`clear` 前后 `load()` 重建的实例，`hasInjectedThreadRoot` 恒为 false

### 7.4 执行顺序

```bash
pnpm test:unit                                        # 先跑单测
pnpm vitest run tests/integration/bot/topic-quote.test.ts   # 再跑受影响的集成测试
pnpm test                                             # 全量兜底，仅在前两步全绿后
```

### 7.5 真实环境验证

单测覆盖不到「飞书真的给出 `parent_id === root_id`」这个前提。合并前必须在真实话题群走一次：

1. 让告警机器人（或手动发一条卡片）开启一个话题
2. 话题内 @bot：「分析一下这个告警」
3. 检查日志出现 `quote fetched { origin: 'thread-root' }`
4. 检查 bot 回复确实引用了告警内容
5. 同话题内再问一句，确认日志**没有**第二次 `thread-root`

## 8. 与方案 B 的关系

方案 B（`im.v1.message.list(container_id_type='thread')` 拉全量话题历史）在本方案之上扩展，不推翻它：

- `origin` 字段预留了 `'thread-history'` 这个值
- `hasInjectedThreadRoot` / `markThreadRootInjected` 可泛化为 `hasInjectedThreadContext`
- 注入点（`runAgentBatch` 的 quoteTargets 收集）不变
- 新增的是一个独立的 `src/bot/thread-history.ts`，负责分页、条数上限、按字数裁剪

方案 B 的额外成本（相对本方案）：飞书历史读取权限、分页处理、裁剪策略、prompt 体积控制。建议本方案上线观察后再评估是否需要。

## 9. 回滚

运行时：`preferences.threadRootContext: false` 即恢复旧行为，无需重新部署代码。

代码：改动集中且无数据迁移、无 schema 破坏性变更（新增字段全部 optional），单个 commit revert 即可。

## 10. 待确认

1. **`parent_id === root_id` 的实际取值**需要真实环境确认（§7.5）。若飞书在话题内直接发言时 `parent_id` 为空而非等于 `root_id`，那么 `implicitThreadRootTarget` 依然成立（它只看 `threadId` + `rootId`），但 §1.2 的根因描述需要修订 —— 结论不变，路径描述需更准确。
2. **`rootId` 在话题内是否恒等于话题首条消息 id**。若飞书语义是「被回复消息链的顶端」而非「话题首条」，在有嵌套回复的话题里可能取到非首条。真实验证时一并确认。

## 11. 实施记录

实施于 `feat/topic-root-context`，TDD 五轮，每轮先跑红再实现。改动与 §5 清单一致，`src/` 共 7 文件 +118/-16。

与设计的偏差：

1. `QuoteOrigin` 作为独立 type alias 从 `src/bot/quote.ts` 导出，而非在两处各写一遍联合类型。
2. 集成测试 harness 扩展了两个选项：`preferences`（注入 profileConfig.preferences）和 `failFetchOnce`（模拟 API 失败），设计文档里未预先写出。
3. `getThreadRootContext` 的 import 放在 `channel.ts` schema import 列表末尾，与既有排列一致。

### 测试结果

| 范围 | 结果 |
|---|---|
| `pnpm test:unit` | 71 文件 / 485 用例 通过 |
| `pnpm test:integration` | 41 文件 / 233 用例 通过 |
| `pnpm test`（全量） | 115 文件 / 742 用例 通过 |
| `pnpm build` | 通过 |
| `pnpm typecheck` | **失败 —— 预存问题，与本次改动无关** |

`pnpm typecheck` 在 `tests/unit/card/config-form-message-reply.test.ts:21` 报 `larkCliIdentity` 类型不兼容（TS2352）。已 stash 全部改动在基线上复现同一错误，确认与本方案无关，未修。

新增测试：

- `tests/unit/bot/thread-policy.test.ts` +4（`implicitThreadRootTarget`）
- `tests/unit/session/store.test.ts` 新建，5 用例（标记生命周期，含 early-return 陷阱与不持久化）
- `tests/unit/config/schema.test.ts` +3（`getThreadRootContext`）
- `tests/unit/agent/bridge-system-prompt.test.ts` +3（origin 说明）
- `tests/integration/bot/topic-quote.test.ts`：1 个反转 + 7 个新增，共 10 用例

### 顺带发现（未处理）

`src/bot/quote.ts` 的 `renderQuotedBlock` 已无任何调用点 —— prompt 走的是 `buildAgentPrompt` 的 JSON 序列化路径，不走这个 XML 渲染函数。预存死代码，按「只提示不删除」的约定未动。若要清理，注意它也没有对应的 origin 字段渲染。

### 仍待真机验证

§10 的两个前提本地无法证伪，必须按 §7.5 在真实话题群走一遍后才能合并。

## 12. 真机验证结果与设计修正（2026-09-21）

第一次真机验证**失败**：告警话题内 @bot，bot 回复「话题里只有你的 @」，`quotes: 0`。

### 12.1 根因

日志：

```json
{"phase":"chat","event":"mode-resolved","mode":"group"}
{"phase":"intake","event":"enter","chatMode":"group","scope":"oc_921b..."}
{"phase":"prompt","event":"built","quotes":0}
```

**这个群的 chat mode 是 `group`，不是 `topic`。** §4.3 的门控第一个条件 `mode === 'topic'` 不成立，整段注入逻辑没进。

§6.4 当时的判断是：

> 普通群不生效 —— `mode === 'group'` 的 thread，root 通常是用户自己上一轮的提问，注入价值低，保持不变。

**这个假设是错的。** 飞书的「话题群」（chat mode = `topic`，整个群以话题为单位组织）和「在普通群的某条消息下开话题」是两回事。告警场景清一色是后者：群是普通群，告警机器人发一张卡片，人在那张卡片下开话题提问。`getChatMode` 对这种群返回 `group`，而 root 恰恰是最有价值的那条告警。方案把唯一重要的场景排除掉了。

### 12.2 §10 两个待确认项的答案

原生 `im.v1.messages?container_id_type=thread` 查那条 @bot 消息：

```
message_id: om_x100b6438bf5750a8c2e903e53ac9938   (用户「分析告警」)
  thread_id: omt_19d526ba620f1c82
  root_id:   om_x100b643ea9f9cca0b2ee2dcff70365f  ← 天眼告警卡片
  parent_id: om_x100b643ea9f9cca0b2ee2dcff70365f  ← 同一条
```

1. **`parent_id === root_id` 成立** —— §1.2 的根因描述准确。
2. **`rootId` 指向话题宿主消息**，即开启话题的那条原始消息，不是回复链顶端。`implicitThreadRootTarget` 的取值正确。

排查中的一个弯路值得记下来：`lark-cli im +messages-mget` 和 `+threads-messages-list` 把 `root_id` / `parent_id` 显示成 `null`，一度让人以为飞书没下发这两个字段。那是 lark-cli 封装层丢字段，原生 API 有。**排查 thread 字段时不要信 lark-cli 的封装输出，直接用 `lark-cli api GET /open-apis/im/v1/messages`**（且 `--as user`，bot 身份不在目标群里会报 230002）。

### 12.3 修正

| 项 | 改前 | 改后 |
|---|---|---|
| 门控 | `mode === 'topic' && 开关 && 未注入` | `开关 && 未注入` |
| 配置项 | `preferences.topicRootContext` | `preferences.threadRootContext` |
| `intake.enter` 日志 | 无 thread 字段 | 加 `threadId` / `rootId` / `replyTo` |

去掉 mode 判断是安全的：`implicitThreadRootTarget` 本身要求 `threadId && rootId`，`pushTarget` 又会丢弃已在当前批次里的 id，所以非线程消息和「当前消息就是 root」都不会产生注入。p2p 没有 thread，天然不受影响。

配置项改名是因为它不再只管 topic 群；此时尚未发版，改名无迁移成本。

`intake.enter` 的三个新字段是为了下一次排查：webhook 事件是否携带 `root_id` 目前仍未直接观测到（§12.2 的值来自主动查 API）。若事件里没有它，放宽门控也不够，得改走 thread API —— 日志会立刻给出答案。

### 12.4 测试变更

- `tests/integration/bot/topic-quote.test.ts`：`never injects a root in a regular group` **反转**为 `injects the root for a thread inside a regular group`；新增 `does not inject anything for a regular group message with no thread`
- `tests/unit/config/schema.test.ts`：跟随改名

全量：115 文件 / 743 用例通过；`pnpm build` 通过；`pnpm typecheck` 仍是 §11 记录的预存失败。
