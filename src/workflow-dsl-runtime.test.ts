import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { anonymousWorkflowAgent } from "./workflows.js";

/** Public workflow DSL names the runtime stub must re-export (one representation). */
const WORKFLOW_DSL_RUNTIME_EXPORTS = [
  "anonymousWorkflowAgent",
  "defineTask",
  "defineWorkflow",
  "decodeTaskOutput",
] as const;

test("workflow DSL runtime stub exports the same builders as workflows.ts", async () => {
  const load = await readFile(join(import.meta.dir, "compile/load.ts"), "utf8");
  const workflows = await readFile(join(import.meta.dir, "workflows.ts"), "utf8");
  for (const name of WORKFLOW_DSL_RUNTIME_EXPORTS) {
    const exportPattern = new RegExp(String.raw`export (?:const|function) ${name}`);
    expect(load).toMatch(exportPattern);
    expect(workflows).toMatch(exportPattern);
  }
  expect(anonymousWorkflowAgent).toMatchObject({
    kind: "agent-ref",
    plugin: "prism",
    name: "anonymous",
  });
  expect(load).toContain('name: "anonymous"');
  expect(load).toContain('plugin: "prism"');
});
