import { readFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface Target {
  readonly platform: "darwin" | "linux";
  readonly arch: "x64" | "arm64";
}

export const repoRoot = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  readonly version: string;
};
const schemaBridgeSource = readFileSync(
  join(repoRoot, "src", "compile", "runtime", "schema-bridge.ts"),
  "utf8",
);
const astToJsonSchemaSource = readFileSync(
  join(repoRoot, "src", "ast-to-json-schema.ts"),
  "utf8",
);
const workflowDslRuntimeSources = JSON.stringify({
  "jev.ts": readFileSync(join(repoRoot, "src", "jev.ts"), "utf8"),
  "workflows.ts": readFileSync(join(repoRoot, "src", "workflows.ts"), "utf8"),
  "workflow-errors.ts": readFileSync(join(repoRoot, "src", "workflow-errors.ts"), "utf8"),
} satisfies Record<string, string>);

export const version = packageJson.version;

export const targetLabel = (target: Target): string => `${target.platform}-${target.arch}`;

export async function compile(target: Target, outfile: string): Promise<void> {
  const result = await Bun.build({
    target: "bun",
    compile: {
      target: `bun-${target.platform}-${target.arch}`,
      outfile,
    },
    entrypoints: [join(repoRoot, "src", "cli.ts")],
    define: {
      APP_VERSION: JSON.stringify(version),
      SCHEMA_BRIDGE_SOURCE: JSON.stringify(schemaBridgeSource),
      AST_TO_JSON_SCHEMA_SOURCE: JSON.stringify(astToJsonSchemaSource),
      WORKFLOW_DSL_RUNTIME_SOURCES: JSON.stringify(workflowDslRuntimeSources),
    },
    minify: true,
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Failed to build ${targetLabel(target)}`);
  }

  await chmod(outfile, 0o755);

  if (target.platform === "darwin" && process.platform === "darwin") {
    await Bun.$`codesign --remove-signature ${outfile}`.nothrow().quiet();
    await Bun.$`codesign --sign - --force ${outfile}`.quiet();
  }
}
