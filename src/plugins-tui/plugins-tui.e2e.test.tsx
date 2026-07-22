/**
 * End-to-end "drive the TUI" test using OpenTUI's in-process virtual terminal.
 * Proves automated keyboard actions (navigate, switch tabs, open the refresh
 * confirm) drive the real component. Assertions are on hermetic structure (tab
 * markers, list rows, confirm prompt) — never on per-harness state, which is not
 * sandboxed here.
 */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { withPrismSandbox } from "../testing/prism-sandbox.js";
import { PluginsApp } from "./app.js";
import { actAndWaitForTestFrame, waitForTestFrame } from "./test-utils.js";

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

test("plugins TUI drives: list, tab navigation, and refresh confirm", async () => {
  await withPrismSandbox(async ({ prismHome }) => {
    const previous = process.env.PRISM_HOME;
    process.env.PRISM_HOME = prismHome;
    const dir = join(prismHome, "plugins-src");
    const plugin = async (name: string, manifest: Record<string, unknown>): Promise<void> =>
      writeText(
        join(dir, name, "plugin.json"),
        `${JSON.stringify({ name, version: "0.1.0", ...manifest }, null, 2)}\n`,
      );
    await plugin("alpha-rules", { targets: { rules: ["codex-cli"] } });
    await writeText(join(dir, "alpha-rules", "rules", "global", "x.md"), "# X\n");
    await plugin("beta-rules", { targets: { rules: ["codex-cli"] } });
    await writeText(join(dir, "beta-rules", "rules", "global", "y.md"), "# Y\n");
    // Missing version → invalid manifest → INVALID badge.
    await writeText(join(dir, "broken", "plugin.json"), `${JSON.stringify({ name: "broken" }, null, 2)}\n`);

    const setup = await testRender(
      <PluginsApp dir={dir} projectPath={prismHome} />,
      { width: 130, height: 40 },
    );
    const mi = setup.mockInput;

    try {
      // List populates and the invalid plugin shows the ✖ badge.
      const initial = await waitForTestFrame(
        setup,
        (f) => f.includes("alpha-rules") && f.includes("beta-rules") && f.includes("broken"),
      );
      expect(initial).toContain("[preview]");
      // Invalid plugin is flagged with the "!" attention marker.
      expect(initial).toMatch(/!\s*broken/);

      // Tab cycles the detail view; the active-tab marker moves.
      expect(await actAndWaitForTestFrame(setup, () => mi.pressTab(), (f) => f.includes("[status]")))
        .not.toContain("[preview]");

      await actAndWaitForTestFrame(setup, () => mi.pressTab(), (f) => f.includes("[introspect]"));

      await actAndWaitForTestFrame(setup, () => mi.pressTab(), (f) => f.includes("[doctor]"));

      // Down-arrow moves the selection to the next plugin (detail title follows).
      await actAndWaitForTestFrame(setup, () => mi.pressArrow("down"), (f) => f.includes("beta-rules"));

      // `r` opens the refresh-selected confirm; Escape dismisses it.
      await actAndWaitForTestFrame(setup, () => mi.pressKey("r"), (f) => f.includes("refresh selected plugin"));

      expect(await actAndWaitForTestFrame(setup, () => mi.pressEscape(), (f) => f.includes("j/k move")))
        .not.toContain("refresh selected plugin");
    } finally {
      act(() => setup.renderer.destroy());
      if (previous === undefined) delete process.env.PRISM_HOME;
      else process.env.PRISM_HOME = previous;
    }
  });
});
