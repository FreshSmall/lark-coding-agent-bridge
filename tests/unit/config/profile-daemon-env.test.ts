import { describe, expect, it } from 'vitest';
import { formatRootConfig } from '../../../src/config/profile-store';
import { normalizeProfileConfig } from '../../../src/config/profile-schema';

function raw(extra: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 2,
    agentKind: 'claude',
    accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
    ...extra,
  };
}

describe('profile daemonEnv', () => {
  it('keeps daemonEnv through normalization', () => {
    const cfg = normalizeProfileConfig(
      raw({ daemonEnv: { ANTHROPIC_MODEL: 'claude-opus-5[1m]', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } }),
    );
    expect(cfg.daemonEnv).toEqual({
      ANTHROPIC_MODEL: 'claude-opus-5[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000',
    });
  });

  it('drops non-string values instead of writing them into the service file', () => {
    const cfg = normalizeProfileConfig(raw({ daemonEnv: { OK: 'yes', BAD: 42, NOPE: null } }));
    expect(cfg.daemonEnv).toEqual({ OK: 'yes' });
  });

  it('omits daemonEnv entirely when absent', () => {
    expect(normalizeProfileConfig(raw())).not.toHaveProperty('daemonEnv');
  });

  it('survives a save/load round-trip', () => {
    // Two whitelists guard the config: normalize on read, serialize on write.
    // A field that only clears the first one gets silently dropped the next
    // time anything persists the config.
    const cfg = normalizeProfileConfig(raw({ daemonEnv: { ANTHROPIC_MODEL: 'opus[1m]' } }));
    const written = JSON.parse(
      formatRootConfig({
        schemaVersion: 2,
        activeProfile: 'claude',
        preferences: {},
        profiles: { claude: cfg },
      }),
    );
    expect(written.profiles.claude.daemonEnv).toEqual({ ANTHROPIC_MODEL: 'opus[1m]' });
  });
});
