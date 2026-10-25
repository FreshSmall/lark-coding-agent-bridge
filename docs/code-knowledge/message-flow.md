# 飞书消息处理(高层摘要 + 深入入口)

> 状态:正式知识库文档(已验证)。本文是消息主链路的**入口摘要**;逐步调用链、代码位置表、时序图、异常矩阵在 flows/ 两篇深度文档中,不在此重复。

## 1. 一条消息的旅程(七步,已确认)

```
① 飞书 WS 推送事件 → SDK 归一化(NormalizedMessage)+ messageId 去重/过期丢弃
② src/bot/channel.ts → intakeMessage():
   scope 解析(p2p/群=chatId,话题群=chatId:threadId)
   → ACL 四层门(创建者/admins/allowedUsers/allowedChats)
   → 群 @bot 策略 → 斜杠命令分流(就地处理并清积压)
   → 否则入 PendingQueue
③ 600ms 防抖合批 → runAgentBatch():
   附件下载 → 引用上下文 → 话题上下文(每会话一次)
   → buildPrompt() 组装分节 prompt → ACL 复查
④ src/bot/run-flow.ts → startRunFlow():
   工作目录校验 → 运行策略(权限映射+策略指纹,5min TTL)
   → 会话续接判定(catalog 四元组 → sessions 兜底 → 轮转检查)
⑤ src/runtime/run-executor.ts → submit():
   scope 预留 → 全局并发池 → 适配器 run()
⑥ Agent 执行(claude PTY 复用/新起,codex 新进程)→ AgentEvent 流
⑦ processAgentStream():reduce 成 RunState →
   card(实体卡+350ms 节流)/ markdown(打字机+降级)/ text(一次性)
   → 终态裁决 → 写回会话 → 落账 → 释放并发槽
```

## 2. 深入文档

| 关注点 | 文档 |
|---|---|
| ①-⑥ 逐步调用链(含 SDK 机制、去重、门卫、prompt 结构、三种 Agent 执行、时序图) | [flows/message-to-agent.md](./flows/message-to-agent.md) |
| ⑥-⑦ 输出读取(JSONL/stdout)、翻译、状态机、三路渲染、降级、异常矩阵 | [flows/streaming-response.md](./flows/streaming-response.md) |
| 会话怎么续接/重置/恢复 | [flows/session-lifecycle.md](./flows/session-lifecycle.md) + [session-and-workspace.md](./session-and-workspace.md) |
| 连发消息、并发、/stop、超时 | [flows/queue-and-cancellation.md](./flows/queue-and-cancellation.md) |
| 子进程生死 | [flows/process-lifecycle.md](./flows/process-lifecycle.md) + [agent-integration.md](./agent-integration.md) |

## 3. 关键事实速查(均已验证)

- **事件接收机制**:飞书开放平台 WebSocket 长连接 → node-sdk WSClient → `@larksuite/channel` 归一化 → EventMap 内存回调;bridge 不监听任何端口。SDK EventMap 含 `botAdded` 但 bridge **未注册**该回调(knownChats 靠 30min 定时刷新)——见 analysis-gaps.md G14。
- **去重**:SDK 层 messageId dedup + stale 窗口,静默丢弃;bridge 层不再去重。
- **用户/群/话题区分**:scope 键;话题群经 `ChatModeCache`(一次 chat.get 缓存)识别。
- **关联结构**:scope ↔ SessionStore/SessionCatalog(会话)↔ WorkspaceStore(cwd)↔ ActiveRuns(任务)↔ 飞书消息(replyTo + 卡片回调签名令牌内嵌 runId/scope)。
- **防冲突**:SDK dedup + PendingQueue block + ActiveRuns.reserve + ProcessPool cap + 策略 5min TTL。
- **失败处理**:前置拒绝回用户可读中文文案;agent 失败上卡;markdown 流失败降级一次性发送;回帖被撤回降级顶层;进程级 unhandledRejection 只记日志不退出。
- **两个特别分支**:AskUserQuestion(卡片问答→按键写回 PTY,见 streaming-response.md 阶段 9)与云文档评论(独立入口 `src/bot/comments.ts → handleCommentMention()`,feature-catalog F29)。
