import { describe, it, expect } from "bun:test";
import {
  SHIM_HARNESS_IDS,
  canonicalBase,
  canonicalNamespace,
  capGrokWireName,
  createGrokCollisionGuard,
  parseCanonicalBase,
  renderAllowlist,
  renderWire,
  shimServerKey,
  stableHash8,
  type ShimHarnessId,
} from "./wire-naming";

describe("canonicalBase", () => {
  it("is p_<hash8>_<tool>, joined by exactly one underscore", () => {
    const base = canonicalBase("forge", "forge_create_glyph");
    expect(base).toBe(`p_${stableHash8("forge")}_forge_create_glyph`);
  });

  it("is a pure deterministic function of (plugin, tool)", () => {
    expect(canonicalBase("forge", "do_thing")).toBe(canonicalBase("forge", "do_thing"));
  });

  it("is unique across plugins for the same tool name", () => {
    const plugins = ["forge", "beacon", "survey", "scribe", "oracle", "tower", "booth", "manual"];
    const bases = plugins.map((plugin) => canonicalBase(plugin, "shared_tool_name"));
    expect(new Set(bases).size).toBe(bases.length);
  });

  it("is unique across tools for the same plugin", () => {
    const tools = ["create_glyph", "read_glyph", "list_glyphs", "transition_glyph"];
    const bases = tools.map((tool) => canonicalBase("forge", tool));
    expect(new Set(bases).size).toBe(bases.length);
  });

  it("provably contains zero '__' when tool is a sanitized, underscore-collapsed segment", () => {
    // Mirrors the upstream contract `generatedToolNameForBinding` guarantees:
    // no leading/trailing '_', no internal run of 2+ '_'.
    const sanitizedTools = ["forge_create_glyph", "beacon_ad_creative", "a", "tool_with_many_words_in_it"];
    for (const tool of sanitizedTools) {
      const base = canonicalBase("some-plugin", tool);
      expect(base).not.toContain("__");
    }
  });
});

describe("canonicalNamespace", () => {
  it("is p_<8 lowercase hex chars>", () => {
    expect(canonicalNamespace("some-plugin")).toMatch(/^p_[0-9a-f]{8}$/);
  });
});

describe("parseCanonicalBase — forward-map invertibility", () => {
  it("recovers the exact namespace and tool for a range of (plugin, tool) pairs", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["forge", "create_glyph"],
      ["beacon-marketing", "ad_creative"],
      ["a", "b"],
      ["prism-generated-scribe", "instagram_caption_craft"],
      ["x", "tool_name_with_underscores_inside"],
    ];
    for (const [plugin, tool] of cases) {
      const base = canonicalBase(plugin, tool);
      const parsed = parseCanonicalBase(base);
      expect(parsed).toEqual({ namespace: canonicalNamespace(plugin), tool });
    }
  });

  it("rejects a string shorter than the fixed namespace + separator width", () => {
    expect(parseCanonicalBase("p_abcd1234")).toBeUndefined();
    expect(parseCanonicalBase("")).toBeUndefined();
  });

  it("rejects a string whose separator position is not '_'", () => {
    // 10-char namespace-shaped prefix followed by something other than '_'.
    expect(parseCanonicalBase("p_abcd1234Xtool")).toBeUndefined();
  });

  it("does not claim to invert a Grok-capped (truncated + hashed) wire name", () => {
    const longTool = "a".repeat(80);
    const base = canonicalBase("some-plugin", longTool);
    const capped = capGrokWireName(base, 57);
    expect(capped).not.toBe(base);
    // The capped name's tail is a hash of the *whole* pre-cap name, not a
    // positional encoding — parsing it back does not recover `longTool`.
    const parsed = parseCanonicalBase(capped);
    expect(parsed === undefined || parsed.tool !== longTool).toBe(true);
  });
});

describe("capGrokWireName", () => {
  it("returns names within budget byte-identical", () => {
    expect(capGrokWireName("short_name", 57)).toBe("short_name");
  });

  it("truncates an over-budget name and appends a stable hash suffix", () => {
    const long = "p_deadbeef_" + "x".repeat(60);
    const capped = capGrokWireName(long, 57);
    expect(capped.length).toBeLessThanOrEqual(57);
    expect(capped.endsWith(`_${stableHash8(long)}`)).toBe(true);
  });

  it("is deterministic across calls for the same input", () => {
    const long = "p_deadbeef_" + "y".repeat(60);
    expect(capGrokWireName(long, 57)).toBe(capGrokWireName(long, 57));
  });

  it("collision guard throws when two different names truncate to the same capped name", () => {
    const guard = createGrokCollisionGuard();
    // Two names sharing everything within the truncation window but
    // differing only in the part the cap will drop still hash-suffix
    // differently in the real algorithm, so force an artificial collision
    // by capping the *same* prefix budget for two distinct full names and
    // asserting the guard is exercised (same source is never an error).
    const name = "p_deadbeef_" + "z".repeat(60);
    const capped = capGrokWireName(name, 57, guard);
    // Re-resolving the identical (source, capped) pair must not throw.
    expect(() => guard.resolve(name, capped)).not.toThrow();
    // A different source claiming the same capped output must throw.
    expect(() => guard.resolve("different-source-name", capped)).toThrow();
  });
});

describe("SHIM_HARNESS_IDS", () => {
  it("covers exactly the 8 stdio-shim-transport harnesses, excluding native-in-process ones", () => {
    expect(new Set(SHIM_HARNESS_IDS)).toEqual(
      new Set<ShimHarnessId>([
        "claude-code",
        "codex-cli",
        "hermes",
        "antigravity-cli",
        "cursor",
        "factory-droid",
        "kimi-code",
        "grok",
      ]),
    );
  });
});

describe("renderWire / renderAllowlist — per-harness parity", () => {
  const plugin = "forge";
  const tool = "forge_create_glyph";

  it("is within-server (allowlist === wire, no server-key prefix) for codex-cli, hermes, kimi-code, antigravity-cli, cursor, factory-droid", () => {
    const withinServerHarnesses: ReadonlyArray<ShimHarnessId> = [
      "codex-cli",
      "hermes",
      "kimi-code",
      "antigravity-cli",
      "cursor",
      "factory-droid",
    ];
    for (const harness of withinServerHarnesses) {
      const wire = renderWire(harness, plugin, tool);
      const allowlist = renderAllowlist(harness, plugin, tool);
      expect(allowlist).toBe(wire);
      expect(wire).toBe(canonicalBase(plugin, tool));
    }
  });

  it("is global-prefixed mcp__<server>__<wire> for claude-code", () => {
    const wire = renderWire("claude-code", plugin, tool);
    const allowlist = renderAllowlist("claude-code", plugin, tool);
    expect(wire).toBe(canonicalBase(plugin, tool));
    expect(allowlist).toBe(`mcp__${shimServerKey("claude-code")}__${wire}`);
    expect(shimServerKey("claude-code")).toBe("prism-mcp-shim");
  });

  it("is global-prefixed <server>__<wire> (no mcp__ prefix) for grok", () => {
    const wire = renderWire("grok", plugin, tool);
    const allowlist = renderAllowlist("grok", plugin, tool);
    expect(allowlist).toBe(`${shimServerKey("grok")}__${wire}`);
  });

  it("parity: for every shim harness, the allowlist's final '__'-delimited segment is exactly the rendered wire name", () => {
    for (const harness of SHIM_HARNESS_IDS) {
      const wire = renderWire(harness, plugin, tool);
      const allowlist = renderAllowlist(harness, plugin, tool);
      const segments = allowlist.split("__");
      expect(segments[segments.length - 1]).toBe(wire);
      // The tool segment itself must never contain '__' — that would make
      // the split ambiguous for a harness (Grok) that parses by splitting
      // the fully-qualified name on '__'.
      expect(wire).not.toContain("__");
    }
  });

  it("grok's rendered allowlist name stays <= 64 chars and carries exactly one '__' for a maximal-length tool", () => {
    // Upstream contract: generatedToolNameForBinding caps `tool` at 52 chars.
    const maxLengthTool = "t".repeat(52);
    const guard = createGrokCollisionGuard();
    const allowlist = renderAllowlist("grok", plugin, maxLengthTool, guard);
    expect(allowlist.length).toBeLessThanOrEqual(64);
    expect(allowlist.split("__").length).toBe(2);
  });

  it("grok caps a wire name that would otherwise overflow 64 chars", () => {
    const overflowTool = "t".repeat(52) + "_overflow_padding_to_force_truncation";
    const allowlist = renderAllowlist("grok", plugin, overflowTool);
    expect(allowlist.length).toBeLessThanOrEqual(64);
  });

  it("kimi-code's rendered name stays <= 64 chars for a maximal-length tool (no capping needed)", () => {
    // p_ (2) + hash8 (8) + _ (1) + tool (52) = 63 <= 64.
    const maxLengthTool = "t".repeat(52);
    const allowlist = renderAllowlist("kimi-code", plugin, maxLengthTool);
    expect(allowlist.length).toBeLessThanOrEqual(64);
    expect(allowlist).toBe(canonicalBase(plugin, maxLengthTool));
  });

  it("propagates a shared collision guard through renderWire/renderAllowlist for grok", () => {
    const guard = createGrokCollisionGuard();
    const longToolA = "a".repeat(80);
    const longToolB = "b".repeat(80);
    // Distinct sources, distinct capped outputs (different hash suffixes) — no throw.
    expect(() => renderWire("grok", plugin, longToolA, guard)).not.toThrow();
    expect(() => renderWire("grok", plugin, longToolB, guard)).not.toThrow();
    // Re-rendering the exact same (plugin, tool) through the same guard must not throw.
    expect(() => renderWire("grok", plugin, longToolA, guard)).not.toThrow();
  });
});
