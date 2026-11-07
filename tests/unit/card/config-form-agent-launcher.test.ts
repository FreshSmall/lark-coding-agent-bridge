import { describe, expect, it } from 'vitest';
import { configFormCard, configSavedCard } from '../../../src/card/config-card';

type Select = { name?: string; initial_option?: string; options?: Array<{ value: string }> };

function launcherSelect(card: object): Select {
  const body = (card as { body: { elements: Array<{ tag: string; elements?: Select[] }> } }).body;
  const form = body.elements.find((e) => e.tag === 'form');
  const sel = form?.elements?.find((e) => e.name === 'agent_launcher');
  if (!sel) throw new Error('agent_launcher select not found');
  return sel;
}

const base: Parameters<typeof configFormCard>[0] = {
  messageReply: 'markdown',
  toolCallDisplay: 'compact',
  toolCallDisplayInGroups: 'inherit',
  maxConcurrentRuns: 10,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: true,
  replyInThreadInGroup: true,
  claudeDriver: 'pty',
  agentLauncher: 'direct',
  larkCliIdentity: 'bot-only',
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('config card model channel (agent_launcher)', () => {
  it('offers direct and seedx, preselecting the current value', () => {
    const sel = launcherSelect(configFormCard(base));
    expect(sel.options?.map((o) => o.value)).toEqual(['direct', 'seedx']);
    expect(sel.initial_option).toBe('direct');
    expect(launcherSelect(configFormCard({ ...base, agentLauncher: 'seedx' })).initial_option).toBe('seedx');
  });

  it('shows the saved channel on the result card', () => {
    expect(JSON.stringify(configSavedCard({ ...base, agentLauncher: 'seedx' }))).toContain('seedx(公司 AI 网关)');
    expect(JSON.stringify(configSavedCard(base))).toContain('**模型通道**:`直连`');
  });
});
