/**
 * Per-harness MCP capability contract.
 *
 * This module EXTENDS `src/lowerer-capabilities.ts` (the canonical harness
 * registry) rather than duplicating it: lowerer-capabilities answers "which
 * Prism compile surfaces exist per harness"; this contract answers the
 * MCP-specific questions the shim-consolidation lanes need — how a harness
 * attaches MCP servers, whether/where it can allowlist tools, whether tools
 * can be assigned to sub-agents, and what permission surface exists. The
 * `configSurface` on every supported contract is *derived* from
 * `LOWERER_CAPABILITIES[..].surfaces.mcpConfig`, not re-listed.
 *
 * Disjoint-union design (the "no emulation" law): a harness either supports
 * the ESSENTIAL feature set or it does not. Essential =
 *   { mcp-servers-reachable, stdio-command-spawn }.
 * A harness missing any essential feature is a `mcpSupport: "unsupported"`
 * contract that carries NO capability fields at all — so downstream code
 * cannot even type-check an attempt to render an allowlist entry or attach
 * a server for it. Optional features are declared per-harness and the
 * `optional` list is DERIVED from the field values by the constructor, so
 * the list can never drift from the fields.
 *
 * Evidence discipline: every non-obvious field value cites its grounding in
 * a comment — a live verification, a lowerer/golden-fixture read, or the
 * wire-naming record (`packages/prism-sdk/src/mcp/wire-naming.ts`) that the
 * shim lanes already validated.
 */

import type { HarnessId } from "./types.js";
import {
  LOWERER_CAPABILITIES,
  type LowererSurfaceCapability,
} from "./lowerer-capabilities.js";

// ---------------------------------------------------------------------------
// Field vocabularies
// ---------------------------------------------------------------------------

/**
 * How the harness attaches MCP servers to a session:
 * - `single-global-config`  — one global config file holds a server map
 *   (`config.toml#mcp_servers`, `config.yaml#mcp_servers`, `mcp.json`,
 *   `opencode.json#mcp`, settings `amp.mcpServers`).
 * - `per-plugin-config-entries` — the global config file takes distinct
 *   entries per plugin (multiple compiler-owned server keys in one map).
 * - `per-plugin-manifest`   — servers are declared by a per-plugin manifest
 *   or plugin directory only; there is no usable global server map for
 *   Prism-managed servers (kimi-code `kimi.plugin.json#mcpServers`,
 *   factory-droid plugin `mcp.json`).
 * - `plugin-bundle-file`    — servers are declared by a config file shipped
 *   inside a plugin bundle (`<plugin>/.mcp.json`, `<plugin>/mcp_config.json`).
 */
export type McpServersShape =
  | "single-global-config"
  | "per-plugin-config-entries"
  | "per-plugin-manifest"
  | "plugin-bundle-file";

/**
 * Whether and how the harness can allowlist individual MCP tools in the
 * server-attachment config:
 * - `within-server`    — the allowlist field lives inside the server's own
 *   config entry, entries are bare wire names (codex `enabled_tools`,
 *   hermes `tools.include`, kimi `enabledTools`).
 * - `global-prefixed`  — one flat allowlist namespace across all servers,
 *   entries carry the server key (claude `mcp__<server>__<tool>`).
 * - `unsupported`      — no per-tool allowlist exists at the server config
 *   level (grok, verified live; cursor).
 */
export type ToolAllowlistSupport = "within-server" | "global-prefixed" | "unsupported";

/** Whether MCP tools can be assigned/restricted per sub-agent definition. */
export type SubAgentToolAssignmentSupport = "supported" | "unsupported";

/**
 * Per-invocation permission surface for MCP tool calls:
 * - `supported`     — the harness can prompt/decide per invocation
 *   (claude permission rules + ask; opencode `permission` with `ask`).
 * - `config-scoped` — approval behavior exists but only as a static config
 *   policy, not per-tool-invocation (codex `approval_policy`).
 * - `unsupported`   — no permission surface for MCP tool calls.
 */
export type PerInvocationPermissionSupport = "supported" | "config-scoped" | "unsupported";

// ---------------------------------------------------------------------------
// Essential / optional feature split
// ---------------------------------------------------------------------------

/**
 * The essential feature set. A harness that cannot (a) reach configured MCP
 * servers from a session and (b) spawn a stdio server command is not an MCP
 * target at all — it is marked `unsupported`, never emulated.
 */
export const MCP_ESSENTIAL_FEATURES = [
  "mcp servers reachable",
  "stdio command spawn",
] as const;
export type McpEssentialFeature = (typeof MCP_ESSENTIAL_FEATURES)[number];

export const MCP_OPTIONAL_FEATURES = [
  "tool allowlist",
  "sub agent tool assignment",
  "per invocation permissions",
] as const;
export type McpOptionalFeature = (typeof MCP_OPTIONAL_FEATURES)[number];

// ---------------------------------------------------------------------------
// The disjoint union
// ---------------------------------------------------------------------------

export interface SupportedHarnessMcpContract {
  readonly harness: HarnessId;
  readonly mcpSupport: "supported";
  /** Always the full essential set — anything less is the unsupported arm. */
  readonly essential: readonly McpEssentialFeature[];
  /** Derived from the capability fields below; never hand-listed. */
  readonly optional: readonly McpOptionalFeature[];
  readonly mcpServersShape: McpServersShape;
  readonly toolAllowlist: ToolAllowlistSupport;
  readonly subAgentToolAssignment: SubAgentToolAssignmentSupport;
  readonly perInvocationPermissions: PerInvocationPermissionSupport;
  /** The Prism-managed config surface, derived from LOWERER_CAPABILITIES. */
  readonly configSurface: LowererSurfaceCapability;
  readonly notes?: readonly string[];
}

export interface UnsupportedHarnessMcpContract {
  readonly harness: HarnessId;
  readonly mcpSupport: "unsupported";
  /** Non-empty by construction — the reason this arm exists. */
  readonly missingEssential: readonly [McpEssentialFeature, ...McpEssentialFeature[]];
  readonly notes?: readonly string[];
}

export type HarnessMcpContract = SupportedHarnessMcpContract | UnsupportedHarnessMcpContract;

// ---------------------------------------------------------------------------
// Constructors — derive the feature lists so they cannot drift
// ---------------------------------------------------------------------------

interface SupportedContractInput {
  readonly harness: HarnessId;
  readonly mcpServersShape: McpServersShape;
  readonly toolAllowlist: ToolAllowlistSupport;
  readonly subAgentToolAssignment: SubAgentToolAssignmentSupport;
  readonly perInvocationPermissions: PerInvocationPermissionSupport;
  readonly notes?: readonly string[];
}

const supported = (input: SupportedContractInput): SupportedHarnessMcpContract => {
  const optional: McpOptionalFeature[] = [];
  if (input.toolAllowlist !== "unsupported") optional.push("tool allowlist");
  if (input.subAgentToolAssignment === "supported") optional.push("sub agent tool assignment");
  if (input.perInvocationPermissions !== "unsupported") optional.push("per invocation permissions");
  return {
    ...input,
    mcpSupport: "supported",
    essential: MCP_ESSENTIAL_FEATURES,
    optional,
    configSurface: LOWERER_CAPABILITIES[input.harness].surfaces.mcpConfig,
  };
};

const unsupportedContract = (
  harness: HarnessId,
  missingEssential: readonly [McpEssentialFeature, ...McpEssentialFeature[]],
  notes?: readonly string[],
): UnsupportedHarnessMcpContract => ({ harness, mcpSupport: "unsupported", missingEssential, notes });

// ---------------------------------------------------------------------------
// The contract table — all 12 harnesses
// ---------------------------------------------------------------------------

export const HARNESS_MCP_CONTRACTS = {
  "claude-code": supported({
    harness: "claude-code",
    // Evidence: generated plugin bundles ship `<plugin>/.mcp.json`
    // (LOWERER_CAPABILITIES["claude-code"].surfaces.mcpConfig).
    mcpServersShape: "plugin-bundle-file",
    // Evidence: `mcp__<server>__<tool>` flat namespace in permissions and
    // agent `tools:` frontmatter (wire-naming HARNESS_WIRE_CONFIG,
    // globalPrefix "mcp__"; harness docs).
    toolAllowlist: "global-prefixed",
    // Evidence: subagent markdown `tools:` frontmatter accepts
    // mcp__-prefixed tool names (claude-code lowerer output).
    subAgentToolAssignment: "supported",
    // Evidence: settings permissions allow/deny/ask rules apply per tool
    // invocation, including MCP tools.
    perInvocationPermissions: "supported",
  }),
  opencode: supported({
    harness: "opencode",
    // Evidence: opencode.json holds one global `mcp` server map. Fullest
    // MCP surface of the 12: tools, permissions, per-agent assignment.
    mcpServersShape: "single-global-config",
    // Evidence: agent/global `tools` map keys match MCP tool names
    // prefixed by their server key (flat namespace across servers).
    toolAllowlist: "global-prefixed",
    // Evidence: per-agent `tools` maps in opencode.json / agent frontmatter.
    subAgentToolAssignment: "supported",
    // Evidence: `permission` config supports ask/allow/deny per tool.
    perInvocationPermissions: "supported",
  }),
  // OpenClaw remains Prism skills-only (LOWERER_CAPABILITIES.openclaw: every
  // MCP-adjacent surface unsupported); no verified MCP server surface exists.
  openclaw: unsupportedContract("openclaw", ["mcp servers reachable", "stdio command spawn"], [
    "OpenClaw is skills-only for Prism; no MCP config surface is managed or verified.",
  ]),
  hermes: supported({
    harness: "hermes",
    // Evidence: `config.yaml#mcp_servers` global map
    // (LOWERER_CAPABILITIES.hermes.surfaces.mcpConfig).
    mcpServersShape: "single-global-config",
    // Evidence: `tools.include` exists inside a server's own entry
    // (wire-naming HARNESS_WIRE_CONFIG: hermes within-server).
    toolAllowlist: "within-server",
    // Evidence: Hermes compiled agents are intentionally fail-closed
    // (LOWERER_CAPABILITIES.hermes.surfaces.agents) — no per-agent tool map.
    subAgentToolAssignment: "unsupported",
    perInvocationPermissions: "unsupported",
  }),
  "codex-cli": supported({
    harness: "codex-cli",
    // Evidence: `config.toml#mcp_servers` global table
    // (LOWERER_CAPABILITIES["codex-cli"].surfaces.mcpConfig).
    mcpServersShape: "single-global-config",
    // Evidence: `enabled_tools` inside the server's own config table
    // (wire-naming HARNESS_WIRE_CONFIG: codex-cli within-server).
    toolAllowlist: "within-server",
    // Evidence: Codex agent TOML files carry no verified per-agent MCP tool
    // assignment surface; not claimed until grounded.
    subAgentToolAssignment: "unsupported",
    // Evidence: `approval_policy` / sandbox are static config policy, not a
    // per-tool-invocation gate.
    perInvocationPermissions: "config-scoped",
  }),
  "antigravity-cli": supported({
    harness: "antigravity-cli",
    // Evidence: generated plugin bundles ship `<plugin>/mcp_config.json`
    // (LOWERER_CAPABILITIES["antigravity-cli"].surfaces.mcpConfig).
    mcpServersShape: "plugin-bundle-file",
    // Evidence: per-agent `tools:` frontmatter is a flat cross-server
    // namespace with a single-underscore `mcp_<server>_<tool>` convention
    // (confirmed by pre-shim lowerer + golden fixture; wire-naming comment).
    toolAllowlist: "global-prefixed",
    subAgentToolAssignment: "supported",
    perInvocationPermissions: "unsupported",
  }),
  "kimi-code": supported({
    harness: "kimi-code",
    // Evidence: servers attach ONLY via the per-plugin manifest
    // `kimi.plugin.json#mcpServers` + installed.json registration
    // (LOWERER_CAPABILITIES["kimi-code"].surfaces.mcpConfig).
    mcpServersShape: "per-plugin-manifest",
    // Evidence: `enabledTools` filter inside the server entry takes bare
    // wire names (wire-naming HARNESS_WIRE_CONFIG: kimi-code within-server;
    // the Kimi fix — never the cosmetic display string).
    toolAllowlist: "within-server",
    // Evidence: Kimi subagents are runtime dispatches, not custom agent
    // files (LOWERER_CAPABILITIES["kimi-code"].notes).
    subAgentToolAssignment: "unsupported",
    perInvocationPermissions: "unsupported",
  }),
  "amp-code": supported({
    harness: "amp-code",
    // Evidence: Amp settings hold a single global `amp.mcpServers` map;
    // Prism-generated tools bypass it via plugin APIs
    // (LOWERER_CAPABILITIES["amp-code"].surfaces.mcpConfig unsupported for
    // Prism management, but the harness surface itself exists).
    mcpServersShape: "single-global-config",
    // No verified per-tool allowlist field in amp.mcpServers entries.
    toolAllowlist: "unsupported",
    subAgentToolAssignment: "unsupported",
    perInvocationPermissions: "unsupported",
  }),
  cursor: supported({
    harness: "cursor",
    // Evidence: `mcp.json#mcpServers` shared by IDE and CLI
    // (LOWERER_CAPABILITIES.cursor.surfaces.mcpConfig + notes).
    mcpServersShape: "single-global-config",
    // Evidence: Cursor carries no per-tool allowlist at all — a single
    // `mcpServers.<key>` entry, no enabledTools/tools array (wire-naming
    // HARNESS_WIRE_CONFIG comment on cursor).
    toolAllowlist: "unsupported",
    subAgentToolAssignment: "unsupported",
    perInvocationPermissions: "unsupported",
  }),
  "factory-droid": supported({
    harness: "factory-droid",
    // Evidence: servers attach via the plugin directory's own `mcp.json`
    // only; Prism does not patch settings.json
    // (LOWERER_CAPABILITIES["factory-droid"].surfaces.mcpConfig).
    mcpServersShape: "per-plugin-manifest",
    // Evidence: per-agent (droid) `tools:` frontmatter is a flat
    // cross-server `mcp__<server>__<tool>` namespace (confirmed by pre-shim
    // lowerer + golden fixture; wire-naming HARNESS_WIRE_CONFIG).
    toolAllowlist: "global-prefixed",
    subAgentToolAssignment: "supported",
    perInvocationPermissions: "unsupported",
  }),
  // Pi tools lower through the extension registerTool API; no MCP server
  // config surface is managed or verified for Pi
  // (LOWERER_CAPABILITIES.pi.surfaces.mcpConfig: unsupported).
  pi: unsupportedContract("pi", ["mcp servers reachable"], [
    "Pi canonical tools use the native extension API; no verified MCP server surface.",
  ]),
  grok: supported({
    harness: "grok",
    // Evidence: `config.toml#mcp_servers` managed stdio-shim region; grok
    // does not resolve plugin-bundle .mcp.json files
    // (LOWERER_CAPABILITIES.grok.surfaces.mcpConfig).
    mcpServersShape: "single-global-config",
    // Evidence: VERIFIED LIVE — grok has NO per-tool allowlist field in
    // `mcp_servers` entries. Agent frontmatter renders `<server>__<tool>`
    // names (wire-naming: grok global-prefixed, empty prefix, 64-char cap),
    // but that is sub-agent assignment, not a server-config allowlist.
    toolAllowlist: "unsupported",
    // Evidence: generated plugin agents carry `tools:` frontmatter with
    // capped `<server>__<tool>` names (wire-naming grok capBudget).
    subAgentToolAssignment: "supported",
    perInvocationPermissions: "unsupported",
  }),
} as const satisfies Record<HarnessId, HarnessMcpContract>;

// ---------------------------------------------------------------------------
// Accessors & narrowing helpers — features type-check against capabilities
// ---------------------------------------------------------------------------

export const getHarnessMcpContract = (harness: HarnessId): HarnessMcpContract =>
  HARNESS_MCP_CONTRACTS[harness];

export const isMcpSupported = (
  contract: HarnessMcpContract,
): contract is SupportedHarnessMcpContract => contract.mcpSupport === "supported";

/** Narrow to contracts on which rendering an allowlist entry is legal. */
export const hasToolAllowlist = (
  contract: HarnessMcpContract,
): contract is SupportedHarnessMcpContract & {
  readonly toolAllowlist: Exclude<ToolAllowlistSupport, "unsupported">;
} => contract.mcpSupport === "supported" && contract.toolAllowlist !== "unsupported";

/** Narrow to contracts on which per-sub-agent tool assignment is legal. */
export const hasSubAgentToolAssignment = (
  contract: HarnessMcpContract,
): contract is SupportedHarnessMcpContract & {
  readonly subAgentToolAssignment: "supported";
} => contract.mcpSupport === "supported" && contract.subAgentToolAssignment === "supported";

/** Harness ids whose contract is the supported arm, in table order. */
export const mcpSupportedHarnessIds = (): readonly HarnessId[] =>
  (Object.values(HARNESS_MCP_CONTRACTS) as readonly HarnessMcpContract[])
    .filter(isMcpSupported)
    .map((contract) => contract.harness);
