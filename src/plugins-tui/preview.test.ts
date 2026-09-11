import { test, expect } from "bun:test";
import { buildPreview } from "./preview.js";
import type { PluginManifest } from "../types.js";

test("buildPreview: rules → install phase, sops → compile phase", () => {
  const manifest = {
    name: "test-plugin",
    version: "1.0.0",
    targets: {
      rules: ["claude-code"],
      sops: ["claude-code"],
    },
  } as unknown as PluginManifest;

  const preview = buildPreview(manifest);

  const rulesRow = preview.rows.find((r) => r.noun === "rules");
  const sopsRow = preview.rows.find((r) => r.noun === "sops");

  expect(rulesRow).toBeDefined();
  expect(rulesRow?.phase).toBe("install");
  expect(rulesRow?.compileManaged).toBe(false);

  expect(sopsRow).toBeDefined();
  expect(sopsRow?.phase).toBe("compile");
  expect(sopsRow?.compileManaged).toBe(true);

  expect(typeof preview.targetsSummary).toBe("string");
  expect(preview.targetsSummary.length).toBeGreaterThan(0);
});
