import type { KnownChat } from '../bot/lark-info';
import type { LarkCliIdentityPreset } from '../config/profile-schema';
import type { MessageReplyMode, ToolCallDisplay } from '../config/schema';

export interface ConfigFormOpts {
  messageReply: MessageReplyMode;
  /** Base tool-call display mode (applies to p2p and to groups when no group override is set). */
  toolCallDisplay: ToolCallDisplay;
  /** Group-specific override. `'inherit'` means "use the base value". */
  toolCallDisplayInGroups: ToolCallDisplay | 'inherit';
  maxConcurrentRuns: number;
  /** 0 means "disabled". */
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  replyInThreadInGroup: boolean;
  /** claude 驱动方式。默认 'pty'。 */
  claudeDriver: 'pty' | 'headless';
  /** 模型通道:直连本机 claude/codex,或经 seedx 走公司 AI 网关。 */
  agentLauncher: 'direct' | 'seedx';
  larkCliIdentity: LarkCliIdentityPreset;
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  knownChats: KnownChat[];
}

function collapsedAccessPanel(title: string, elements: object[]): object {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: title },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements,
  };
}

function atMentionLine(openIds: string[]): string {
  if (openIds.length === 0) return '_（暂无）_';
  return openIds.map((id) => `<at id="${id}"></at>`).join('  ');
}

function chatList(chatIds: string[], knownChats: KnownChat[]): string {
  if (chatIds.length === 0) return '_（暂无）_';
  const nameMap = new Map(knownChats.map((chat) => [chat.id, chat.name]));
  return chatIds
    .map((id) => `- **${nameMap.get(id) ?? '(未知群)'}**（...${id.slice(-6)}）`)
    .join('\n');
}

/** Form card for `/config`. */
export function configFormCard(opts: ConfigFormOpts): object {
  const accessElements: object[] = [
    {
      tag: 'markdown',
      content: '_控制谁能通过私聊和群聊使用 bot。**留空 = 不响应聊天消息**。云文档评论按文档权限生效。_',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**允许私聊的用户**（共 ${opts.allowedUsers.length} 人）\n` +
        `${atMentionLine(opts.allowedUsers)}\n\n` +
        '_加 / 删：_ `/invite user @某人`  `/remove user @某人`',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**允许响应的群**（共 ${opts.allowedChats.length} 个）\n` +
        `${chatList(opts.allowedChats, opts.knownChats)}\n\n` +
        '_一键加全部 bot 所在的群：_ `/invite all group`\n' +
        '_加 / 删（在目标群里发）：_ `/invite group`  `/remove group`',
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content:
        `**管理员**（共 ${opts.admins.length} 人）\n` +
        `${atMentionLine(opts.admins)}\n\n` +
        '_可以跑敏感命令：`/account` `/config` `/exit` `/reconnect` `/doctor` `/cd` `/ws` `/invite` `/remove`。管理员也自动获得私聊权限，并可在未白名单群里管理访问控制。_\n\n' +
        '_加 / 删：_ `/invite admin @某人`  `/remove admin @某人`',
    },
  ];

  return {
    schema: '2.0',
    config: { summary: { content: '偏好设置' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚙️ **偏好设置**\n\n' +
            '调整 bot 的行为偏好。改完点提交后写入当前 profile 配置；消息和访问控制设置立即生效。',
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'config_form',
          elements: [
            {
              tag: 'markdown',
              content:
                '**消息回复方式**\n' +
                '_纯文本:agent 跑完一次性发出,不流式,体感最轻_\n' +
                '_消息卡片:轻量流式 markdown 卡片,飞书原生打字机动画_\n' +
                '_交互卡片:实体卡片,运行时带停止按钮、完成后带 👍/👎 反馈,更新更可靠_',
            },
            {
              tag: 'select_static',
              name: 'message_reply',
              initial_option: opts.messageReply,
              options: [
                { text: { tag: 'plain_text', content: '纯文本' }, value: 'text' },
                { text: { tag: 'plain_text', content: '消息卡片(默认)' }, value: 'markdown' },
                { text: { tag: 'plain_text', content: '交互卡片' }, value: 'card' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**工具调用显示**\n' +
                '_紧凑(默认):只显示工具名和简短摘要,占用最少篇幅_\n' +
                '_完整:可展开查看每个工具的输入参数和输出_\n' +
                '_隐藏:跳过所有工具块,只保留 agent 的文字回复_',
            },
            {
              tag: 'select_static',
              name: 'tool_call_display',
              initial_option: opts.toolCallDisplay,
              options: [
                { text: { tag: 'plain_text', content: '紧凑(默认)' }, value: 'compact' },
                { text: { tag: 'plain_text', content: '完整' }, value: 'full' },
                { text: { tag: 'plain_text', content: '隐藏' }, value: 'hide' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**群里的工具调用显示**\n' +
                '_群和话题群里使用单独的显示模式;默认两边都「紧凑」,如想在私聊看完整参数可把上方改「完整」、这里保持「紧凑」_\n' +
                '_跟随上方:群内沿用「工具调用显示」的设置_',
            },
            {
              tag: 'select_static',
              name: 'tool_call_display_in_groups',
              initial_option: opts.toolCallDisplayInGroups,
              options: [
                { text: { tag: 'plain_text', content: '跟随上方(默认)' }, value: 'inherit' },
                { text: { tag: 'plain_text', content: '完整' }, value: 'full' },
                { text: { tag: 'plain_text', content: '紧凑' }, value: 'compact' },
                { text: { tag: 'plain_text', content: '隐藏' }, value: 'hide' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**并发上限**\n' +
                '_全局同时运行的 agent 进程数(主要影响话题群多话题并行场景)_\n' +
                '_默认 10,范围 1-50。超出的请求会 FIFO 排队_',
            },
            {
              tag: 'input',
              name: 'max_concurrent_runs',
              default_value: String(opts.maxConcurrentRuns),
              placeholder: { tag: 'plain_text', content: '10' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**run 探活(分钟)**\n' +
                '_agent 长时间没输出时自动 kill,防止假死_\n' +
                '_0 = 关闭(默认),范围 1-120。可被 `/timeout` 在单个 scope 覆盖_',
            },
            {
              tag: 'input',
              name: 'run_idle_timeout_minutes',
              default_value: String(opts.runIdleTimeoutMinutes),
              placeholder: { tag: 'plain_text', content: '0' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**群里需要 @ bot**\n' +
                '_是(默认):群和话题群里,不 @ bot 的消息不会触发回复,bot 不接群里聊天_\n' +
                '_否:任何消息都会发给 agent(0.1.21 及更早版本的行为)_\n' +
                '_私聊永远不需要 @;`@全员` 永远不响应_',
            },
            {
              tag: 'select_static',
              name: 'require_mention_in_group',
              initial_option: opts.requireMentionInGroup ? 'yes' : 'no',
              options: [
                { text: { tag: 'plain_text', content: '是(默认)' }, value: 'yes' },
                { text: { tag: 'plain_text', content: '否' }, value: 'no' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**群聊话题回复**\n' +
                '_是(默认):普通群里 bot 用「话题」回复每条消息,讨论更有条理_\n' +
                '_否:bot 直接引用回复,不开话题_\n' +
                '_话题群天生按话题组织,此项不影响它;私聊永远不开话题_',
            },
            {
              tag: 'select_static',
              name: 'reply_in_thread_in_group',
              initial_option: opts.replyInThreadInGroup ? 'yes' : 'no',
              options: [
                { text: { tag: 'plain_text', content: '是(默认)' }, value: 'yes' },
                { text: { tag: 'plain_text', content: '否' }, value: 'no' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**Claude 驱动方式**\n' +
                '_PTY(默认):伪终端常驻,支持交互式问答和长任务探活;需 node-pty_\n' +
                '_Headless:claude -p 无头模式,工具渲染更干净,一轮一进程_\n' +
                '_切换后会在当前任务结束后自动重连生效_',
            },
            {
              tag: 'select_static',
              name: 'claude_driver',
              initial_option: opts.claudeDriver,
              options: [
                { text: { tag: 'plain_text', content: 'PTY(默认)' }, value: 'pty' },
                { text: { tag: 'plain_text', content: 'Headless' }, value: 'headless' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**模型通道**\n' +
                '_直连(默认):直接调用本机 claude / codex_\n' +
                '_seedx:经 `seedx claude|codex` 走公司 AI 网关,需本机已 `seedx login`_\n' +
                '_切换后会在当前任务结束后自动重连生效_',
            },
            {
              tag: 'select_static',
              name: 'agent_launcher',
              initial_option: opts.agentLauncher,
              options: [
                { text: { tag: 'plain_text', content: '直连(默认)' }, value: 'direct' },
                { text: { tag: 'plain_text', content: 'seedx(公司 AI 网关)' }, value: 'seedx' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**lark-cli 身份策略**\n' +
                '_只允许应用身份:使用 bot/app 能力,不访问个人资源_\n' +
                '_允许用户身份:保留应用身份,并允许已授权用户访问个人日历、邮箱、云盘等资源_',
            },
            {
              tag: 'select_static',
              name: 'lark_cli_identity',
              initial_option: opts.larkCliIdentity,
              options: [
                { text: { tag: 'plain_text', content: '只允许应用身份' }, value: 'bot-only' },
                { text: { tag: 'plain_text', content: '允许用户身份' }, value: 'user-default' },
              ],
            },
            { tag: 'hr' },
            collapsedAccessPanel('🔒 **访问控制**（点击展开）', accessElements),
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: 'small',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'submit_btn',
                      text: { tag: 'plain_text', content: '提交' },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'config.submit' } }],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'cancel_btn',
                      text: { tag: 'plain_text', content: '取消' },
                      behaviors: [{ type: 'callback', value: { cmd: 'config.cancel' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

export function configSavedCard(opts: ConfigFormOpts): object {
  const replyLabel =
    opts.messageReply === 'card'
      ? '交互卡片'
      : opts.messageReply === 'markdown'
        ? '消息卡片'
        : '纯文本';
  const summarize = (list: string[]): string =>
    list.length === 0 ? '_(空)_' : `${list.length} 项`;
  const toolDisplayLabel = (v: ToolCallDisplay): string =>
    v === 'full' ? '完整' : v === 'compact' ? '紧凑' : '隐藏';
  const groupOverrideLabel =
    opts.toolCallDisplayInGroups === 'inherit'
      ? `跟随上方(${toolDisplayLabel(opts.toolCallDisplay)})`
      : toolDisplayLabel(opts.toolCallDisplayInGroups);
  return {
    schema: '2.0',
    config: { summary: { content: '偏好已保存' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **偏好已保存**\n\n' +
            `**消息回复方式**:${replyLabel}\n` +
            `**工具调用显示**:\`${toolDisplayLabel(opts.toolCallDisplay)}\`\n` +
            `**群里的工具调用显示**:\`${groupOverrideLabel}\`\n` +
            `**并发上限**:\`${opts.maxConcurrentRuns}\`\n` +
            `**run 探活**:\`${opts.runIdleTimeoutMinutes > 0 ? `${opts.runIdleTimeoutMinutes} 分钟` : '关闭'}\`\n` +
            `**群里需要 @ bot**:\`${opts.requireMentionInGroup ? '是' : '否'}\`\n` +
            `**群聊话题回复**:\`${opts.replyInThreadInGroup ? '是' : '否'}\`\n` +
            `**Claude 驱动**:\`${opts.claudeDriver === 'headless' ? 'Headless' : 'PTY'}\`\n` +
            `**模型通道**:\`${opts.agentLauncher === 'seedx' ? 'seedx(公司 AI 网关)' : '直连'}\`\n\n` +
            `**lark-cli 身份策略**:\`${opts.larkCliIdentity === 'user-default' ? '允许用户身份' : '只允许应用身份'}\`\n\n` +
            '🔒 **访问控制**\n' +
            `**允许私聊的用户**:${summarize(opts.allowedUsers)}\n` +
            `**允许响应的群**:${summarize(opts.allowedChats)}\n` +
            `**管理员**:${summarize(opts.admins)}\n\n` +
            '下条消息开始生效。',
        },
      ],
    },
  };
}

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消,未做任何修改。' }],
    },
  };
}

export function configFailedCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '保存失败' } },
    body: {
      elements: [{ tag: 'markdown', content: `保存失败：${reason}` }],
    },
  };
}
