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
