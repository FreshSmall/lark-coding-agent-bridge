import { describe, expect, it } from 'vitest';
import { buildPlist } from '../../../src/daemon/launchd';
import { buildLauncherCmd } from '../../../src/daemon/schtasks';
import { buildUnit } from '../../../src/daemon/systemd';

const base = {
  nodePath: '/usr/local/bin/node',
  bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
  envPath: '/usr/local/bin:/usr/bin',
  profile: 'claude',
  channelHome: '/tmp/lark-channel-home',
};

describe('daemon service files carry configured extra env', () => {
  it('renders extra env into the launchd plist', () => {
    const plist = buildPlist({
      ...base,
      env: { ANTHROPIC_MODEL: 'claude-opus-5[1m]', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' },
    });
    expect(plist).toContain('<key>ANTHROPIC_MODEL</key>\n        <string>claude-opus-5[1m]</string>');
    expect(plist).toContain('<key>CLAUDE_CODE_AUTO_COMPACT_WINDOW</key>\n        <string>500000</string>');
    // The built-ins must survive alongside it.
    expect(plist).toContain('<key>LARK_CHANNEL_HOME</key>');
    expect(plist).toContain('<key>PATH</key>');
  });

  it('escapes XML-significant characters in extra env values', () => {
    expect(buildPlist({ ...base, env: { WEIRD: 'a&b<c>"d"' } }))
      .toContain('<key>WEIRD</key>\n        <string>a&amp;b&lt;c&gt;&quot;d&quot;</string>');
  });

  it('never lets extra env override the built-in daemon vars', () => {
    const plist = buildPlist({
      ...base,
      env: { LARK_CHANNEL_HOME: '/hijacked', PATH: '/hijacked' },
    });
    expect(plist).toContain('<string>/tmp/lark-channel-home</string>');
    expect(plist).not.toContain('/hijacked');
  });

  it('renders extra env into the systemd unit', () => {
    expect(buildUnit({ ...base, env: { ANTHROPIC_MODEL: 'claude-opus-5[1m]' } }))
      .toContain('Environment="ANTHROPIC_MODEL=claude-opus-5[1m]"');
  });

  it('renders extra env into the windows launcher script', () => {
    expect(buildLauncherCmd({ ...base, env: { ANTHROPIC_MODEL: 'claude-opus-5[1m]' } }))
      .toContain('set "ANTHROPIC_MODEL=claude-opus-5[1m]"');
  });

  it('leaves the service files unchanged when no extra env is configured', () => {
    expect(buildPlist(base)).toBe(buildPlist({ ...base, env: {} }));
    expect(buildUnit(base)).toBe(buildUnit({ ...base, env: {} }));
    expect(buildLauncherCmd(base)).toBe(buildLauncherCmd({ ...base, env: {} }));
  });
});
