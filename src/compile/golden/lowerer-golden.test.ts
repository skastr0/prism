import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { createGoldenCompileFixture } from "../test-fixtures.js";
import { planPluginForTarget } from "../pipeline.js";
import {
  formatGolden,
  normalizeLowerOutput,
} from "./normalize-lower-output.js";

const HARNESSES = [
  "opencode",
  "claude-code",
  "codex-cli",
  "hermes",
  "antigravity-cli",
  "grok",
  "factory-droid",
  "pi",
  "kimi-code",
] as const;

const UPDATE_MODE = process.env.GOLDEN_UPDATE === "1";

let tempRoot: string;
let pluginRoot: string;
let projectRoot: string;
let prismHome: string;
const harnessRoots: Record<string, string> = {};

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "prism-golden-"));
  pluginRoot = join(tempRoot, "plugin");
  projectRoot = join(tempRoot, "project");
  prismHome = join(tempRoot, "prism-home");
  await mkdir(prismHome, { recursive: true });

  for (const harness of HARNESSES) {
    harnessRoots[harness] = join(tempRoot, "roots", harness);
    await mkdir(harnessRoots[harness], { recursive: true });
  }

  await createGoldenCompileFixture({ pluginRoot, projectRoot });
}, 120_000);

afterAll(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

for (const harness of HARNESSES) {
  test(
    `golden snapshot for ${harness} lowerer`,
    async () => {
      const root = harnessRoots[harness]!;
      const planned = await Effect.runPromise(
        planPluginForTarget({
          pluginPath: pluginRoot,
          target: harness,
          scope: "global",
          root,
          prismHome,
          dryRun: true,
        }),
      );

      const normalized = normalizeLowerOutput(
        { files: planned.files, regions: planned.regions },
        {
          harnessId: harness,
          root,
          prismHome,
          pluginRoot,
          projectRoot,
          tempRoot,
        },
      );

      const goldenPath = join(import.meta.dir, harness, "default.json");

      if (UPDATE_MODE) {
        await mkdir(dirname(goldenPath), { recursive: true });
        await writeFile(goldenPath, formatGolden(normalized));
        return;
      }

      const golden = JSON.parse(await readFile(goldenPath, "utf8"));
      expect(normalized).toEqual(golden);
    },
    { timeout: 120_000 },
  );
}

// Separate from the flag-off loop above: claude-code with the stdio-shim
// rollout flag on. The N per-owner http entries collapse into one
// aggregated `.mcp.json` entry — see `src/compile/lowerers/claude-code.ts`.
// The flag-off goldens above must stay byte-identical; this is the new
// fixture proving the flag-on shape.
test(
  "golden snapshot for claude-code lowerer in stdio-shim mode",
  async () => {
    const root = harnessRoots["claude-code"]!;
    const planned = await Effect.runPromise(
      planPluginForTarget({
        pluginPath: pluginRoot,
        target: "claude-code",
        scope: "global",
        root,
        prismHome,
        dryRun: true,
        mcpTransport: "stdio-shim",
      }),
    );

    const normalized = normalizeLowerOutput(
      { files: planned.files, regions: planned.regions },
      {
        harnessId: "claude-code",
        root,
        prismHome,
        pluginRoot,
        projectRoot,
        tempRoot,
      },
    );

    const goldenPath = join(import.meta.dir, "claude-code", "stdio-shim.json");

    if (UPDATE_MODE) {
      await mkdir(dirname(goldenPath), { recursive: true });
      await writeFile(goldenPath, formatGolden(normalized));
      return;
    }

    const golden = JSON.parse(await readFile(goldenPath, "utf8"));
    expect(normalized).toEqual(golden);
  },
  { timeout: 120_000 },
);

// Separate from the flag-off loop above: codex-cli with the stdio-shim
// rollout flag on. The N per-owner http entries collapse into one
// aggregated config.toml entry with command/args/env — see
// `src/compile/lowerers/codex-cli.ts`. The flag-off goldens above must
// stay byte-identical; this is the new fixture proving the flag-on shape.
test(
  "golden snapshot for codex-cli lowerer in stdio-shim mode",
  async () => {
    const root = harnessRoots["codex-cli"]!;
    const planned = await Effect.runPromise(
      planPluginForTarget({
        pluginPath: pluginRoot,
        target: "codex-cli",
        scope: "global",
        root,
        prismHome,
        dryRun: true,
        mcpTransport: "stdio-shim",
      }),
    );

    const normalized = normalizeLowerOutput(
      { files: planned.files, regions: planned.regions },
      {
        harnessId: "codex-cli",
        root,
        prismHome,
        pluginRoot,
        projectRoot,
        tempRoot,
      },
    );

    const goldenPath = join(import.meta.dir, "codex-cli", "stdio-shim.json");

    if (UPDATE_MODE) {
      await mkdir(dirname(goldenPath), { recursive: true });
      await writeFile(goldenPath, formatGolden(normalized));
      return;
    }

    const golden = JSON.parse(await readFile(goldenPath, "utf8"));
    expect(normalized).toEqual(golden);
  },
  { timeout: 120_000 },
);

// Separate from the flag-off loop above: hermes with the stdio-shim
// rollout flag on. The N per-owner http entries collapse into one
// aggregated config.yaml entry with command/args/env — see
// `src/compile/lowerers/hermes.ts`. The flag-off goldens above must
// stay byte-identical; this is the new fixture proving the flag-on shape.
test(
  "golden snapshot for hermes lowerer in stdio-shim mode",
  async () => {
    const root = harnessRoots["hermes"]!;
    const planned = await Effect.runPromise(
      planPluginForTarget({
        pluginPath: pluginRoot,
        target: "hermes",
        scope: "global",
        root,
        prismHome,
        dryRun: true,
        mcpTransport: "stdio-shim",
      }),
    );

    const normalized = normalizeLowerOutput(
      { files: planned.files, regions: planned.regions },
      {
        harnessId: "hermes",
        root,
        prismHome,
        pluginRoot,
        projectRoot,
        tempRoot,
      },
    );

    const goldenPath = join(import.meta.dir, "hermes", "stdio-shim.json");

    if (UPDATE_MODE) {
      await mkdir(dirname(goldenPath), { recursive: true });
      await writeFile(goldenPath, formatGolden(normalized));
      return;
    }

    const golden = JSON.parse(await readFile(goldenPath, "utf8"));
    expect(normalized).toEqual(golden);
  },
  { timeout: 120_000 },
);
