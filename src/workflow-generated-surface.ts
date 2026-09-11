import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const GENERATED_REF_FILES = ["sops.ts", "models.ts"] as const;

/**
 * Rewrite generated refs so `from "effect"` points at the CLI-embedded Effect
 * runtime. Raw `import()` of `generated/sops.ts` cannot resolve the package
 * from `~/.prism/state` (compiled bun binary).
 */
export const rewriteGeneratedRefsForRuntime = (
  refsDir: string,
  effectRuntimePath: string,
): string => {
  const runtimeDir = join(refsDir, ".runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const effectHref = pathToFileURL(effectRuntimePath).href;
  for (const file of GENERATED_REF_FILES) {
    const sourcePath = join(refsDir, file);
    if (!existsSync(sourcePath)) continue;
    const source = readFileSync(sourcePath, "utf8");
    const rewritten = source.replace(
      /(\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?)(["'])effect\2/g,
      `$1${JSON.stringify(effectHref)}`,
    );
    writeFileSync(join(runtimeDir, file), rewritten, "utf8");
  }
  return runtimeDir;
};

export const generatedRefRuntimePath = (refsDir: string, file: string): string =>
  join(refsDir, ".runtime", file);
