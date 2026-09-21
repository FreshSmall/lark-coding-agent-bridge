import { describe, expect, it } from 'vitest';
import {
  getReplyInThreadInGroup,
  getThreadRootContext,
  getTurnSilenceTimeoutMs,
  getTurnMaxMs,
  getSessionRotateMaxBytes,
} from '../../../src/config/schema.js';
import type { AppConfig } from '../../../src/config/schema.js';

function cfgPrefs(preferences: Record<string, unknown>): AppConfig {
  return {
    accounts: { app: { id: 'a', secret: 's', tenant: 'feishu' } },
    preferences,
  } as AppConfig;
}

function cfgWith(replyInThreadInGroup: boolean | undefined): AppConfig {
  return {
    accounts: { app: { id: 'a', secret: 's', tenant: 'feishu' } },
    preferences: replyInThreadInGroup === undefined ? {} : { replyInThreadInGroup },
  } as AppConfig;
}

describe('getReplyInThreadInGroup', () => {
  it('defaults to true when unset', () => {
    expect(getReplyInThreadInGroup(cfgWith(undefined))).toBe(true);
  });

  it('returns false only when explicitly false', () => {
    expect(getReplyInThreadInGroup(cfgWith(false))).toBe(false);
  });

  it('returns true when explicitly true', () => {
    expect(getReplyInThreadInGroup(cfgWith(true))).toBe(true);
  });
});

describe('getThreadRootContext', () => {
  it('defaults to true when unset', () => {
    expect(getThreadRootContext(cfgPrefs({}))).toBe(true);
  });

  it('returns false only when explicitly false', () => {
    expect(getThreadRootContext(cfgPrefs({ threadRootContext: false }))).toBe(false);
  });

  it('returns true when explicitly true', () => {
    expect(getThreadRootContext(cfgPrefs({ threadRootContext: true }))).toBe(true);
  });
});

describe('getTurnSilenceTimeoutMs', () => {
  it('defaults to 15 minutes when unset', () => {
    expect(getTurnSilenceTimeoutMs(cfgPrefs({}))).toBe(15 * 60_000);
  });
  it('honors an explicit 0 (disabled)', () => {
    expect(getTurnSilenceTimeoutMs(cfgPrefs({ turnSilenceTimeoutMinutes: 0 }))).toBe(0);
  });
  it('clamps to [1, 120] minutes', () => {
    expect(getTurnSilenceTimeoutMs(cfgPrefs({ turnSilenceTimeoutMinutes: 999 }))).toBe(120 * 60_000);
    expect(getTurnSilenceTimeoutMs(cfgPrefs({ turnSilenceTimeoutMinutes: -5 }))).toBe(15 * 60_000);
    expect(getTurnSilenceTimeoutMs(cfgPrefs({ turnSilenceTimeoutMinutes: 3 }))).toBe(3 * 60_000);
  });
});

describe('getTurnMaxMs', () => {
  it('defaults to 0 (off) when unset', () => {
    expect(getTurnMaxMs(cfgPrefs({}))).toBe(0);
  });
  it('clamps a set value to [1, 720] minutes', () => {
    expect(getTurnMaxMs(cfgPrefs({ turnMaxMinutes: 30 }))).toBe(30 * 60_000);
    expect(getTurnMaxMs(cfgPrefs({ turnMaxMinutes: 99999 }))).toBe(720 * 60_000);
    expect(getTurnMaxMs(cfgPrefs({ turnMaxMinutes: 0 }))).toBe(0);
  });
});

describe('getSessionRotateMaxBytes', () => {
  it('defaults to ~2MB when unset', () => {
    expect(getSessionRotateMaxBytes(cfgPrefs({}))).toBe(2_000_000);
  });
  it('honors an explicit 0 (disabled)', () => {
    expect(getSessionRotateMaxBytes(cfgPrefs({ sessionRotateMaxBytes: 0 }))).toBe(0);
  });
  it('enforces a 512KB floor on tiny values', () => {
    expect(getSessionRotateMaxBytes(cfgPrefs({ sessionRotateMaxBytes: 1000 }))).toBe(512_000);
    expect(getSessionRotateMaxBytes(cfgPrefs({ sessionRotateMaxBytes: 10_000_000 }))).toBe(10_000_000);
  });
});
