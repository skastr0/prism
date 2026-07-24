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