import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildWorkflowPaths,
  buildWorkflowRefsPaths,
  WORKFLOW_REFS_MODULES,
} from "./workflow-tsconfig.js";

describe("workflow tsconfig paths", () => {
  test("maps every generated prism/refs module", () => {
    const refsDir = "/tmp/prism-generated";
    const paths = buildWorkflowRefsPaths(refsDir);

    expect(paths["prism/refs"]).toEqual([join(refsDir, "agents.ts")]);
    for (const module of WORKFLOW_REFS_MODULES) {
      expect(paths[`prism/refs/${module}`]).toEqual([join(refsDir, `${module}.ts`)]);
    }
  });

  test("merges refs paths into the full workflow path map", () => {
    const paths = buildWorkflowPaths({
      typeDirs: {
        prismTypesDir: "/tmp/prism-types",
        effectDtsDir: "/tmp/effect-dts",
      },
      refsDir: "/tmp/generated",
    });

    expect(paths["prism"]).toEqual(["/tmp/prism-types/index.d.ts"]);
    expect(paths["effect"]).toEqual(["/tmp/effect-dts/index.d.ts"]);
    expect(paths["prism/refs/tools"]).toEqual(["/tmp/generated/tools.ts"]);
  });
});