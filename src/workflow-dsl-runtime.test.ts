import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkflowDslRuntimeSources } from "./compile/embedded-runtime-sources.js";

test("workflow DSL runtime re-exports the vendored canonical modules (no hand-written stub)", async () => {
  const load = await readFile(join(import.meta.dir, "compile/load.ts"), "utf8");

  // The runtime module is generated from the vendored sources, so off-repo
  // `import ... from "prism"` can never drift from src/workflows.ts + src/jev.ts.
  expect(load).toContain(`export * from "./prism-runtime/workflows.ts";`);
  expect(load).toContain(`export * from "./prism-runtime/jev.ts";`);
  expect(load).not.toContain("const WORKFLOW_DSL_RUNTIME_JS");

  // Vendored sources share the binary's Effect instance via the bridge rewrite.
  expect(load).toContain("getWorkflowDslRuntimeSources");
  expect(load).toContain(String.raw`(\bfrom\s*)["']effect["']`);
});

test("vendored DSL sources cover the runtime re-export modules", () => {
  const sources = getWorkflowDslRuntimeSources();
  expect(sources["workflows.ts"]).toContain(`export const jev =`);
  expect(sources["jev.ts"]).toContain(`export function noul`);
  // workflows.ts references its two vendored siblings by specifier.
  expect(sources["workflows.ts"]).toContain(`from "./workflow-errors.js"`);
  expect(sources["workflows.ts"]).toContain(`from "./jev.js"`);
});
