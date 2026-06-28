import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { withPrismSandbox } from "../testing/prism-sandbox.js";
import { readManifest } from "../manifest.js";
import { planAllForPlugin, pluginTargetedHarnesses } from "../plugin-inventory.js";
import { PluginsApp } from "./app.js";

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const createPlugin = async (
  root: string,
  name: string,
  manifest: Record<string, unknown>,
): Promise<string> => {
  const pluginRoot = join(root, name);
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name, version: "0.1.0", ...manifest }, null, 2)}\n`,
  );
  return pluginRoot;
};

test("planAllForPlugin surveys targeted harnesses and classifies a fresh install as not-converged", async () => {
  await withPrismSandbox(async ({ prismHome, roots }) => {
    const pluginRoot = await createPlugin(prismHome, "rules-demo", {
      targets: { rules: ["codex-cli"] },
    });
    await writeText(join(pluginRoot, "rules", "global", "style.md"), "# Style\n\nShort names.\n");

    const manifest = await readManifest(pluginRoot);
    expect(pluginTargetedHarnesses(manifest)).toContain("codex-cli");

    const plan = await planAllForPlugin({
      pluginPath: pluginRoot,
      manifest,
      harnesses: pluginTargetedHarnesses(manifest),
      scope: "global",
      prismHome,
      dryRun: true,
      roots,
    });

    expect(plan.pluginName).toBe("rules-demo");
    const cell = plan.harnesses.find((entry) => entry.harness === "codex-cli");
    expect(cell).toBeDefined();
    // Nothing is installed yet, so the dry-run plan must show pending writes.
    expect(cell!.converged).toBe(false);
    expect(cell!.ops.length).toBeGreaterThan(0);
    expect(cell!.compileFailed).toBe(false);
  });
});

test("plugins TUI lists the plugins discovered in a folder", async () => {
  await withPrismSandbox(async ({ prismHome }) => {
    const previous = process.env.PRISM_HOME;
    process.env.PRISM_HOME = prismHome;
    const dir = join(prismHome, "plugins-src");
    await createPlugin(dir, "alpha-plugin", { targets: { rules: ["codex-cli"] } });
    await writeText(join(dir, "alpha-plugin", "rules", "global", "x.md"), "# X\n");

    const setup = await testRender(
      <PluginsApp dir={dir} projectPath={prismHome} pollMs={600_000} />,
      { width: 120, height: 40 },
    );
    try {
      // Flush the mount effect's async loadPluginRows (readdir -> setState) inside act.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      const frame = await setup.waitForFrame(
        (candidate) => candidate.includes("Plugins") && candidate.includes("alpha-plugin"),
      );
      expect(frame).toContain("preview");
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
      if (previous === undefined) delete process.env.PRISM_HOME;
      else process.env.PRISM_HOME = previous;
    }
  });
});
