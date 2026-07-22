/**
 * Tool surface compile flags.
 *
 * Agents invoke Prism tools via managed CLI (`prism tools invoke`) plus an
 * agent-facing inject mode (skill or rules). There is no MCP path.
 *
 * Inject modes (PRISM_TOOLS_CLI_INJECT):
 *   - skill (default): install prism-tools-<plugin> skill + thin rules pointer
 *   - rules: full tool inventory as always-on rules
 *
 * Catalogs + runtime.mjs always land under PRISM_HOME for `prism tools list|invoke`.
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
 * MCP harness config emit is gone. Always false so residual lowerer call sites
 * compile until those blocks are deleted in the same excision train.
 */
export const toolsMcpHarnessEmitEnabled = (_env?: NodeJS.ProcessEnv): boolean => false;
