/**
 * Tool surface compile flags.
 *
 * Destination: agents invoke Prism tools via managed CLI (`prism tools invoke`)
 * plus an agent-facing inject mode — not via harness MCP stdio fan-out.
 *
 * Inject modes (PRISM_TOOLS_CLI_INJECT):
 *   - skill (default): install prism-tools-<plugin> skill + thin rules pointer
 *   - rules: full tool inventory as always-on rules (MCP-like discovery)
 *
 * Catalogs always land under PRISM_HOME for `prism tools list|invoke`.
 */

const truthy = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const falsy = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
};

/**
 * Emit CLI tool catalogs + skill docs under PRISM_HOME on compile.
 * Default: ON. Set PRISM_TOOLS_CLI_EMIT=0 to disable.
 */
export const toolsCliEmitEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  if (falsy(env.PRISM_TOOLS_CLI_EMIT)) return false;
  if (truthy(env.PRISM_TOOLS_CLI_EMIT)) return true;
  return true;
};

/**
 * How compiled tools appear in agent context (always-on rules / skills).
 * Default: skill. Set PRISM_TOOLS_CLI_INJECT=rules|skill.
 */
export type ToolsCliInjectMode = "rules" | "skill";

export const toolsCliInjectMode = (env: NodeJS.ProcessEnv = process.env): ToolsCliInjectMode => {
  const raw = env.PRISM_TOOLS_CLI_INJECT?.trim().toLowerCase();
  if (raw === "rules" || raw === "skill") return raw;
  return "skill";
};

/**
 * Emit harness MCP stdio-shim server entries.
 * Default: OFF — agents use `prism tools invoke` + inject surface; no per-session
 * stdio fan-out. Set PRISM_TOOLS_MCP_EMIT=1 to re-enable harness MCP config
 * (daemon bundles still write for CLI invoke either way).
 */
export const toolsMcpHarnessEmitEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  if (falsy(env.PRISM_TOOLS_MCP_EMIT)) return false;
  if (truthy(env.PRISM_TOOLS_MCP_EMIT)) return true;
  return false;
};
