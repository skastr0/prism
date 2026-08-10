import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeSnapshotManifest, type SnapshotManifest } from "../state/snapshot.js";
import { snapshotPath } from "../state/store.js";
import {
  barePluginName,
  classifyRelativePath,
  extractGeneratedPlugin,
  loadConfigureInventory,
  pluginScopeNames,
} from "./inventory.js";

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
    expect(classifyRelativePath("skills/prism-generated-tower/agents/x.md", "owned").noun).toBe(
      "agent",
    );
    expect(classifyRelativePath("skills/prism-generated-tower/commands/y.md", "owned").noun).toBe(
      "command",
    );
    expect(classifyRelativePath("CLAUDE.md", "region").noun).toBe("rules");
    expect(extractGeneratedPlugin("skills/prism-generated-booth/SKILL.md")).toBe("booth");
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

    expect(inv.harnesses).toHaveLength(1);
    expect(inv.harnesses[0]!.harness).toBe("claude-code");
    expect(inv.artifacts.some((a) => a.plugin === "demo" && a.ownership === "prism-owned")).toBe(
      true,
    );
    expect(inv.harnesses[0]!.plugins.some((p) => p.name === "demo")).toBe(true);
    // At least one owned + one region counted for demo
    const demo = inv.harnesses[0]!.plugins.find((p) => p.name === "demo");
    expect(demo?.ownedFiles).toBe(1);
    expect(demo?.regions).toBe(1);
  });
});
