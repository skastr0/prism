import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGeneratedSurface } from "./workflow-catalog.js";
import { rewriteGeneratedRefsForRuntime } from "./workflow-generated-surface.js";

describe("rewriteGeneratedRefsForRuntime", () => {
  test("rewrites the effect package import onto a file URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prism-generated-refs-"));
    await writeFile(
      join(dir, "sops.ts"),
      `import { Schema } from "effect";\nexport const sops = {};\n`,
    );
    const effectRuntime = join(dir, "effect-runtime.mjs");
    await writeFile(effectRuntime, "export const Schema = {};\n");
    const runtimeDir = rewriteGeneratedRefsForRuntime(dir, effectRuntime);
    const rewritten = await Bun.file(join(runtimeDir, "sops.ts")).text();
    expect(rewritten).not.toContain('from "effect"');
    expect(rewritten).toContain("effect-runtime.mjs");
  });
});

describe("loadGeneratedSurface", () => {
  test("imports generated sops.ts that depends on effect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prism-load-surface-"));
    await writeFile(
      join(dir, "sops.ts"),
      [
        `import { Schema } from "effect";`,
        `export const sops = {`,
        `  demo: {`,
        `    probe: {`,
        `      plugin: "demo",`,
        `      name: "probe",`,
        `      phases: {`,
        `        start: {`,
        `          name: "start",`,
        `          sop: "probe",`,
        `          plugin: "demo",`,
        `          output: Schema.Struct({ ok: Schema.Boolean }),`,
        `        },`,
        `      },`,
        `    },`,
        `  },`,
        `};`,
        ``,
      ].join("\n"),
    );
    const surface = await loadGeneratedSurface(dir);
    expect(surface).not.toBeNull();
    expect(surface?.sops.demo?.probe?.name).toBe("probe");
    expect(surface?.sops.demo?.probe?.phases?.start?.output).toBeDefined();
  });
});
