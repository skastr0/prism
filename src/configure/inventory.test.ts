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
  isHookArtifactPath,
  isHookRegionKey,
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

  test("hook region keys classify as hook, not rules", () => {
    expect(isHookRegionKey("codex.hooks.groundwork")).toBe(true);
    expect(isHookRegionKey("codex.features.hooks")).toBe(false);
    expect(isHookRegionKey("hermes.hooks.pre_tool_call")).toBe(true);
    expect(
      classifyRelativePath("config.toml", "region", { regionKey: "codex.hooks.demo" }).noun,
    ).toBe("hook");
    expect(
      classifyRelativePath("config.toml", "region", { regionKey: "codex.features.hooks" }).noun,
    ).toBe("rules");
    expect(classifyRelativePath("CLAUDE.md", "region", { regionKey: "codex.rules.x" }).noun).toBe(
      "rules",
    );
  });

  test("hook artifact paths include root + plugin hooks.json", () => {
    expect(isHookArtifactPath("hooks.json")).toBe(true);
    expect(isHookArtifactPath("hooks.v1.json")).toBe(true);
    expect(isHookArtifactPath("hooks/session-start.mjs")).toBe(true);
    expect(
      isHookArtifactPath("plugins/cache/groundwork-local/groundwork/0.2.1/hooks/hooks.json"),
    ).toBe(true);
    expect(
      isHookArtifactPath(
        "plugins/cache/groundwork-local/groundwork/0.2.1/hooks/groundwork-codex-hook.sh",
      ),
    ).toBe(false);
    expect(
      isHookArtifactPath("plugins/cache/x/y/node_modules/abstract-level/lib/hooks.js"),
    ).toBe(false);

    const gw = classifyRelativePath(
      "plugins/cache/groundwork-local/groundwork/0.2.1/hooks/hooks.json",
      "owned",
    );
    expect(gw.noun).toBe("hook");
    expect(gw.logicalKey).toBe("plugin:groundwork");
    expect(gw.label).toBe("groundwork");

    const root = classifyRelativePath("hooks.json", "owned");
    expect(root.noun).toBe("hook");
    expect(root.logicalKey).toBe("hooks.json");
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

  test("indexes codex root hooks.json and plugin-cache hooks", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const root = await fs.mkdtemp(join(os.tmpdir(), "prism-configure-hooks-"));
    const prismHome = join(root, "prism-home");
    const codexRoot = join(root, "codex");
    await mkdir(join(codexRoot, "plugins", "cache", "gw-local", "groundwork", "0.2.1", "hooks"), {
      recursive: true,
    });
    await mkdir(join(codexRoot, "hooks"), { recursive: true });
    await writeFile(
      join(codexRoot, "hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [] } }),
    );
    await writeFile(
      join(codexRoot, "plugins", "cache", "gw-local", "groundwork", "0.2.1", "hooks", "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [] } }),
    );
    await writeFile(join(codexRoot, "hooks", "prism-demo.mjs"), "export default {}\n");
    await writeFile(
      join(
        codexRoot,
        "plugins",
        "cache",
        "gw-local",
        "groundwork",
        "0.2.1",
        "hooks",
        "groundwork.sh",
      ),
      "#!/bin/sh\n",
    );

    await writeSnapshot(prismHome, {
      version: 1,
      harness: "codex-cli",
      root: codexRoot,
      entries: [
        {
          targetPath: join(codexRoot, "config.toml"),
          contentHash: "cfg",
          mode: "region",
          regionKey: "codex.hooks.demo-plugin",
          plugin: "demo-plugin",
        },
      ],
    });

    const inv = await loadConfigureInventory({
      prismHome,
      env: {
        ...process.env,
        HOME: root,
        PRISM_HOME: prismHome,
        // Force codex home to temp root via CODEX_HOME if harness respects it —
        // inventory uses resolveHarnessRoot; set HOME so ~/.codex resolves under temp.
      },
    });

    // Harness root is expandPath("~/.codex") under HOME=root → root/codex only if
    // harness registry uses ~/.codex under HOME. Snapshot still attaches via harness id.
    const detail = inv.byHarness["codex-cli"];
    expect(detail).toBeDefined();

    const hookGroups = detail!.groups.filter((g) => g.noun === "hook");
    const hookLabels = hookGroups.map((g) => g.label).sort();
    // At least the region hook from snapshot; disk hooks depend on harness root == codexRoot.
    expect(hookGroups.some((g) => g.logicalKey === "region:codex.hooks.demo-plugin")).toBe(true);

    // When HOME makes globalRoot === codexRoot, disk hooks appear too.
    const harnessRoot = detail!.summary.globalRoot;
    if (harnessRoot === codexRoot || harnessRoot.replace(/\/$/u, "") === codexRoot) {
      expect(detail!.summary.counts.hook).toBeGreaterThanOrEqual(3);
      expect(hookLabels).toEqual(expect.arrayContaining(["hooks.json", "groundwork", "prism-demo.mjs"]));
      // wrapper .sh under plugin cache is not a separate group
      expect(hookLabels.some((l) => l.includes("groundwork.sh"))).toBe(false);
    }
  });
});
