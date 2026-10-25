# 机制:安全与配置(身份校验 / 密钥 / 权限 / 边界 / 脱敏)

> 生成时间:2026-10-24。分支 `feat/topic-root-context`。

## 0. 解决的问题

一个能执行任意本地命令的 agent bot 暴露在 IM 里,安全面包括:谁能触发(身份)、agent 能做什么(权限)、秘密存哪(密钥)、哪些信息能进日志/回复(脱敏)、恶意回调能不能伪造(签名)。本文逐一对应实现。

## 1. 飞书身份与权限校验(已确认)

**入口三处同一套 ACL**(`src/policy/access.ts`):
- IM 消息:`intakeMessage`(`channel.ts:567-583`);
- 卡片回调:`handleCardAction`(`card/dispatcher.ts:70-80`);
- 命令管理权:`canRunAdminCommand`(ADMIN_COMMANDS 11 个,`commands/index.ts:233-247`)。

**身份四层**(`access.ts:26-54`):
1. **创建者(app owner)**:`isCreator` 按 `controls.botOwnerId` 判;owner 从飞书 API 定期刷新(30min,`policy/owner.ts:4,47`),**不落 config**——转让 app 所有权后新 owner 自动获得全部权限,旧的失效;
2. **admins**(`access.admins`,open_id 列表):全通 + 任意群 + 管理命令;
3. **allowedUsers**:DM 白名单;
4. **allowedChats**:群白名单(对群内所有人生效)。

**默认 fail-closed**:空列表=没人(`schema.ts:75-82` 注释:"no DM senders, no group chats, and only the runtime owner can administer")。拒绝策略:陌生人**完全沉默**(不回错误提示,防探测);唯一例外是未开白名单群里被 @ 时回一条"管理员可 /invite group"提示(`sendNonAllowedGroupHint`,`channel.ts:497-510`)。

**运行期二次防线**:`evaluateRunPolicy`(`policy/run-policy.ts:95`)把 access 再复核一遍(debounce 窗口内配置可能变了),并产出 5min TTL——防拿旧授权拖很久才执行。

## 2. 配置文件与 Profile(已确认)

布局见 [session-and-workspace.md](./session-and-workspace.md) §1。要点:
- `config.json` = RootConfig v2(`{schemaVersion, profiles: {name→ProfileConfig}, activeProfile}`,`config/profile-schema.ts:105`);写路径统一 `withConfigFileLock`(文件锁防并发写坏,`profile-store.ts`);
- ProfileConfig 字段:agentKind / codex{binaryPath,codexHome,…} / permissions{defaultAccess,maxAccess} / access{allowedUsers,allowedChats,admins,requireMentionInGroup} / workspaces.default / attachments 策略 / larkCli 身份策略 / secrets 引用;
- v1→v2 迁移:`config/migrate-v2.ts` + `cli migrate` 命令;legacy `sandbox` 字段自动规范化为 `permissions`(`permissions.ts:40`);
- 运行时热改:所有 getter 每次读现值(如 `getMaxConcurrentRuns`),`/config`、`/invite` 改完下一条消息生效,无需重启。`/config` 表单 9 个设置项(2026-10-24 已核,见 §11-3)。

## 3. 密钥管理(已确认)

**存储**:`~/.lark-channel/profiles/<p>/secrets.enc`(AES-256-GCM 信封 `{iv,data,tag}`,key = PBKDF2-SHA256(100k 迭代) of `hostname|username` + 32B salt,`config/keystore.ts:1-24,86-94`)。文件 0600。**明确定位为防误披露(备份/日志/git),不防同用户进程**(注释原话;真威胁模型交给 OS keychain,而 lark-cli bind 时已把秘密终止在自己的 keychain)。

**解析链**(`config/secret-resolver.ts:38-70`,每次 `startChannel` 重跑,支持 /account 热换):
```
app.secret = 明文字符串 ──────────────────→ 原样
           | "${VAR}" 模板 ────────────→ process.env[VAR]
           | {source:'env', id, provider?} → env(可配 allowlist 白名单,:107-113)
           | {source:'file',id} ─────────→ 文件内容 trim(可配相对根)
           | {source:'exec',id,provider} → spawn provider,stdin/stdout JSON-RPC
                                            └─ 若 provider 命令=bridge 自身 → 短路直读 keystore(防 fork 炸弹,:127+ 注释)
```
exec 协议与 lark-cli 相同(`secrets get` 子命令即该协议服务端,`cli/index.ts:213`)。

## 4. Agent 权限设置(已确认)

三档 AccessMode(`read-only | workspace | full`)双向映射(`config/permissions.ts:96-116`):
| bridge | claude `--permission-mode` | codex `--sandbox` |
|---|---|---|
| full | bypassPermissions | danger-full-access |
| workspace | acceptEdits | workspace-write |
| read-only | plan | read-only |

实际生效值 = `clampAccess(defaultAccess, maxAccess, capability.maxAccess)` 取最严(`:73-81`)。两个附加策略:codex 恒 `-c approval_policy="never"`(审批全部自动通过,靠 sandbox 兜底,`codex/argv.ts:26-27`);p2p claude 默认强制 bypassPermissions(`claudeP2pAutoApprove` 偏好,`run-policy.ts:74-80`)。权限变化 → `policyFingerprint` 变化 → 旧会话不再续接(见 session-and-workspace.md §1)。

## 5. 工作目录边界(已确认)

10 种高危目录拒绝(`policy/workspace.ts:81-141`):文件系统根、home 根、/Users、Desktop/Downloads、tmp 根、9 个 macOS 系统目录、/Volumes 及一级子卷。校验在 /cd、/ws use、每 run、cross-cwd resume 四处执行。**cwd 不是沙箱**(README 明示;真实边界=§4 权限模式)。

## 6. 日志敏感信息处理(已确认)

两层脱敏(`core/logger.ts`):
- `sanitizeLogsForDoctor`(`:478-507`,/doctor 输出用):ID 类字段(chatId/openId/messageId 等)只留尾 6 字符;凭据字段(secret/token/authorization 族)全 `[REDACTED]`;**prompt/stdout/stderr/env/path/cwd 等字段整体抹除**;再过 `redactDiagnosticText`。
- `redactDiagnosticText`(`:507-530`):兜底正则——Bearer/`access_token=…`/`file_token=…` 等键值对、**一切绝对路径**(Unix/`~/`/Windows 盘符)→ `[REDACTED_PATH]`、飞书资源 key(file_v2_…)与引用语法 → `[REDACTED_RESOURCE]`。
- 常规运行日志不做脱敏(落在用户本机 0600 目录,供 grep 诊断);只有离开机器的通道(doctor 回显、错误文案)走脱敏。
- 日志保留期 `LARK_CHANNEL_LOG_DAYS` 可调,启动时 `gcOldLogs`。

## 7. 异常信息如何返回用户(已确认)

原则:**用户可见的错误只给"发生了什么+下一步",不给内部细节**:
- run 前置拒绝:`rejectReason.userVisible` 中文文案(markdown 直接回消息,`channel.ts:808`);
- agent 失败:卡片上 `⚠️ agent 失败:<error.message>`(`run-renderer.ts:79-80`)——PTY 退出会附 ANSI 剥离后的 TUI 尾巴(供诊断,但已剥控制序列);
- 挂死/超时:固定中文文案"本轮处理超时…可直接重发消息重试"(`pty-session.ts:422-433`);
- 诊断命令 `/doctor` 输出走 §6 脱敏;
- 沉默策略:未授权消息**不回任何错误**(防探测);markdown 流失败降级为一次性发送而非报错。

## 8. 卡片回调防伪造(已确认)

`CallbackAuth`(`card/callback-auth.ts:64+`):HMAC 签名密钥=**App Secret 本身**(只有 bridge 和飞书 app 知道);载荷 `{runId, scope, chatId, operatorOpenId, action, policyFingerprint, exp}`;24h TTL;nonce 单次防重放(`CallbackNonceStore` 持久化)。验证时同时核对 operator(点击者必须是发起人身份链内)与 policyFingerprint(策略变了旧按钮失效)。agent 自绘按钮(`__bridge_cb`)同样走签名(`dispatcher.ts:179+`)。

## 9. 其他防线(已确认)

- 进程单飞:profile 锁 + app 锁(proper-lockfile);同 app 第二实例启动时交互处置;
- 消息级:SDK messageId 去重 + stale 窗口(见 flows/message-to-agent.md 阶段 1);
- `postinstall` 修正 node-pty spawn-helper 权限(`package.json:41`);
- bridge 与 agent 的信任边界:系统提示明令 agent 不得 unset `LARK_CHANNEL*` 绕过 profile 隔离、不得直读 config.json 密钥(`channel.ts:83-88` + `bridge-system-prompt.ts`)——**这是提示层约束,非硬隔离**,真正的硬边界是 lark-cli 自身的 keychain 与身份策略。

## 10. 测试覆盖

`tests/integration/bot/access-gate.test.ts`、`claude-security.test.ts`(权限注入)、`tests/unit/policy/access.test.ts`、`tests/integration/policy/owner-refresh.test.ts`、`tests/unit/core/logger-redaction.test.ts`、`tests/integration/commands/doctor-redaction.test.ts`、`tests/unit/card/callback-auth.test.ts`、`tests/unit/config/schema.test.ts`、`profile-store.test.ts`、`tests/integration/cli/secrets-profile.test.ts`、`tests/unit/platform/secrets-getter.test.ts`。

## 11. 待验证问题

1. `keystore.ts` 120 行后的 setSecret/getSecret/删除接口与 keystore 与 `/account` 的交互细节。
2. `withConfigFileLock` 的锁粒度(写整个 config.json 期间读是否阻塞)。
3. ~~`/config` 表单完整项集~~(2026-10-24 交叉验证:9 个设置项——message_reply / tool_call_display / tool_call_display_in_groups / max_concurrent_runs / run_idle_timeout_minutes / require_mention_in_group / reply_in_thread_in_group / claude_driver / lark_cli_identity,`src/card/config-card.ts:109-286`;access/invite 类不在表单,走 `/invite` 与直接改配置)。
4. 卡片回调 operator 校验的具体规则(仅发起人?还是 ACL 层即可)——dispatcher 验签部分读了主干,operator 字段比对细节未逐行。
