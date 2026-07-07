import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, readFile } from "../fs.js";
import {
  emptyShimExposureRegistry,
  gcShimExposure,
  priorShimExposureForPlugin,
  readShimExposure,
  shimExposurePath,
  unionShimExposure,
  updateShimExposureEntry,
} from "./shim-exposure.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-shim-exposure-test-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("union is deterministic: sorted and deduped regardless of input order", () => {
  const left = { plugins: ["zeta", "alpha"], enabledTools: ["t_b", "t_a"] };
  const right = { plugins: ["alpha", "mid"], enabledTools: ["t_a", "t_c"] };
  const forward = unionShimExposure([left, right]);
  const backward = unionShimExposure([right, left]);
  expect(forward).toEqual(backward);
  expect(forward).toEqual({
    plugins: ["alpha", "mid", "zeta"],
    enabledTools: ["t_a", "t_b", "t_c"],
  });
});

test("upsert then read round-trips; prior union excludes self", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const harnessRoot = join(root, ".codex");
  await mkdir(harnessRoot, { recursive: true });

  await updateShimExposureEntry({
    prismHome,
    harness: "codex-cli",
    root: harnessRoot,
    sourcePluginName: "alpha",
    contribution: { plugins: ["alpha"], enabledTools: ["p_1_alpha_tool"] },
  });
  await updateShimExposureEntry({
    prismHome,
    harness: "codex-cli",
    root: harnessRoot,
    sourcePluginName: "beta",
    contribution: { plugins: ["beta"], enabledTools: ["p_2_beta_tool"] },
  });

  const { registry, quarantinedPath } = await readShimExposure({
    prismHome,
    harness: "codex-cli",
    root: harnessRoot,
  });
  expect(quarantinedPath).toBeUndefined();
  expect(Object.keys(registry.entries).sort()).toEqual(["alpha", "beta"]);

  expect(priorShimExposureForPlugin(registry, "alpha")).toEqual({
    plugins: ["beta"],
    enabledTools: ["p_2_beta_tool"],
  });
  expect(priorShimExposureForPlugin(registry, "unrelated")).toEqual({
    plugins: ["alpha", "beta"],
    enabledTools: ["p_1_alpha_tool", "p_2_beta_tool"],
  });
});

test("empty contribution deletes the entry; last deletion removes the file", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const harnessRoot = join(root, ".codex");
  await mkdir(harnessRoot, { recursive: true });

  await updateShimExposureEntry({
    prismHome,
    harness: "codex-cli",
    root: harnessRoot,
    sourcePluginName: "alpha",
    contribution: { plugins: ["alpha"], enabledTools: ["p_1_alpha_tool"] },
  });
  expect(await exists(shimExposurePath(prismHome, harnessRoot))).toBe(true);

  await updateShimExposureEntry({
    prismHome,
    harness: "codex-cli",
    root: harnessRoot,
    sourcePluginName: "alpha",
    contribution: { plugins: [], enabledTools: [] },
  });
  expect(await exists(shimExposurePath(prismHome, harnessRoot))).toBe(false);

  const { registry } = await readShimExposure({
    prismHome,
    harness: "codex-cli",
    root: harnessRoot,
  });
  expect(registry).toEqual(
    emptyShimExposureRegistry({ harness: "codex-cli", root: harnessRoot }),
  );
});

test("corrupt registry file is quarantined and treated as empty", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const harnessRoot = join(root, ".codex");
  await mkdir(harnessRoot, { recursive: true });

  const path = shimExposurePath(prismHome, harnessRoot);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "{not json");

  const { registry, quarantinedPath } = await readShimExposure({
    prismHome,
    harness: "codex-cli",
    root: harnessRoot,
  });
  expect(registry.entries).toEqual({});
  expect(quarantinedPath).toBeDefined();
  expect(await exists(path)).toBe(false);
  expect(await exists(quarantinedPath!)).toBe(true);
});

test("gc drops registries whose harness root vanished and keeps live ones", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const liveRoot = join(root, ".codex");
  const deadRoot = join(root, ".hermes");
  await mkdir(liveRoot, { recursive: true });
  await mkdir(deadRoot, { recursive: true });

  for (const [harness, harnessRoot] of [
    ["codex-cli", liveRoot],
    ["hermes", deadRoot],
  ] as const) {
    await updateShimExposureEntry({
      prismHome,
      harness,
      root: harnessRoot,
      sourcePluginName: "alpha",
      contribution: { plugins: ["alpha"], enabledTools: ["p_1_alpha_tool"] },
    });
  }
  await rm(deadRoot, { recursive: true, force: true });

  const result = await gcShimExposure(prismHome);
  expect(result.dropped.map((entry) => entry.root)).toEqual([deadRoot]);
  expect(await exists(shimExposurePath(prismHome, liveRoot))).toBe(true);
  expect(await exists(shimExposurePath(prismHome, deadRoot))).toBe(false);
});

test("registry writes are canonical: sorted entries and members, trailing newline", async () => {
  const root = await createTempRoot();
  const prismHome = join(root, "prism-home");
  const harnessRoot = join(root, ".codex");
  await mkdir(harnessRoot, { recursive: true });

  await updateShimExposureEntry({
    prismHome,
    harness: "codex-cli",
    root: harnessRoot,
    sourcePluginName: "zeta",
    contribution: { plugins: ["zeta", "alpha", "zeta"], enabledTools: ["t_b", "t_a"] },
  });
  await updateShimExposureEntry({
    prismHome,
    harness: "codex-cli",
    root: harnessRoot,
    sourcePluginName: "alpha",
    contribution: { plugins: ["alpha"], enabledTools: ["t_a"] },
  });

  const raw = await readFile(shimExposurePath(prismHome, harnessRoot));
  expect(raw.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(raw) as {
    entries: Record<string, { plugins: string[]; enabledTools: string[] }>;
  };
  expect(Object.keys(parsed.entries)).toEqual(["alpha", "zeta"]);
  expect(parsed.entries.zeta).toEqual({ plugins: ["alpha", "zeta"], enabledTools: ["t_a", "t_b"] });

  // No stray files beyond the single registry json.
  const dir = join(prismHome, "state", "shim-exposure");
  expect((await readdir(dir)).length).toBe(1);
});
