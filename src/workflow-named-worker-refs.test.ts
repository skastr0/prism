/**
 * Generated typed named-worker refs: `prism/refs/workers`.
 *
 * Covers the load/typecheck integration contract:
 * - the generated global module is literal-typed (`as const satisfies`) and
 *   never a string-indexed `any`;
 * - the transparent typecheck and the runtime import rewriting both see the
 *   exact current installed refs after same-process install/update/removal;
 * - installed data only — the runtime never reads catalog source from the
 *   user's repository;
 * - plugin-free use (no generated sops.ts) still typechecks.
 *
 * Type-level tests require the emitted prism declarations (dist/dts-tmp, built
 * by `bun run test:ci`) and are skipped when that artifact is absent.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { prepareImportWrapper } from "./compile/load.js";
import { writeHarnessTypesSnapshot } from "./harness-types.js";
import { resolvePrismHome } from "./prism-home.js";
import {
  ensureWorkflowWorkersModule,
  installWorkflowWorkerCatalog,
  loadWorkflowWorkerCatalog,
  workflowWorkerCatalogPath,
  workflowWorkersModulePath,
} from "./workflow-named-workers.js";
import { loadWorkflowFile } from "./workflow-loader.js";
import { resolveWorkflowTypeDirs, buildWorkflowPaths, workflowTsconfigPath } from "./workflow-tsconfig.js";
import {
  runWorkflowTypecheck,
  typecheckWorkflowFile,
  WorkflowTypecheckError,
} from "./workflow-typecheck.js";

const typeSurfaceAvailable = resolveWorkflowTypeDirs().prismTypesDir !== undefined;

const tempRoots: string[] = [];
const createTempRoot = (explicit?: string): string => {
  const root = explicit ?? join(tmpdir(), `prism-named-worker-refs-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
};

afterAll(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

interface CatalogWorkerFixture {
  readonly name: string;
  readonly description: string;
  readonly config: Record<string, unknown>;
}

const writeCatalogSource = (dir: string, workers: readonly CatalogWorkerFixture[]): string => {
  const path = join(dir, "workers.json");
  writeFileSync(path, `${JSON.stringify({ version: 1, workers }, null, 2)}\n`);
  return path;
};

/** Install through the real Effect API; the repo-side source file is deleted right after. */
const installCatalog = async (prismHome: string, sourceDir: string, workers: readonly CatalogWorkerFixture[]): Promise<void> => {
  const source = writeCatalogSource(sourceDir, workers);
  await Effect.runPromise(installWorkflowWorkerCatalog(prismHome, [source]));
  rmSync(source);
};

const claudeCatalogWorker = (name: string, model: string): CatalogWorkerFixture => ({
  name,
  description: `Reviews changes as ${name}`,
  config: { worker: "claude-code", model, permission: "permissive" },
});

const writeWorkflow = (dir: string, name: string, workerAccess: string): string => {
  const path = join(dir, `${name}.workflow.ts`);
  writeFileSync(path, `import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";
import { workers } from "prism/refs/workers";

export const workflow = defineWorkflow({
  name: "typed-workers",
  tasks: [
    defineTask({
      id: "review",
      prompt: "Review the change",
      output: Schema.String,
      worker: ${workerAccess},
    }),
  ],
});
`);
  return path;
};

const rawDslWorkflowPath = (dir: string): string => {
  const path = join(dir, "raw.workflow.ts");
  writeFileSync(path, `import { Schema } from "effect";
import { defineTask, defineWorkflow } from "prism";

export const workflow = defineWorkflow({
  name: "raw-workers",
  tasks: [
    defineTask({
      id: "review",
      prompt: "Review the change",
      output: Schema.String,
      worker: { worker: "claude-code", model: "sonnet-4-5", permission: "permissive" },
    }),
  ],
});
`);
  return path;
};

const loadedTaskWorker = (workflow: { readonly tasks: ReadonlyArray<unknown> }): unknown => {
  const first: unknown = workflow.tasks[0];
  return (first as { readonly worker?: unknown } | undefined)?.worker;
};

const typecheckFails = (filePath: string, prismHome: string): boolean => {
  try {
    typecheckWorkflowFile(filePath, { prismHome });
    return false;
  } catch (error) {
    return error instanceof WorkflowTypecheckError;
  }
};

describe("named worker refs", () => {
  test("buildWorkflowPaths maps prism/refs/workers to the generated global module", () => {
    const paths = buildWorkflowPaths({
      typeDirs: { prismTypesDir: "/tmp/prism-types", effectDtsDir: "/tmp/effect-dts" },
      workersModulePath: "/tmp/home/state/workflow-workers/workers.ts",
    });
    expect(paths["prism/refs/workers"]).toEqual(["/tmp/home/state/workflow-workers/workers.ts"]);
    expect(paths["prism/refs"]).toBeUndefined();
  });

  test("ensure regenerates the exact installed refs and never reads user-repo source", async () => {
    const home = createTempRoot();
    const sourceDir = createTempRoot();
    const modulePath = workflowWorkersModulePath(home);

    // No catalog installed: an empty literal module is still generated.
    expect((await Effect.runPromise(loadWorkflowWorkerCatalog(home))).workers).toEqual([]);
    await Effect.runPromise(ensureWorkflowWorkersModule(home));
    expect(readFileSync(modulePath, "utf8")).toContain(
      "} as const satisfies Record<string, WorkflowTaskWorkerOptions>;",
    );
    expect(readFileSync(modulePath, "utf8")).not.toContain('"reviewer"');

    await installCatalog(home, sourceDir, [claudeCatalogWorker("reviewer", "sonnet-4-5")]);
    expect(readFileSync(workflowWorkerCatalogPath(home), "utf8")).toContain('"reviewer"');
    expect(readFileSync(modulePath, "utf8")).toContain('import type { WorkflowTaskWorkerOptions } from "prism";');
    expect(readFileSync(modulePath, "utf8")).toContain('"reviewer"');

    // A source file reappearing in the user's repo must not influence the
    // generated module: installed truth only.
    writeCatalogSource(home, [claudeCatalogWorker("impostor", "opus-4-1")]);
    await Effect.runPromise(ensureWorkflowWorkersModule(home));
    expect(readFileSync(modulePath, "utf8")).toContain('"reviewer"');
    expect(readFileSync(modulePath, "utf8")).not.toContain("impostor");
    rmSync(join(home, "workers.json"));
  });

  test("same-process install, update, and removal reload the exact current refs", async () => {
    const home = createTempRoot();
    const sourceDir = createTempRoot();
    const dir = createTempRoot();
    const reviewerFile = writeWorkflow(dir, "reviewer", "workers.reviewer");
    const authorFile = writeWorkflow(dir, "author", "workers.author");

    await installCatalog(home, sourceDir, [claudeCatalogWorker("reviewer", "sonnet-4-5")]);
    const loaded = await loadWorkflowFile(reviewerFile, { prismHome: home });
    expect(loaded.name).toBe("typed-workers");
    expect(loadedTaskWorker(loaded)).toEqual({
      worker: "claude-code",
      model: "sonnet-4-5",
      permission: "permissive",
    });

    // Update: reviewer is gone, author takes its place; both files must see the
    // exact current refs, not a cached earlier generation.
    await installCatalog(home, sourceDir, [claudeCatalogWorker("author", "opus-4-1")]);
    const moduleText = readFileSync(workflowWorkersModulePath(home), "utf8");
    expect(moduleText).toContain('"author"');
    expect(moduleText).not.toContain('"reviewer"');
    const reloaded = await loadWorkflowFile(authorFile, { prismHome: home });
    expect(loadedTaskWorker(reloaded)).toEqual({
      worker: "claude-code",
      model: "opus-4-1",
      permission: "permissive",
    });
    expect(typecheckFails(reviewerFile, home)).toBe(true);

    // Removal: no installed catalog means the refs object is empty again.
    rmSync(workflowWorkerCatalogPath(home));
    let removalError: unknown;
    try {
      await loadWorkflowFile(authorFile, { prismHome: home });
    } catch (error) {
      removalError = error;
    }
    expect(removalError).toBeInstanceOf(WorkflowTypecheckError);
    expect(readFileSync(workflowWorkersModulePath(home), "utf8")).toContain(
      "} as const satisfies Record<string, WorkflowTaskWorkerOptions>;",
    );
  }, 30_000);

  test("runtime import rewriting targets the content-hashed generated workers module", async () => {
    // A home path with spaces proves the JSON-quoted plain-path target imports.
    const home = createTempRoot(`${tmpdir()}/prism named workers ${Math.random().toString(16).slice(2)}`);
    const sourceDir = createTempRoot();
    const dir = createTempRoot();
    await installCatalog(home, sourceDir, [claudeCatalogWorker("reviewer", "sonnet-4-5")]);
    const sourcePath = writeWorkflow(dir, "plain", "workers.reviewer");
    const wrapper = await prepareImportWrapper(sourcePath, { workflow: true, prismHome: home });
    try {
      const rewritten = readFileSync(wrapper.transformedPath, "utf8");
      expect(rewritten).toContain(`${workflowWorkersModulePath(home)}?hash=`);
      // Only the workers specifier is a plain path; the prism/effect runtime
      // targets stay file:// URLs by design.
      const rewrittenLine = rewritten.split("\n").find((line) => line.includes("workers.ts?hash="));
      expect(rewrittenLine).toBeDefined();
      expect(rewrittenLine).not.toContain("file://");
      // The spaced path is embedded as a valid string literal.
      const specifier = /"([^"]+)"/.exec(rewrittenLine!)?.[1];
      expect(specifier?.startsWith(workflowWorkersModulePath(home))).toBe(true);
    } finally {
      await wrapper.cleanup();
    }
  });

  test("raw DSL worker options still typecheck and load without named workers", async () => {
    const home = createTempRoot();
    const dir = createTempRoot();
    const file = rawDslWorkflowPath(dir);
    typecheckWorkflowFile(file, { prismHome: home });
    const loaded = await loadWorkflowFile(file, { prismHome: home });
    expect(loadedTaskWorker(loaded)).toEqual({
      worker: "claude-code",
      model: "sonnet-4-5",
      permission: "permissive",
    });
  }, 30_000);
});

describe.skipIf(!typeSurfaceAvailable)("generated named-worker type checking", () => {
  let home = "";
  let dir = "";
  let sourceDir = "";

  beforeAll(async () => {
    home = createTempRoot();
    dir = createTempRoot();
    sourceDir = createTempRoot();
    // Literal model unions come from the same production harness-types module
    // renderer `prism workflow refresh-harness-types` uses.
    writeHarnessTypesSnapshot(home, {
      generatedAt: new Date(0).toISOString(),
      harnesses: [
        {
          harness: "claude-code",
          models: [{ id: "sonnet-4-5" }, { id: "opus-4-1" }],
          source: "static",
        },
      ],
    });
    await installCatalog(home, sourceDir, [claudeCatalogWorker("reviewer", "sonnet-4-5")]);
    writeWorkflow(dir, "valid", "workers.reviewer");
    writeWorkflow(dir, "unknown-worker", "workers.nope");
    writeWorkflow(dir, "unknown-model", '{ ...workers.reviewer, model: "not-a-real-slug" }');
    writeWorkflow(dir, "string-index", 'workers["no-such-worker"]');
  });

  test("workers.reviewer carries literal worker/model types and works plugin-free", () => {
    expect(() => typecheckWorkflowFile(join(dir, "valid.workflow.ts"), { prismHome: home })).not.toThrow();
    // Plugin-free: no project-generated sops.ts is required for workers refs.
    expect(existsSync(join(home, "state", "projects"))).toBe(false);
  });

  test("unknown worker names and string-index access are type errors, not any", () => {
    expect(() => typecheckWorkflowFile(join(dir, "unknown-worker.workflow.ts"), { prismHome: home }))
      .toThrow(/nope/);
    expect(() => typecheckWorkflowFile(join(dir, "string-index.workflow.ts"), { prismHome: home }))
      .toThrow(/can't be used to index type/);
  });

  test("model literals must match the harness model union", () => {
    expect(() => typecheckWorkflowFile(join(dir, "unknown-model.workflow.ts"), { prismHome: home }))
      .toThrow(/not-a-real-slug/);
  });

  test("generated module passes program-scope typecheck under the generated tsconfig", async () => {
    const result = await runWorkflowTypecheck(join(dir, "valid.workflow.ts"), { prismHome: home });
    expect(result.tsconfigPath).toBe(workflowTsconfigPath(home));
    expect(existsSync(resolvePrismHome(home))).toBe(true);
  });
});
