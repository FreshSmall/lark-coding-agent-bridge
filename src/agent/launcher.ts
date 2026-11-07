import type { AgentLauncherConfig } from '../config/profile-schema';

export type LauncherEnv = Record<string, string | undefined>;

export interface LaunchSpec<E extends LauncherEnv = LauncherEnv> {
  file: string;
  args: string[];
  env: E;
}

/**
 * Env vars seedx reads to decide it is already inside an agent session; when
 * any is set, `seedx claude|codex` prints a notice and exits 0 without
 * launching anything. A bridge started from a Claude Code terminal inherits
 * CLAUDE_CODE_CHILD_SESSION=1, so they must not reach seedx.
 */
const SEEDX_AGENT_HOST_MARKERS = [
  'SEEDX_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_SESSION',
  'CODEX_THREAD_ID',
  'CODEX_SANDBOX',
  'AGENT',
];

export function launcherBinary(launcher: AgentLauncherConfig): string {
  return launcher.binaryPath ?? 'seedx';
}

/**
 * Rewrite a direct `claude|codex <args>` launch into
 * `seedx <agent> --permission-mode limited -- <args>`.
 *
 * seedx injects the gateway proxy plus its own permission flags *before* the
 * passthrough args; the bridge's own `--permission-mode` / `exec --sandbox`
 * come later and win, so the `limited` tier never widens what the bridge set.
 * seedx picks the underlying claude/codex binary itself.
 */
export function applyLauncher<E extends LauncherEnv>(
  launcher: AgentLauncherConfig | undefined,
  agent: 'claude' | 'codex',
  spec: LaunchSpec<E>,
): LaunchSpec<E> {
  if (!launcher) return spec;
  const env = { ...spec.env };
  for (const key of SEEDX_AGENT_HOST_MARKERS) delete env[key];
  return {
    file: launcherBinary(launcher),
    args: [agent, '--permission-mode', 'limited', '--', ...spec.args],
    env,
  };
}
