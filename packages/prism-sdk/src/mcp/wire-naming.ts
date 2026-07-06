/**
 * MCP wire-naming: the single canonical scheme for naming a plugin's tools
 * on the wire once N plugin daemons are aggregated behind one stdio shim
 * process per harness, and for rendering the per-harness allowlist entry
 * that gates which of those wire names a harness config actually exposes.
 *
 * Why this module exists (consolidation, not addition): before the
 * stdio-shim aggregator, each harness's HTTP-mode lowerer computed its own
 * `<server>__<tool>` (or `mcp__<server>__<tool>`) naming ad hoc, and the
 * shim aggregator (`shim.ts`) duplicated a bit of that logic locally
 * (`stableHash8`, `pluginWireNamespace`, `namespacedToolName`) because it
 * cannot import the root package's `src/compile/*` modules. Consolidating
 * to stdio-shim for every harness means every lowerer and the shim itself
 * now need the *same* aggregated naming scheme, so it is defined once here
 * — in `packages/prism-sdk`, which both the shim (same package) and the
 * root lowerers (via the `@skastr0/prism-sdk/mcp/wire-naming` package
 * export) can import — instead of re-derived per call site.
 *
 * The naming scheme, and why it fixes the two harness-specific breaks:
 *
 * - `canonicalBase(plugin, tool)` = `p_<fnv1a8(plugin)>_<tool>`, where
 *   `tool` is expected to already be the sanitized, underscore-collapsed
 *   per-plugin tool name the root package computes
 *   (`generatedToolNameForBinding`, already free of `__` and capped at 52
 *   chars). The namespace segment `p_<hash8>` is a fixed 10 characters,
 *   joined to `tool` by exactly one `_`. Because `tool` is guaranteed to
 *   contain no `__` and never starts or ends with `_`, `canonicalBase`
 *   *provably* contains zero `__` anywhere — that is what unblocks Grok's
 *   `<server>__<tool>` parser (Grok splits a fully-qualified MCP tool name
 *   on `__`, and previously the shim's own `p_<hash8>__<tool>` namespace
 *   separator collided with that split).
 * - `renderAllowlist` renders the exact string each harness's config
 *   embeds in its own allowlist field (`tools:` frontmatter, `enabled_tools`,
 *   `tools.include`, `enabledTools`, ...). Two shapes exist today:
 *   `within-server` (the allowlist is scoped inside that server's own config
 *   table, so the entry is the wire name alone — Codex CLI, Hermes, Kimi
 *   Code, and, pending harness-specific confirmation, Antigravity CLI,
 *   Cursor, and Factory Droid) and `global-prefixed` (the allowlist is a
 *   single flat namespace across every configured MCP server, so the entry
 *   must also carry the server key — Claude Code's `mcp__<server>__<tool>`,
 *   Grok's `<server>__<tool>`). This is the Kimi fix: Kimi's `enabledTools`
 *   filter is `within-server`, so it must be fed the bare wire name, never
 *   the cosmetic `qualifyKimiMcpToolName` display string.
 * - Grok additionally caps the *wire* name (before the server-key prefix is
 *   added) so the fully-qualified `<server>__<wire>` name stays within
 *   Grok's 64-char / `^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$` limit. The shim's own
 *   server key is deliberately the shortest legal one (`prism`, not
 *   `prism-mcp-shim`) to maximize the budget left for the wire name.
 */

import type { HarnessId } from "../compile-manifest.js";

// ---------------------------------------------------------------------------
// Hashing — the one copy. Bit-for-bit identical to the root package's
// `src/compile/stable-hash.ts` (and the shim's former local copy, retired in
// favor of importing this), so a plugin's namespace segment is the same
// value everywhere it is computed.
// ---------------------------------------------------------------------------

/** FNV-1a, 8 hex chars, lowercase, zero-padded. */
export const stableHash8 = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.codePointAt(index)!;
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

// ---------------------------------------------------------------------------
// canonicalBase — the one identity every harness's wire name derives from.
// ---------------------------------------------------------------------------

/** Fixed width of the namespace segment: literal `p_` (2) + 8 hex chars. */
export const CANONICAL_NAMESPACE_LENGTH = 2 + 8;

const CANONICAL_SEPARATOR = "_";

/** `p_<hash8>` — the per-plugin namespace segment, fixed-width and positionally splittable. */
export const canonicalNamespace = (pluginName: string): string => `p_${stableHash8(pluginName)}`;

/**
 * `p_<hash8>_<tool>` — the plugin-and-tool identity aggregated tool naming
 * derives from. `tool` must already be the sanitized, `_`-collapsed
 * per-plugin tool name (the root package's `generatedToolNameForBinding`,
 * or — when called from the shim — a daemon's already-namespaced
 * `tools/list` entry, which is that same value). This function does not
 * re-sanitize `tool`; it trusts the upstream contract that `tool` contains
 * no `__` and no leading/trailing `_`, which is what makes the result
 * provably `__`-free.
 */
export const canonicalBase = (pluginName: string, tool: string): string =>
  `${canonicalNamespace(pluginName)}${CANONICAL_SEPARATOR}${tool}`;

/**
 * Inverse of `canonicalBase` for the *uncapped* case: splits on the fixed
 * namespace width rather than searching for the separator, since `tool` is
 * free-form and may itself legally contain `_`. Returns `undefined` for any
 * string that is not shaped like a `canonicalBase` output (too short, or the
 * expected separator position holds something else) — including a
 * Grok-capped wire name, which is not string-invertible (its tail is a hash
 * of the *original* uncapped name, not a positional encoding of `tool`); a
 * capped name is recovered via the lookup table the caller built when it
 * rendered the name, not by parsing it back.
 */
export const parseCanonicalBase = (
  base: string,
): { readonly namespace: string; readonly tool: string } | undefined => {
  if (base.length <= CANONICAL_NAMESPACE_LENGTH + CANONICAL_SEPARATOR.length) return undefined;
  const namespace = base.slice(0, CANONICAL_NAMESPACE_LENGTH);
  const separator = base.slice(CANONICAL_NAMESPACE_LENGTH, CANONICAL_NAMESPACE_LENGTH + CANONICAL_SEPARATOR.length);
  if (separator !== CANONICAL_SEPARATOR) return undefined;
  const tool = base.slice(CANONICAL_NAMESPACE_LENGTH + CANONICAL_SEPARATOR.length);
  if (tool.length === 0) return undefined;
  return { namespace, tool };
};

// ---------------------------------------------------------------------------
// Grok capping — deterministic overflow policy plus a collision guard,
// moved here (from the former per-lowerer `capGrokToolName` /
// `createGrokToolNamer` pair in `src/compile/lowerers/grok.ts`) so the shim
// and the lowerer apply the byte-identical cap to the byte-identical input.
// ---------------------------------------------------------------------------

/**
 * A collision guard shared across every `capGrokWireName` call in one
 * render pass (one plugin's compiled tool set at lowerer build time, or one
 * shim `tools/list` merge at runtime). Two distinct full names truncating
 * to the same capped name is a real, if rare, failure mode (the truncation
 * suffix is an 8-hex-char hash of the *full* pre-cap name, not of the
 * dropped tail alone) — silent about it, a harness would just silently
 * serve one of the two tools. Guarded, it is a hard, deterministic error at
 * the point of collision instead.
 */
export interface GrokCollisionGuard {
  /** Throws if `capped` has already been produced by a different `source`. */
  readonly resolve: (source: string, capped: string) => void;
}

export const createGrokCollisionGuard = (): GrokCollisionGuard => {
  const seen = new Map<string, string>();
  return {
    resolve: (source, capped) => {
      const existing = seen.get(capped);
      if (existing !== undefined && existing !== source) {
        throw new Error(
          `Grok MCP wire name collision: '${existing}' and '${source}' both truncate to '${capped}'`,
        );
      }
      seen.set(capped, source);
    },
  };
};

/**
 * Truncates `name` to `budget` characters, appending a `_<hash8>` suffix
 * derived from the *full* pre-cap name so the result stays unique and
 * reproducible across compiles. Names already within budget are returned
 * byte-identical (regeneration must never rename a compliant tool).
 */
export const capGrokWireName = (name: string, budget: number, guard?: GrokCollisionGuard): string => {
  if (name.length <= budget) return name;
  const suffix = stableHash8(name);
  const prefixLength = budget - suffix.length - 1;
  const prefix = name.slice(0, prefixLength).replace(/_+$/g, "");
  const capped = `${prefix}_${suffix}`;
  guard?.resolve(name, capped);
  return capped;
};

// ---------------------------------------------------------------------------
// Per-harness record — the one place harness-specific wire shape lives. A
// new shim-transport harness is one entry here plus the two render calls in
// its lowerer's shim branch; nothing else in this module changes.
// ---------------------------------------------------------------------------

/**
 * The subset of `HarnessId` that fronts its MCP tools through the stdio
 * shim (see the design's transport table). `opencode`, `amp-code`, and
 * `pi` compile tool implementations directly into an in-process bundle —
 * no daemon, no shim, no wire naming — so they are excluded here rather
 * than given a meaningless record entry.
 */
export type ShimHarnessId = Exclude<HarnessId, "opencode" | "amp-code" | "pi">;

export const SHIM_HARNESS_IDS: ReadonlyArray<ShimHarnessId> = [
  "claude-code",
  "codex-cli",
  "hermes",
  "antigravity-cli",
  "cursor",
  "factory-droid",
  "kimi-code",
  "grok",
];

interface HarnessWireConfig {
  /** The MCP server key this harness's config registers the shim under. */
  readonly serverKey: string;
  /**
   * `within-server`: the allowlist field is already scoped inside this
   * server's own config table, so the rendered entry is the wire name
   * alone (Codex CLI's `enabled_tools`, Hermes's `tools.include`, Kimi
   * Code's `enabledTools`).
   *
   * `global-prefixed`: the allowlist is a single flat namespace across
   * every configured MCP server, so the entry also carries the server key
   * (Claude Code's `tools:` frontmatter, Grok's `tools:` frontmatter).
   */
  readonly allowlistShape: "within-server" | "global-prefixed";
  /** Only meaningful when `allowlistShape` is `global-prefixed`. Empty string for none. */
  readonly globalPrefix?: string;
  /**
   * Present only for a harness that must cap the wire name itself (today,
   * only Grok — its 64-char, `__`-sensitive fully-qualified name limit).
   * Absent means the wire name is used byte-identical to `canonicalBase`.
   */
  readonly capBudget?: number;
}

const SHIM_SERVER_KEY = "prism-mcp-shim";
/** Grok's shim server key is deliberately the shortest legal one, to maximize `capBudget`. */
const GROK_SHIM_SERVER_KEY = "prism";
/** Grok's hard limit on a fully-qualified `<server>__<tool>` MCP name. */
const GROK_MAX_QUALIFIED_LENGTH = 64;
/** Reserved for the `__` joining the server key to the wire name. */
const GROK_SEPARATOR_LENGTH = 2;

const HARNESS_WIRE_CONFIG: Record<ShimHarnessId, HarnessWireConfig> = {
  "claude-code": { serverKey: SHIM_SERVER_KEY, allowlistShape: "global-prefixed", globalPrefix: "mcp__" },
  "codex-cli": { serverKey: SHIM_SERVER_KEY, allowlistShape: "within-server" },
  hermes: { serverKey: SHIM_SERVER_KEY, allowlistShape: "within-server" },
  "kimi-code": { serverKey: SHIM_SERVER_KEY, allowlistShape: "within-server" },
  // Open item (see design risks): antigravity-cli/cursor/factory-droid were
  // HTTP-only before consolidation, so their shim-mode allowlist shape is
  // unconfirmed. Default to the within-server shape shared by Codex/Hermes/
  // Kimi, locked here by a golden so a future correction is a one-line diff
  // instead of a silent naming drift.
  "antigravity-cli": { serverKey: SHIM_SERVER_KEY, allowlistShape: "within-server" },
  cursor: { serverKey: SHIM_SERVER_KEY, allowlistShape: "within-server" },
  "factory-droid": { serverKey: SHIM_SERVER_KEY, allowlistShape: "within-server" },
  grok: {
    serverKey: GROK_SHIM_SERVER_KEY,
    allowlistShape: "global-prefixed",
    globalPrefix: "",
    capBudget: GROK_MAX_QUALIFIED_LENGTH - GROK_SHIM_SERVER_KEY.length - GROK_SEPARATOR_LENGTH,
  },
};

/** The MCP server key `harness`'s compiled config registers the shim under. */
export const shimServerKey = (harness: ShimHarnessId): string => HARNESS_WIRE_CONFIG[harness].serverKey;

/**
 * The wire name `harness` advertises (and the shim, told
 * `PRISM_SHIM_HARNESS=harness`, must advertise identically) for `tool` on
 * `pluginName`'s daemon. Byte-identical to `canonicalBase` for every
 * harness except Grok, whose wire name is additionally capped —
 * `guard`, when supplied, catches a same-pass collision between two
 * different tools capping to the same name (see `capGrokWireName`).
 */
export const renderWire = (
  harness: ShimHarnessId,
  pluginName: string,
  tool: string,
  guard?: GrokCollisionGuard,
): string => {
  const base = canonicalBase(pluginName, tool);
  const { capBudget } = HARNESS_WIRE_CONFIG[harness];
  return capBudget === undefined ? base : capGrokWireName(base, capBudget, guard);
};

/**
 * The exact string `harness`'s compiled config embeds in its allowlist
 * field for `tool` on `pluginName`'s daemon — `renderWire`'s output alone
 * for a `within-server` harness, or prefixed with the server key (and, for
 * Claude Code, the literal `mcp__`) for a `global-prefixed` one.
 */
export const renderAllowlist = (
  harness: ShimHarnessId,
  pluginName: string,
  tool: string,
  guard?: GrokCollisionGuard,
): string => {
  const wire = renderWire(harness, pluginName, tool, guard);
  const config = HARNESS_WIRE_CONFIG[harness];
  if (config.allowlistShape === "within-server") return wire;
  return `${config.globalPrefix ?? ""}${config.serverKey}__${wire}`;
};
