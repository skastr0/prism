#!/usr/bin/env bun
/**
 * Emit the workflow-authoring type surface as the shipped prism declaration.
 *
 * The emitted declarations are the canonical types for the "prism" virtual
 * specifier. They cover the DSL surface from src/index.ts and src/workflows.ts —
 * defineWorkflow, defineTask, WorkflowAgentRef, WorkflowWorkerId, and the
 * harness-programming ref/builder types.
 *
 * Output: dist/dts-tmp/  (index.d.ts + per-module .d.ts files)
 * Callers (build-npm-cli-packages.ts) copy the directory into platform packages.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

/** Emits declaration files into dist/dts-tmp and returns the root index path. */
export const buildDts = async (): Promise<string> => {
  const tmpOut = join(repoRoot, "dist", "dts-tmp");

  // Clean any prior run.
  await rm(tmpOut, { recursive: true, force: true });
  await mkdir(tmpOut, { recursive: true });

  // Write a focused tsconfig that emits declarations only from the authoring
  // surface. We use `files` to anchor the type graph at the public entry
  // points. The root index intentionally excludes the CLI workflow file loader
  // and generated-tsconfig machinery, so in-memory workflow SDK consumers can
  // import definition and runner helpers without pulling compile/, prism-home,
  // project-key, or TypeScript into their graph.
  const focusedTsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      declaration: true,
      emitDeclarationOnly: true,
      outDir: tmpOut,
      rootDir: join(repoRoot, "src"),
    },
    files: [
      join(repoRoot, "src", "index.ts"),
      join(repoRoot, "src", "workflow-errors.ts"),
      join(repoRoot, "src", "workflows.ts"),
    ],
  };

  const tsconfigPath = join(repoRoot, "dist", "dts-tsconfig.json");
  await Bun.write(tsconfigPath, JSON.stringify(focusedTsconfig, null, 2));

  console.log("Emitting prism declarations (authoring surface)...");

  const proc = Bun.spawn(
    ["node_modules/.bin/tsc", "--project", tsconfigPath],
    {
      cwd: repoRoot,
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`tsc declaration emit failed with exit code ${exitCode}`);
  }

  const emittedIndex = join(tmpOut, "index.d.ts");
  console.log(`Declarations emitted. Root index -> ${emittedIndex}`);
  return emittedIndex;
};

/**
 * Copy the emitted declarations (dist/dts-tmp/) into a platform package's
 * types/ subdirectory so they ship alongside the binary.
 *
 * @param packageDir  Absolute path to the platform package root
 *                    (e.g. packages/npm/prism-darwin-arm64)
 */
export const copyDtsToDir = async (packageDir: string): Promise<void> => {
  const src = join(repoRoot, "dist", "dts-tmp");
  const dest = join(packageDir, "types");
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true });
  console.log(`Copied declarations -> ${dest}`);
};

// Allow direct invocation: bun scripts/build-dts.ts
if (import.meta.main) {
  await buildDts();
}
