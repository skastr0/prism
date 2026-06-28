/**
 * Headless "screenshots" of the plugins TUI — render it in OpenTUI's virtual
 * terminal, drive it through states, and print each frame as a plain-text grid.
 * Lets us SEE the UI (and diagnose glitches) without a real TTY.
 *
 *   bun scripts/plugins-tui-snapshot.ts                 # hermetic temp fixture
 *   bun scripts/plugins-tui-snapshot.ts /path/to/plugins [--settle 4000]
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { PluginsApp } from "../src/plugins-tui/app.js";

const argv = process.argv.slice(2);
const settleIdx = argv.indexOf("--settle");
const settleMs = settleIdx >= 0 ? Number(argv[settleIdx + 1]) : 600;
const dirArg = argv.find((a) => !a.startsWith("--") && a !== String(settleMs));

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const buildFixture = async (): Promise<{ dir: string; prismHome: string; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(join(tmpdir(), "prism-tui-snap-"));
  const prismHome = join(root, "prism-home");
  const dir = join(root, "plugins");
  await mkdir(prismHome, { recursive: true });
  const plugin = async (name: string, manifest: Record<string, unknown>) =>
    writeText(join(dir, name, "plugin.json"), `${JSON.stringify({ name, version: "0.1.0", ...manifest }, null, 2)}\n`);
  await plugin("alpha-rules", { targets: { rules: ["codex-cli", "claude-code"] } });
  await writeText(join(dir, "alpha-rules", "rules", "global", "style.md"), "# Style\n\nShort names.\n");
  await plugin("beta-skill", { targets: { skills: ["claude-code"], rules: ["claude-code"] } });
  await writeText(
    join(dir, "beta-skill", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: A demo skill for the snapshot fixture.\n---\n\n# Demo\n",
  );
  // Intentionally invalid manifest (missing version) to exercise the INVALID badge.
  await writeText(join(dir, "broken", "plugin.json"), `${JSON.stringify({ name: "broken" }, null, 2)}\n`);
  process.env.PRISM_HOME = prismHome;
  return { dir, prismHome, cleanup: () => rm(root, { recursive: true, force: true }) };
};

const main = async (): Promise<void> => {
  const fixture = dirArg ? null : await buildFixture();
  const dir = dirArg ?? fixture!.dir;
  const projectPath = process.cwd();

  const setup = await testRender(<PluginsApp dir={dir} projectPath={projectPath} pollMs={600_000} />, {
    width: 140,
    height: 44,
  });

  const settle = async (ms = settleMs): Promise<void> => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  };

  const shot = (label: string): void => {
    process.stdout.write(`\n\n========== ${label} ==========\n`);
    process.stdout.write(setup.captureCharFrame());
    process.stdout.write("\n");
  };

  const mi = setup.mockInput;
  // Named keys (Tab/arrows/Enter/Escape) MUST use the dedicated methods —
  // pressKey("tab") would send the literal chars t-a-b.
  const drive = async (fn: () => void, ms?: number): Promise<void> => {
    await act(() => fn());
    await settle(ms);
  };

  try {
    await settle(settleMs);
    shot("01 initial — list focus + Preview tab");
    await drive(() => mi.pressTab());
    shot("02 Status tab (list focus)");
    await drive(() => mi.pressTab());
    shot("03 Introspect tab (list focus)");
    await drive(() => mi.pressKey("d"));
    shot("04 Doctor tab — jumped into detail focus (d)");
    await drive(() => mi.pressKey("j"), 200);
    shot("05 Doctor: finding cursor moved (j in detail)");
    await drive(() => mi.pressArrow("down"));
    shot("06 selection → beta (back-to-list on arrow? no: detail focus)");
    await drive(() => mi.pressKey("r"));
    shot("07 refresh confirm prompt (r)");
    await drive(() => mi.pressEscape());
  } finally {
    act(() => setup.renderer.destroy());
    if (fixture) await fixture.cleanup();
  }
};

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
