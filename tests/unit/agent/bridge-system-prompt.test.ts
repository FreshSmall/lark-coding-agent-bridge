import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SYSTEM_PROMPT,
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';

describe('bridge system prompt bot collaboration rules', () => {
  it('states that bots only receive messages via a real structured mention', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('只有被真实 @');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('收不到');
  });

  it('scopes the mention requirement to bots, not human users', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('人类用户');
  });

  it('tells the agent not to mention other bots by default to avoid loops', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('默认不要 @ 其他 bot');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('死循环');
  });

  it('allows mentioning a bot when the user explicitly asks for a handoff', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('用户明确要求');
  });

  it('points self-identification at the bridge_context botOpenId field', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('botOpenId');
  });

  it('documents the senderType and mentions context fields', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('senderType');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('mentions');
  });

  it('tells the agent not to mimic the batch sender annotation format', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('[名字 (user|bot)]');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('不要模仿');
  });
});

describe('bridge system prompt thread_context rules', () => {
  it('documents the thread_context section and its host marker', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('thread_context');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('isHost');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('开启话题的消息');
  });

  it('explains that omitted means the agent is not seeing everything', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('omitted');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('你看到的不是全部');
  });

  it('tells the agent to admit it when the thread could not be read', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('读取失败');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('直说你没读到');
  });

  it('warns that the injection happens once, so it must not ask for a resend', () => {
    expect(BRIDGE_SYSTEM_PROMPT).toContain('该会话的第一轮');
    expect(BRIDGE_SYSTEM_PROMPT).toContain('不要反过来要求用户再发一遍');
  });
});

describe('buildBridgeSystemPrompt', () => {
  it('returns the base prompt unchanged when no identity is available', () => {
    expect(buildBridgeSystemPrompt(undefined)).toBe(BRIDGE_SYSTEM_PROMPT);
  });

  it('appends a concrete identity line with open_id and name', () => {
    const prompt = buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: '尼莫' });
    expect(prompt.startsWith(BRIDGE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('ou_bot_self');
    expect(prompt).toContain('尼莫');
  });

  it('appends the identity line even when the bot name is missing', () => {
    const prompt = buildBridgeSystemPrompt({ openId: 'ou_bot_self' });
    expect(prompt).toContain('ou_bot_self');
  });
});

describe('prefixBridgeSystemPrompt', () => {
  it('prefixes the identity-aware system prompt before the user message', () => {
    const prompt = prefixBridgeSystemPrompt('hello world', { openId: 'ou_bot_self' });
    expect(prompt).toContain('ou_bot_self');
    expect(prompt.indexOf('ou_bot_self')).toBeLessThan(prompt.indexOf('## user_message'));
    expect(prompt.endsWith('hello world')).toBe(true);
  });

  it('keeps working without an identity', () => {
    const prompt = prefixBridgeSystemPrompt('hello world', undefined);
    expect(prompt.startsWith(BRIDGE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt.endsWith('hello world')).toBe(true);
  });
});
