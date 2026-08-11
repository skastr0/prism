import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeSnapshotManifest, type SnapshotManifest } from "../state/snapshot.js";
import { snapshotPath } from "../state/store.js";
import {
  barePluginName,
  classifyRelativePath,
  extractGeneratedPlugin,
  groupArtifacts,
  loadConfigureInventory,
  pluginScopeNames,
  skillLogicalName,
  skillSiteKey,
} from "./inventory.js";
import type { ArtifactEntry } from "./model.js";

const writeSnapshot = async (
  prismHome: string,
  manifest: SnapshotManifest,
): Promise<void> => {
  const path = snapshotPath(prismHome, manifest.root);
  await mkdir(join(prismHome, "state", "roots"), { recursive: true });
  await writeFile(path, encodeSnapshotManifest(manifest));
};

describe("configure inventory helpers", () => {
  test("barePluginName strips file-router suffix", () => {
    expect(barePluginName("tower")).toBe("tower");
    expect(barePluginName("tower#file-router")).toBe("tower");
  });

  test("pluginScopeNames includes both attribution forms", () => {
    expect([...pluginScopeNames("tower")].sort()).toEqual(["tower", "tower#file-router"]);
  });

  test("classifyRelativePath maps claude layout", () => {
    expect(classifyRelativePath("skills/foo/SKILL.md", "owned").noun).toBe("skill");
    expect(classifyRelativePath("skills/foo/references/a.md", "owned").noun).toBe("skill");
    expect(classifyRelativePath("skills/foo/references/a.md", "owned").role).toBe("support");
    expect(classifyRelativePath("skills/prism-generated-tower/agents/x.md", "owned").noun).toBe(
      "agent",
    );
    expect(classifyRelativePath("skills/prism-generated-tower/commands/y.md", "owned").noun).toBe(
      "command",
    );
    expect(classifyRelativePath("CLAUDE.md", "region").noun).toBe("rules");
    expect(extractGeneratedPlugin("skills/prism-generated-booth/SKILL.md")).toBe("booth");
  });

  test("skillLogicalName + siteKey distinguish direct vs bundle installs", () => {
    expect(skillLogicalName("skills/tower/SKILL.md")).toBe("tower");
    expect(skillLogicalName("skills/prism-generated-tower/skills/tower/SKILL.md")).toBe("tower");
    expect(skillSiteKey("skills/tower/SKILL.md")).toBe("direct:tower");
    expect(skillSiteKey("skills/prism-generated-tower/skills/tower/SKILL.md")).toBe(
      "bundle:tower:tower",
    );
  });

  test("groupArtifacts dedups same skill across install sites", () => {
    const entries: ArtifactEntry[] = [
      {
        id: "1",
        noun: "skill",
        ownership: "foreign",
        targetPath: "/c/skills/tower/SKILL.md",
        relativePath: "skills/tower/SKILL.md",
        label: "tower",
        logicalKey: "tower",
        siteKey: "direct:tower",
        role: "primary",
      },
      {
        id: "2",
        noun: "skill",
        ownership: "prism-owned",
        targetPath: "/c/skills/prism-generated-tower/skills/tower/SKILL.md",
        relativePath: "skills/prism-generated-tower/skills/tower/SKILL.md",
        label: "tower",
        plugin: "tower",
        logicalKey: "tower",
        siteKey: "bundle:tower:tower",
        role: "primary",
      },
      {
        id: "3",
        noun: "skill",
        ownership: "prism-owned",
        targetPath: "/c/skills/prism-generated-tower/skills/tower/references/x.md",
        relativePath: "skills/prism-generated-tower/skills/tower/references/x.md",
        label: "tower",
        plugin: "tower",
        logicalKey: "tower",
        siteKey: "bundle:tower:tower",
        role: "support",
      },
    ];
    const groups = groupArtifacts(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isDuplicate).toBe(true);
    expect(groups[0]!.siteCount).toBe(2);
    expect(groups[0]!.locationCount).toBe(3);
    expect(groups[0]!.logicalKey).toBe("tower");
  });
});

describe("loadConfigureInventory", () => {
  test("loads claude-code snapshot entries and groups plugins", async () => {
    const root = await Bun.file(import.meta.dir).exists().then(() =>
      // temp home
      import("node:os").then((os) =>
        import("node:fs/promises").then((fs) =>
          fs.mkdtemp(join(os.tmpdir(), "prism-configure-inv-")),
        ),
      ),
    );
    const prismHome = join(root, "prism-home");
    const claudeRoot = join(root, "claude");
    await mkdir(join(claudeRoot, "skills", "prism-generated-demo", "skills", "s"), {
      recursive: true,
    });
    await writeFile(
      join(claudeRoot, "skills", "prism-generated-demo", "skills", "s", "SKILL.md"),
      "# skill\n",
    );
    await writeFile(join(claudeRoot, "CLAUDE.md"), "# user\n");

    await writeSnapshot(prismHome, {
      version: 1,
      harness: "claude-code",
      root: claudeRoot,
      entries: [
        {
          targetPath: join(
            claudeRoot,
            "skills",
            "prism-generated-demo",
            "skills",
            "s",
            "SKILL.md",
          ),
          contentHash: "abc",
          mode: "owned",
          plugin: "demo",
        },
        {
          targetPath: join(claudeRoot, "CLAUDE.md"),
          contentHash: "def",
          mode: "region",
          regionKey: "marker <!-- file-router.rules.demo",
          plugin: "demo#file-router",
        },
      ],
    });

    // Point harness root at temp claude via HarnessRoots would need Effect;
    // instead we rely on snapshot root while global may differ — inventory
    // includes all claude-code manifests. Override HOME so resolveHarnessRoot
    // does not matter for snapshot path; we still get entries from snapshot.
    const inv = await loadConfigureInventory({
      prismHome,
      env: { ...process.env, HOME: root, PRISM_HOME: prismHome },
    });

    expect(inv.harnesses.length).toBeGreaterThanOrEqual(1);
    const claude = inv.byHarness["claude-code"] ?? inv.harnesses.find((h) => h.harness === "claude-code");
    expect(claude).toBeDefined();
    const detail = inv.byHarness["claude-code"];
    expect(detail?.artifacts.some((a) => a.plugin === "demo" && a.ownership === "prism-owned")).toBe(
      true,
    );
    expect(detail?.summary.plugins.some((p) => p.name === "demo")).toBe(true);
    const demo = detail?.summary.plugins.find((p) => p.name === "demo");
    expect(demo?.ownedFiles).toBe(1);
    expect(demo?.regions).toBe(1);
  });
});
