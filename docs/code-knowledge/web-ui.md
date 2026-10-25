# Web 界面:本项目没有

> 状态:正式知识库文档(已验证,2026-10-24 grep 确认)。

## 结论

**lark-coding-agent-bridge 没有任何 Web 界面**——不存在 HTTP 服务器、不监听任何端口、无前端构建产物:

- `grep -rn "express|http.createServer|fastify|koa|listen(" src/` 无命中(仅 keepalive 的探测定时器)。
- `package.json` 依赖中无任何 Web 框架。
- 构建产物只有 `dist/cli.js`(CLI 入口)与 `dist/index.js`(库导出,渲染逻辑复用)。
- SDK 的 `transport` 选项支持 webhook(express/koa adapter),但 bridge 未配置——**只使用 WebSocket 长连接**(`src/bot/channel.ts → startChannel()` 组装 `LarkChannelOptions` 时无 webhook 字段)。

## "界面"实际是什么

用户的交互界面全部是**飞书客户端内的消息与卡片**:

| 界面元素 | 实现 | 说明 |
|---|---|---|
| 流式运行卡片 | `src/card/run-renderer.ts → renderCard()` + `src/card/managed.ts`(CardKit 2.0 实体卡,350ms 节流全量更新) | 文本/工具调用/todo/token 实时刷新 |
| 卡片按钮 | stop / AskUserQuestion 选项 / 👍👎 / 检查点"继续等待/立即终止" | 回调走 `src/card/dispatcher.ts`,HMAC 验签 |
| 配置表单卡 | `src/card/config-card.ts`(9 项设置) | CardKit form_value 提交 |
| 终端 UI(主机侧) | qrcode-terminal(QR 绑定)+ @clack/prompts(安装向导/交互确认) | 唯一的"本地界面"是终端本身 |

## 唯一的对外 HTTP 面

bridge 对外仅作为**客户端**发起请求:飞书开放平台 REST/WS(经 SDK,支持 `HTTPS_PROXY`)、keepalive 的可达性探测(`src/bot/keepalive.ts`)。无入站 HTTP。

> 若未来出现 Web 界面需求(如本地仪表盘),应作为新进程/新端口设计,并在本文件更新——当前代码库中不存在任何可复用的 Web 基础设施。
