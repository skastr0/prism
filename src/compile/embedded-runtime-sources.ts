import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const AST_TO_JSON_SCHEMA_SOURCE: string | undefined;

const astToJsonSchemaSourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../ast-to-json-schema.ts",
);

/**
 * Returns the canonical ast-to-json-schema module source for MCP bundle
 * mirroring. Compiled prism binaries embed the source via AST_TO_JSON_SCHEMA_SOURCE
 * (see scripts/compile.ts); dev/test fall back to the repo source tree.
 */
export const getAstToJsonSchemaSource = (): string => {
  if (typeof AST_TO_JSON_SCHEMA_SOURCE === "string") {
    return AST_TO_JSON_SCHEMA_SOURCE;
  }
  return readFileSync(astToJsonSchemaSourcePath, "utf8");
};

declare const WORKFLOW_DSL_RUNTIME_SOURCES: string | undefined;

/** The vendored workflow DSL modules, keyed by their path under `prism-runtime/`. */
export type WorkflowDslRuntimeSources = Readonly<Record<
  | "jev.ts"
  | "workflows.ts"
  | "workflow-errors.ts"
  | "workflow-scheduler/cron.ts"
  | "workflow-scheduler/errors.ts"
  | "workflow-scheduler/schedule.ts",
  string
>>;

/**
 * Returns the canonical workflow DSL module sources vendored into the
 * off-repo `prism` runtime (compile/load.ts). Compiled prism binaries embed
 * the sources via WORKFLOW_DSL_RUNTIME_SOURCES (see scripts/compile.ts);
 * dev/test fall back to the repo source tree.
 */
export const getWorkflowDslRuntimeSources = (): WorkflowDslRuntimeSources => {
  if (typeof WORKFLOW_DSL_RUNTIME_SOURCES === "string") {
    return JSON.parse(WORKFLOW_DSL_RUNTIME_SOURCES) as WorkflowDslRuntimeSources;
  }
  const runtimeSourceDir = dirname(fileURLToPath(import.meta.url));
  return {
    "jev.ts": readFileSync(join(runtimeSourceDir, "../jev.ts"), "utf8"),
    "workflows.ts": readFileSync(join(runtimeSourceDir, "../workflows.ts"), "utf8"),
    "workflow-errors.ts": readFileSync(join(runtimeSourceDir, "../workflow-errors.ts"), "utf8"),
    "workflow-scheduler/cron.ts": readFileSync(
      join(runtimeSourceDir, "../workflow-scheduler/cron.ts"),
      "utf8",
    ),
    "workflow-scheduler/errors.ts": readFileSync(
      join(runtimeSourceDir, "../workflow-scheduler/errors.ts"),
      "utf8",
    ),
    "workflow-scheduler/schedule.ts": readFileSync(
      join(runtimeSourceDir, "../workflow-scheduler/schedule.ts"),
      "utf8",
    ),
  };
};
