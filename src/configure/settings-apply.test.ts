import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, readFile } from "../fs.js";
import {
  getDottedPath,
  planSetSetting,
  serializeToml,
  setDottedPath,
} from "./settings-apply.js";

const tempRoot = async (prefix: string): Promise<string> => {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), prefix));
};

describe("setDottedPath", () => {
  test("sets top-level key on empty doc", () => {
    expect(setDottedPath({}, "alwaysThinkingEnabled", true)).toEqual({
      alwaysThinkingEnabled: true,
    });
  });

  test("creates intermediate objects", () => {
    expect(setDottedPath({}, "a.b.c", "x")).toEqual({ a: { b: { c: "x" } } });
  });

  test("preserves siblings", () => {
    const next = setDottedPath({ model: "sonnet", nested: { keep: 1 } }, "nested.flag", true);
    expect(next).toEqual({ model: "sonnet", nested: { keep: 1, flag: true } });
  });

  test("replaces non-object intermediate", () => {
    expect(setDottedPath({ a: "scalar" }, "a.b", 2)).toEqual({ a: { b: 2 } });
  });

  test("getDottedPath reads nested", () => {
    expect(getDottedPath({ a: { b: 3 } }, "a.b")).toBe(3);
    expect(getDottedPath({ a: 1 }, "a.b")).toBeUndefined();
  });
});

describe("serializeToml", () => {
  test("scalars and nested tables", () => {
    const text = serializeToml({
      model: "gpt-5",
      features: { hooks: true },
    });
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain("[features]");
    expect(text).toContain("hooks = true");
  });
});

describe("planSetSetting", () => {
  test("blocks unknown key", async () => {
    const result = await planSetSetting({
      harness: "claude-code",
      key: "notARealSetting___",
      value: true,
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/unknown setting key/);
  });

  test("blocks object/array fields", async () => {
    const result = await planSetSetting({
      harness: "claude-code",
      key: "availableModels",
      value: "[]",
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/complex types/);
  });

  test("blocks invalid enum value", async () => {
    const result = await planSetSetting({
      harness: "claude-code",
      key: "effortLevel",
      value: "not-an-effort",
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/invalid enum/);
  });

  test("dryRun boolean does not write; apply writes with backup", async () => {
    const root = await tempRoot("prism-configure-set-");
    await mkdir(root, { recursive: true });
    const settingsPath = join(root, "settings.json");
    await Bun.write(
      settingsPath,
      JSON.stringify({ model: "sonnet", alwaysThinkingEnabled: false }, null, 2) + "\n",
    );

    const dry = await planSetSetting({
      harness: "claude-code",
      root,
      key: "alwaysThinkingEnabled",
      value: true,
      dryRun: true,
    });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.path).toBe(settingsPath);
    expect(dry.previousPreview).toBe("false");
    expect(dry.nextPreview).toBe("true");
    expect(await readFile(settingsPath)).toContain('"alwaysThinkingEnabled": false');
    expect(await exists(`${settingsPath}.prism-configure-bak`)).toBe(false);

    const applied = await planSetSetting({
      harness: "claude-code",
      root,
      key: "alwaysThinkingEnabled",
      value: true,
      dryRun: false,
    });
    expect(applied.ok).toBe(true);
    expect(applied.dryRun).toBe(false);
    expect(applied.previousPreview).toBe("false");
    expect(applied.nextPreview).toBe("true");

    const after = JSON.parse(await readFile(settingsPath)) as {
      alwaysThinkingEnabled: boolean;
      model: string;
    };
    expect(after.alwaysThinkingEnabled).toBe(true);
    expect(after.model).toBe("sonnet");
    expect(await exists(`${settingsPath}.prism-configure-bak`)).toBe(true);
    const bak = JSON.parse(await readFile(`${settingsPath}.prism-configure-bak`)) as {
      alwaysThinkingEnabled: boolean;
    };
    expect(bak.alwaysThinkingEnabled).toBe(false);
  });

  test("sets enum string on settings.json", async () => {
    const root = await tempRoot("prism-configure-enum-");
    await mkdir(root, { recursive: true });
    const settingsPath = join(root, "settings.json");
    await Bun.write(settingsPath, '{ "effortLevel": "low" }\n');

    const result = await planSetSetting({
      harness: "claude-code",
      root,
      key: "effortLevel",
      value: "high",
      dryRun: false,
    });
    expect(result.ok).toBe(true);
    expect(result.nextPreview).toBe("high");
    const doc = JSON.parse(await readFile(settingsPath)) as { effortLevel: string };
    expect(doc.effortLevel).toBe("high");
  });

  test("preserves jsonc comments via modify", async () => {
    const root = await tempRoot("prism-configure-jsonc-");
    await mkdir(root, { recursive: true });
    const settingsPath = join(root, "settings.json");
    await Bun.write(
      settingsPath,
      `{
  // keep me
  "model": "sonnet",
  "fastMode": false
}
`,
    );

    const result = await planSetSetting({
      harness: "claude-code",
      root,
      key: "fastMode",
      value: true,
      dryRun: false,
    });
    expect(result.ok).toBe(true);
    const text = await readFile(settingsPath);
    expect(text).toContain("// keep me");
    expect(text).toMatch(/"fastMode"\s*:\s*true/);
  });

  test("creates missing settings file", async () => {
    const root = await tempRoot("prism-configure-create-");
    await mkdir(root, { recursive: true });
    const settingsPath = join(root, "settings.json");
    expect(await exists(settingsPath)).toBe(false);

    const result = await planSetSetting({
      harness: "claude-code",
      root,
      key: "model",
      value: "opus",
      dryRun: false,
    });
    expect(result.ok).toBe(true);
    expect(await exists(settingsPath)).toBe(true);
    expect(JSON.parse(await readFile(settingsPath))).toEqual({ model: "opus" });
    // no prior file → no bak
    expect(await exists(`${settingsPath}.prism-configure-bak`)).toBe(false);
  });

  test("toml write for codex-cli model", async () => {
    const root = await tempRoot("prism-configure-toml-");
    await mkdir(root, { recursive: true });
    const configPath = join(root, "config.toml");
    await Bun.write(configPath, 'model = "old"\n\n[features]\nhooks = false\n');

    const dry = await planSetSetting({
      harness: "codex-cli",
      root,
      key: "model",
      value: "gpt-5.6-sol",
      dryRun: true,
    });
    expect(dry.ok).toBe(true);
    expect(dry.previousPreview).toBe("old");
    expect(await readFile(configPath)).toContain('model = "old"');

    const applied = await planSetSetting({
      harness: "codex-cli",
      root,
      key: "model",
      value: "gpt-5.6-sol",
      dryRun: false,
    });
    expect(applied.ok).toBe(true);
    const text = await readFile(configPath);
    expect(text).toContain('model = "gpt-5.6-sol"');
    // nested table should still round-trip
    expect(text).toContain("[features]");
  });
});
