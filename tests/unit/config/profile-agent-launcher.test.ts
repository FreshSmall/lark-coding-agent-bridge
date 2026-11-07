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

describe('profile agentLauncher', () => {
  it('omits agentLauncher when absent (direct launch)', () => {
    expect(normalizeProfileConfig(raw())).not.toHaveProperty('agentLauncher');
  });

  it('accepts seedx with and without a binary path', () => {
    expect(normalizeProfileConfig(raw({ agentLauncher: { kind: 'seedx' } })).agentLauncher)
      .toEqual({ kind: 'seedx' });
    expect(
      normalizeProfileConfig(raw({ agentLauncher: { kind: 'seedx', binaryPath: ' /opt/seedx  ' } })).agentLauncher,
    ).toEqual({ kind: 'seedx', binaryPath: '/opt/seedx' });
  });

  it('rejects unknown launcher kinds', () => {
    expect(() => normalizeProfileConfig(raw({ agentLauncher: { kind: 'other' } }))).toThrow(/agentLauncher/);
    expect(() => normalizeProfileConfig(raw({ agentLauncher: 'seedx' }))).toThrow(/agentLauncher/);
  });

  it('survives a save/load round-trip', () => {
    const cfg = normalizeProfileConfig(raw({ agentLauncher: { kind: 'seedx' } }));
    const written = JSON.parse(
      formatRootConfig({
        schemaVersion: 2,
        activeProfile: 'claude',
        preferences: {},
        profiles: { claude: cfg },
      }),
    );
    expect(written.profiles.claude.agentLauncher).toEqual({ kind: 'seedx' });
    expect(normalizeProfileConfig(written.profiles.claude).agentLauncher).toEqual({ kind: 'seedx' });
  });
});
