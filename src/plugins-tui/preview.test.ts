import { test, expect } from "bun:test";
import { buildPreview } from "./preview.js";
import type { PluginManifest } from "../types.js";

test("buildPreview: rules → install phase, orbits → compile phase", () => {
  const manifest = {
    name: "test-plugin",
    version: "1.0.0",
    targets: {
      rules: ["claude-code"],
      orbits: ["claude-code"],
    },
  } as unknown as PluginManifest;

  const preview = buildPreview(manifest);

  const rulesRow = preview.rows.find((r) => r.noun === "rules");
  const orbitsRow = preview.rows.find((r) => r.noun === "orbits");

  expect(rulesRow).toBeDefined();
  expect(rulesRow?.phase).toBe("install");
  expect(rulesRow?.compileManaged).toBe(false);

  expect(orbitsRow).toBeDefined();
  expect(orbitsRow?.phase).toBe("compile");
  expect(orbitsRow?.compileManaged).toBe(true);

  expect(typeof preview.targetsSummary).toBe("string");
  expect(preview.targetsSummary.length).toBeGreaterThan(0);
});
