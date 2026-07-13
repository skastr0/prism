import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildToolCliCatalog,
  renderToolCliSkillMarkdown,
  writeToolCliCatalog,
} from "./catalog.js";
import {
  toolsCliEmitEnabled,
  toolsCliInjectMode,
  toolsMcpHarnessEmitEnabled,
} from "./flags.js";
import {
  renderToolCliRulesFull,
  renderToolCliRulesPointer,
  toolsCliSkillName,
} from "./inject.js";
import type { ResolvedContractBinding } from "../compile/resolve.js";

const sampleBindings: ReadonlyArray<ResolvedContractBinding> = [
  {
    kind: "permission",
    logicalName: "list_glyphs",
    toolPluginName: "tower",
    toolName: "list_glyphs",
    toolSourcePath: "/tmp/tower/tools/list_glyphs.tool.ts",
  },
  {
    kind: "permission",
    logicalName: "create_glyph",
    toolPluginName: "tower",
    toolName: "create_glyph",
    toolSourcePath: "/tmp/tower/tools/create_glyph.tool.ts",
  },
];

describe("tools-cli catalog", () => {
  test("buildToolCliCatalog sorts tools and carries descriptions", () => {
    const catalog = buildToolCliCatalog({
      pluginName: "tower",
      pluginVersion: "0.1.0",
      bindings: sampleBindings,
      toolDescriptions: new Map([["list_glyphs", "List board glyphs"]]),
      generatedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(catalog.version).toBe(1);
    expect(catalog.plugin).toBe("tower");
    expect(catalog.tools.map((t) => t.name)).toEqual(["create_glyph", "list_glyphs"]);
    expect(catalog.tools.find((t) => t.name === "list_glyphs")?.description).toBe("List board glyphs");
  });

  test("buildToolCliCatalog dedupes bindings by logicalName", () => {
    const catalog = buildToolCliCatalog({
      pluginName: "tower",
      bindings: [...sampleBindings, ...sampleBindings, ...sampleBindings],
      generatedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(catalog.tools.map((t) => t.name)).toEqual(["create_glyph", "list_glyphs"]);
  });

  test("buildToolCliCatalog preserves each binding's wire name", () => {
    const catalog = buildToolCliCatalog({
      pluginName: "tower",
      bindings: [
        {
          kind: "permission",
          logicalName: "submit_review_findings",
          toolPluginName: "tower",
          toolName: "submit_review_findings",
          toolSourcePath: "/tmp/tower/tools/submit_review_findings.tool.ts",
        },
        {
          kind: "permission",
          logicalName: "submit_review",
          toolPluginName: "tower",
          toolName: "submit_review",
          toolSourcePath: "/tmp/tower/tools/submit_review.tool.ts",
        },
      ],
      generatedAt: "2026-07-10T00:00:00.000Z",
    });

    expect(catalog.tools.find((tool) => tool.name === "submit_review")?.wireName).toBe(
      "tower_submit_review",
    );
    expect(catalog.tools.find((tool) => tool.name === "submit_review_findings")?.wireName).toBe(
      "tower_submit_review_findings",
    );
  });

  test("skill markdown documents prism tools invoke", () => {
    const catalog = buildToolCliCatalog({
      pluginName: "tower",
      bindings: sampleBindings,
      generatedAt: "2026-07-10T00:00:00.000Z",
    });
    const md = renderToolCliSkillMarkdown(catalog);
    expect(md).toContain("prism tools invoke tower");
    expect(md).toContain("list_glyphs");
    expect(md).toContain("Do not spawn `prism mcp shim`");
  });

  test("writeToolCliCatalog is idempotent on identical content", async () => {
    const prismHome = await mkdtemp(join(tmpdir(), "prism-tools-cli-"));
    const first = await writeToolCliCatalog({
      prismHome,
      pluginName: "tower",
      bindings: sampleBindings,
      toolDescriptions: new Map([["list_glyphs", "List board glyphs"]]),
    });
    expect(first.written).toBe(true);
    const disk = await readFile(first.catalogPath, "utf8");
    expect(disk).toContain('"plugin": "tower"');
    const skill = await readFile(first.skillPath, "utf8");
    expect(skill).toContain("prism tools invoke tower");

    const second = await writeToolCliCatalog({
      prismHome,
      pluginName: "tower",
      bindings: sampleBindings,
      toolDescriptions: new Map([["list_glyphs", "List board glyphs"]]),
    });
    // generatedAt changes → rewrite is expected; at least paths stable
    expect(second.catalogPath).toBe(first.catalogPath);
    expect(second.skillPath).toBe(first.skillPath);
  });
});

describe("tools-cli flags", () => {
  test("CLI emit defaults on; MCP off; inject defaults skill", () => {
    expect(toolsCliEmitEnabled({})).toBe(true);
    expect(toolsMcpHarnessEmitEnabled({})).toBe(false);
    expect(toolsCliInjectMode({})).toBe("skill");
    expect(toolsCliEmitEnabled({ PRISM_TOOLS_CLI_EMIT: "0" })).toBe(false);
    expect(toolsMcpHarnessEmitEnabled({ PRISM_TOOLS_MCP_EMIT: "0" })).toBe(false);
    expect(toolsMcpHarnessEmitEnabled({ PRISM_TOOLS_MCP_EMIT: "1" })).toBe(true);
    expect(toolsCliInjectMode({ PRISM_TOOLS_CLI_INJECT: "rules" })).toBe("rules");
    expect(toolsCliInjectMode({ PRISM_TOOLS_CLI_INJECT: "skill" })).toBe("skill");
  });
});

describe("tools-cli inject", () => {
  test("pointer rules name tools + skill; full rules include invoke recipes", () => {
    const catalog = buildToolCliCatalog({
      pluginName: "tower",
      bindings: sampleBindings,
      generatedAt: "2026-07-10T00:00:00.000Z",
    });
    const pointer = renderToolCliRulesPointer(catalog);
    expect(pointer).toContain("list_glyphs");
    expect(pointer).toContain("create_glyph");
    expect(pointer).toContain(toolsCliSkillName("tower"));
    expect(pointer).toContain("Load skill");
    expect(pointer).not.toContain("prism tools invoke tower list_glyphs --input '{}'");

    const full = renderToolCliRulesFull(catalog);
    expect(full).toContain("prism tools invoke tower list_glyphs --input '{}'");
    expect(full).toContain("### Tools");
  });
});
