import type { McpName } from '../config';
import { context7 } from './context7';
import { gh_grep } from './grep-app';
import type { McpConfig } from './types';

export type { LocalMcpConfig, McpConfig, RemoteMcpConfig } from './types';

const allBuiltinMcps: Record<McpName, McpConfig> = {
  context7,
  gh_grep,
};

/**
 * Creates MCP configurations, excluding disabled ones.
 */
export function createBuiltinMcps(
  disabledMcps: readonly string[] = [],
): Record<string, McpConfig> {
  // Never trust the declared type of user-config-derived values at
  // runtime; fall back to "nothing disabled" instead of throwing.
  const safeDisabledMcps = Array.isArray(disabledMcps) ? disabledMcps : [];
  return Object.fromEntries(
    Object.entries(allBuiltinMcps).filter(
      ([name]) => !safeDisabledMcps.includes(name),
    ),
  );
}
