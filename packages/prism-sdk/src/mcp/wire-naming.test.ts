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

  it("is within-server (allowlist === wire, no server-key prefix) for codex-cli, hermes, kimi-code, antigravity-cli, cursor", () => {
    const withinServerHarnesses: ReadonlyArray<ShimHarnessId> = [
      "codex-cli",
      "hermes",
      "kimi-code",
      "antigravity-cli",
      "cursor",
    ];
    for (const harness of withinServerHarnesses) {
      const wire = renderWire(harness, plugin, tool);
      const allowlist = renderAllowlist(harness, plugin, tool);
      expect(allowlist).toBe(wire);
      expect(wire).toBe(canonicalBase(plugin, tool));
    }
  });

  it("is global-prefixed mcp__<server>__<wire> for claude-code and factory-droid", () => {
    for (const harness of ["claude-code", "factory-droid"] as const) {
      const wire = renderWire(harness, plugin, tool);
      const allowlist = renderAllowlist(harness, plugin, tool);
      expect(wire).toBe(canonicalBase(plugin, tool));
      expect(allowlist).toBe(`mcp__${shimServerKey(harness)}__${wire}`);
      expect(shimServerKey(harness)).toBe("prism-mcp-shim");
    }
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

// ---------------------------------------------------------------------------
// Per-plugin server naming — the operator-locked target scheme.
// ---------------------------------------------------------------------------

import {
  assertUniqueBareTools,
  bareWireToolName,
  daemonToolCandidatesForBare,
  pluginCapBudget,
  pluginServerKey,
  pluginToolNamespace,
  renderPluginAllowlist,
  renderPluginWire,
} from "./wire-naming";

const GROK_FQ_REGEX = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

describe("pluginServerKey", () => {
  it("is the plugin name itself for well-formed plugin names", () => {
    expect(pluginServerKey("booth")).toBe("booth");
    expect(pluginServerKey("tower")).toBe("tower");
    expect(pluginServerKey("meta-ads-cli")).toBe("meta-ads-cli");
    expect(pluginServerKey("package-authoring")).toBe("package-authoring");
  });

  it("never contains '__', '.', 'shim', or a p_<hash> namespace", () => {
    const inputs = ["booth", "a__b", "weird..name", "My Plugin!", "x_._y", "meta-ads-cli"];
    for (const input of inputs) {
      const key = pluginServerKey(input);
      expect(key).not.toContain("__");
      expect(key).not.toContain(".");
      expect(key).not.toContain("shim");
      expect(key).not.toMatch(/^p_[0-9a-f]{8}$/);
    }
  });

  it("starts with a grok-legal first character even for digit-leading names", () => {
    expect(pluginServerKey("1password-cli")).toMatch(/^[a-z_]/);
    expect(pluginServerKey("-weird-")).toMatch(/^[a-z_]/);
    expect(pluginServerKey("")).toBe("plugin");
  });

  it("caps an overlong plugin name deterministically at 32 chars", () => {
    const long = "an-extremely-long-plugin-name-that-overflows-every-budget";
    const key = pluginServerKey(long);
    expect(key.length).toBeLessThanOrEqual(32);
    expect(key).toBe(pluginServerKey(long));
    expect(key).not.toContain("__");
  });
});

describe("bareWireToolName", () => {
  it("strips the redundant own-plugin namespace prefix", () => {
    expect(bareWireToolName("booth", "booth_context_get")).toBe("context_get");
    expect(bareWireToolName("booth", "booth_drafts_register")).toBe("drafts_register");
    expect(bareWireToolName("meta-ads-cli", "meta_ads_cli_campaign_list")).toBe("campaign_list");
  });

  it("passes a foreign-owner daemon tool name through unchanged", () => {
    expect(bareWireToolName("booth", "tower_create_glyph")).toBe("tower_create_glyph");
  });

  it("never returns an empty name", () => {
    expect(bareWireToolName("booth", "booth_").length).toBeGreaterThan(0);
  });
});

describe("assertUniqueBareTools", () => {
  it("accepts an authored plugin's own tool set", () => {
    expect(() =>
      assertUniqueBareTools("booth", ["booth_context_get", "booth_drafts_register", "tower_create_glyph"]),
    ).not.toThrow();
  });

  it("throws on two daemon tools rendering the same bare name", () => {
    expect(() => assertUniqueBareTools("booth", ["booth_tower_x", "tower_x"])).toThrow(/bare wire name/);
  });
});

describe("renderPluginWire / renderPluginAllowlist", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["booth", "booth_context_get"],
    ["tower", "tower_transition_glyph"],
    ["meta-ads-cli", "meta_ads_cli_campaign_list"],
    ["package-authoring", "package_authoring_prepare_dispatch"],
    ["booth", "tower_create_glyph"], // foreign-owner permission tool
  ];

  it("within-server harnesses see the bare wire name as the allowlist entry (kimi law)", () => {
    for (const harness of ["codex-cli", "hermes", "kimi-code", "cursor", "antigravity-cli"] as const) {
      for (const [plugin, daemonTool] of cases) {
        const wire = renderPluginWire(harness, plugin, daemonTool);
        expect(renderPluginAllowlist(harness, plugin, daemonTool)).toBe(wire);
      }
    }
  });

  it("claude-code renders mcp__<plugin>__<bare>", () => {
    expect(renderPluginAllowlist("claude-code", "booth", "booth_context_get")).toBe("mcp__booth__context_get");
  });

  it("grok renders <plugin>__<bare>", () => {
    expect(renderPluginAllowlist("grok", "booth", "booth_context_get")).toBe("booth__context_get");
  });

  it("factory-droid renders mcp__<plugin>__<bare>", () => {
    expect(renderPluginAllowlist("factory-droid", "booth", "booth_context_get")).toBe("mcp__booth__context_get");
  });

  it("property: no rendered segment ever contains '__' and every grok FQ name matches grok's regex", () => {
    const plugins = ["booth", "tower", "meta-ads-cli", "package-authoring", "1password-cli", "a-very-long-plugin-name-beyond-caps"];
    const toolTails = ["context_get", "a", "campaign_list", "x".repeat(70), "many_words_tool_name_here"];
    for (const plugin of plugins) {
      const key = pluginServerKey(plugin);
      expect(key).not.toContain("__");
      for (const tail of toolTails) {
        const daemonTool = `${pluginToolNamespace(plugin)}_${tail}`.replace(/_+/g, "_");
        for (const harness of SHIM_HARNESS_IDS) {
          const wire = renderPluginWire(harness, plugin, daemonTool);
          expect(wire).not.toContain("__");
          expect(wire.length).toBeGreaterThan(0);
        }
        const grokFq = renderPluginAllowlist("grok", plugin, daemonTool);
        expect(grokFq).toMatch(GROK_FQ_REGEX);
        expect(grokFq.length).toBeLessThanOrEqual(64);
        expect(grokFq.split("__").length).toBe(2);
        const claudeFq = renderPluginAllowlist("claude-code", plugin, daemonTool);
        expect(claudeFq).toMatch(/^mcp__[a-z][a-z0-9_-]*__[A-Za-z0-9_-]+$/);
        expect(claudeFq.split("__").length).toBe(3);
      }
    }
  });

  it("grok caps the bare name against the per-plugin budget with a collision guard", () => {
    const guard = createGrokCollisionGuard();
    const plugin = "booth";
    const budget = pluginCapBudget("grok", plugin)!;
    expect(budget).toBe(64 - "booth".length - 2);
    const overflow = `booth_${"t".repeat(80)}`;
    const wire = renderPluginWire("grok", plugin, overflow, guard);
    expect(wire.length).toBeLessThanOrEqual(budget);
    expect(`${pluginServerKey(plugin)}__${wire}`).toMatch(GROK_FQ_REGEX);
    // Non-capping harnesses leave the same input uncapped.
    expect(pluginCapBudget("claude-code", plugin)).toBeUndefined();
  });
});

describe("daemonToolCandidatesForBare", () => {
  it("puts the prefix-restored own-plugin daemon name first", () => {
    expect(daemonToolCandidatesForBare("booth", "context_get")).toEqual([
      "booth_context_get",
      "context_get",
    ]);
  });
});
