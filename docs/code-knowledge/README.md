# lark-coding-agent-bridge 代码知识库

> 基于分支 `feat/topic-root-context` 的源码分析,2026-10-24 完成并经交叉验证(验证记录与修正清单见 [analysis-gaps.md](./analysis-gaps.md))。
> 引用规范:`src/相对路径 → 符号()`;除标注【待验证】外均有源码证据。

## 文档清单

| 文档 | 解决的问题 |
|---|---|
| [project-overview.md](./project-overview.md) | 项目是什么、技术栈、怎么跑、状态文件在哪、心智模型 |
| [architecture.md](./architecture.md) | 进程模型、分层与依赖方向、关键设计决策、五条主干通路、并发模型 |
| [module-map.md](./module-map.md) | 每个目录/模块的职责、关键符号、上下游(含行号,注意漂移) |
| [feature-catalog.md](./feature-catalog.md) | **功能 → 代码位置索引**(F01-F34,含触发入口/实现/数据/测试/证据状态) |
| [message-flow.md](./message-flow.md) | 飞书消息处理七步摘要 + 深入入口 |
| [command-reference.md](./command-reference.md) | 主机 CLI 与 19 个聊天命令全表(含子命令、admin 门控、占位命令) |
| [agent-integration.md](./agent-integration.md) | Claude(PTY/headless)与 Codex 接入:契约、启动参数、IO 协议、终止 |
| [session-and-workspace.md](./session-and-workspace.md) | Profile/scope/cwd/会话五层关系、双存储、隔离矩阵 |
| [security-and-configuration.md](./security-and-configuration.md) | 四层 ACL、密钥库、secret 解析链、权限映射、目录边界、日志脱敏 |
| [web-ui.md](./web-ui.md) | 为什么没有 Web 界面;界面=飞书卡片 |
| [testing.md](./testing.md) | 测试分层、纪律(CLAUDE.md)、关键机制↔测试对应、覆盖缺口 |
| [analysis-gaps.md](./analysis-gaps.md) | **27 个未决/已决问题**(错误修正记录 + 待验证清单 + 测试建议) |
| flows/[message-to-agent.md](./flows/message-to-agent.md) | 消息接收→解析→路由→Agent 执行(8 阶段+时序图) |
| flows/[streaming-response.md](./flows/streaming-response.md) | 输出读取→翻译→状态机→三路渲染→终态(阶段 8-11+异常矩阵) |
| flows/[session-lifecycle.md](./flows/session-lifecycle.md) | 会话状态机(创建/续接/轮转/重置/恢复/GC 未接线) |
| flows/[queue-and-cancellation.md](./flows/queue-and-cancellation.md) | 合批、三层并发、/stop、三级超时、清理链 |
| flows/[process-lifecycle.md](./flows/process-lifecycle.md) | 子进程从 spawn 到回收;bridge 自身死亡兜底 |

## 推荐阅读顺序

**新人上手**(1-2 小时):project-overview → architecture → message-flow → command-reference
**改某个功能前**:feature-catalog 定位编号 → 对应 flow 文档看调用链 → analysis-gaps 确认该区域无未决问题
**专项深入**:Agent 相关读 agent-integration + flows/process-lifecycle;会话相关读 session-and-workspace + flows/session-lifecycle;安全相关读 security-and-configuration;测试相关读 testing
**动手改码前必读**:`CLAUDE.md`(测试纪律)+ analysis-gaps.md(哪些结论还没验证)

## 已知最重要的三个"反直觉"事实

1. Claude 的事件流来自**磁盘 JSONL 轮询**(`src/agent/claude/pty-session.ts → runTurn()`),不是进程 stdout;轮次结束信号是 `system(turn_duration)`,不是 `stop_reason`。
2. 会话身份是**四元组**(scope+agent+cwd+策略指纹)——改权限配置会静默断开旧会话续接。
3. `SessionCatalog.gc` **没有生产调用点**(有实现有测试但未接线),catalog 条目无限累积(analysis-gaps.md G1)。
