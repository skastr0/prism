import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportWorkflowWorkers,
  installWorkflowWorkersFromFiles,
  listWorkflowWorkers,
  projectNamedWorkerRefs,
} from "./workers-cli.js";
import { renderWorkflowWorkersModule } from "../workflow-named-workers.js";
import { Effect, Exit } from "effect";

const tempRoots: string[] = [];
const createHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "prism-workers-cli-"));
  tempRoots.push(home);
  return home;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const portableCatalog = {
  version: 1,
  workers: [
    {
      name: "reviewer",
      description: "Careful code review; low risk tolerance.",
      config: { worker: "claude-code", permission: "restricted", restrictedTools: ["Read", "Grep"] },
    },
    {
      name: "fast-iteration",
      description: "Cheap bulk iteration; verify with typecheck.",
      config: { worker: "amp-code", catalogModel: "anthropic/claude-haiku-4-5-20251001" },
    },
  ],
};

const writeCatalog = (root: string, catalog: unknown, name = "workers.json"): string => {
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(catalog, null, 2));
  return path;
};

const runEffect = async <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect);

describe("listWorkflowWorkers", () => {
  test("empty home yields an empty catalog with paths", async () => {
    const prismHome = createHome();
    const exit = await runEffect(listWorkflowWorkers(prismHome));
    if (Exit.isFailure(exit)) throw exit.cause;
    expect(exit.value.catalog.workers).toEqual([]);
    expect(exit.value.catalogPath).toContain(join("state", "workflow-workers", "catalog.json"));
    expect(exit.value.modulePath).toContain("workers.ts");
    expect(exit.value.human).toContain("No named workers installed");
    expect(exit.value.human).toContain("Raw worker configurations remain available");
    expect(JSON.parse(exit.value.json)).toEqual({ version: 1, workers: [] });
  });

  test("installed entries render names, refs, descriptions, and configs", async () => {
    const prismHome = createHome();
    const source = writeCatalog(prismHome, portableCatalog);
    const installed = await runEffect(installWorkflowWorkersFromFiles(prismHome, [source]));
    if (Exit.isFailure(installed)) throw installed.cause;
    expect(installed.value.human).toContain("Installed 2 named workers");
    expect(installed.value.human).toContain("replaced any previously installed catalog");

    const listed = await runEffect(listWorkflowWorkers(prismHome));
    if (Exit.isFailure(listed)) throw listed.cause;
    expect(listed.value.human).toContain("`workers.reviewer` — Careful code review");
    expect(listed.value.human).toContain('"worker":"claude-code"');
    const parsed = JSON.parse(listed.value.json);
    expect(parsed).toEqual(portableCatalog);
  });
});

describe("installWorkflowWorkersFromFiles", () => {
  test("replaces the previous catalog and regenerates the module", async () => {
    const prismHome = createHome();
    const first = writeCatalog(prismHome, portableCatalog, "first.json");
    const second = writeCatalog(prismHome, {
      version: 1,
      workers: [{ name: "solo", description: "Single replacement worker.", config: { worker: "codex-cli" } }],
    }, "second.json");

    await runEffect(installWorkflowWorkersFromFiles(prismHome, [first]));
    const replaced = await runEffect(installWorkflowWorkersFromFiles(prismHome, [second]));
    if (Exit.isFailure(replaced)) throw replaced.cause;
    expect(replaced.value.catalog.workers.map((worker) => worker.name)).toEqual(["solo"]);

    const listed = await runEffect(listWorkflowWorkers(prismHome));
    if (Exit.isFailure(listed)) throw listed.cause;
    expect(listed.value.catalog.workers.map((worker) => worker.name)).toEqual(["solo"]);
    expect(await import("node:fs/promises").then((fs) => fs.readFile(listed.value.modulePath, "utf8")))
      .toBe(renderWorkflowWorkersModule(listed.value.catalog));
  });

  test("multiple files merge by unique name and reject duplicates", async () => {
    const prismHome = createHome();
    const a = writeCatalog(prismHome, {
      version: 1,
      workers: [{ name: "reviewer", description: "Reviewer.", config: { worker: "claude-code" } }],
    }, "a.json");
    const b = writeCatalog(prismHome, {
      version: 1,
      workers: [{ name: "scout", description: "Scout.", config: { worker: "cursor" } }],
    }, "b.json");

    const merged = await runEffect(installWorkflowWorkersFromFiles(prismHome, [a, b]));
    if (Exit.isFailure(merged)) throw merged.cause;
    expect(merged.value.catalog.workers.map(({ name }) => name)).toEqual(["reviewer", "scout"]);

    writeCatalog(prismHome, {
      version: 1,
      workers: [{ name: "reviewer", description: "Duplicate name.", config: { worker: "grok" } }],
    }, "b.json");
    const duplicate = await runEffect(installWorkflowWorkersFromFiles(prismHome, [a, b]));
    expect(Exit.isFailure(duplicate)).toBe(true);
    const preserved = await Effect.runPromise(listWorkflowWorkers(prismHome));
    expect(preserved.catalog).toEqual(merged.value.catalog);
  });

  test("bad names, unsupported pins, and missing files fail closed", async () => {
    const prismHome = createHome();
    const badName = writeCatalog(prismHome, {
      version: 1,
      workers: [{ name: "Reviewer", description: "Bad.", config: { worker: "claude-code" } }],
    }, "bad-name.json");
    expect(Exit.isFailure(await runEffect(installWorkflowWorkersFromFiles(prismHome, [badName])))).toBe(true);

    const badPermission = writeCatalog(prismHome, {
      version: 1,
      workers: [{ name: "loose", description: "Bad pin.", config: { worker: "claude-code", permission: "sandbox-read-only" } }],
    }, "bad-permission.json");
    expect(Exit.isFailure(await runEffect(installWorkflowWorkersFromFiles(prismHome, [badPermission])))).toBe(true);

    const missing = join(prismHome, "does-not-exist.json");
    const missingExit = await runEffect(installWorkflowWorkersFromFiles(prismHome, [missing]));
    expect(Exit.isFailure(missingExit)).toBe(true);
  });
});

describe("export and projections", () => {
  test("export prints the portable JSON without touching the source file", async () => {
    const prismHome = createHome();
    const source = writeCatalog(prismHome, portableCatalog);
    const originalSource = readFileSync(source, "utf8");
    await runEffect(installWorkflowWorkersFromFiles(prismHome, [source]));
    const exported = await runEffect(exportWorkflowWorkers(prismHome));
    if (Exit.isFailure(exported)) throw exported.cause;
    // Portable semantics, not byte layout: decode both sides before comparing.
    const roundTripped = JSON.parse(exported.value.json) as typeof portableCatalog;
    expect(roundTripped).toEqual(portableCatalog);
    expect(readFileSync(source, "utf8")).toBe(originalSource);
  });

  test("projectNamedWorkerRefs emits generated refs for every name", async () => {
    const prismHome = createHome();
    const source = writeCatalog(prismHome, {
      version: 1,
      workers: [
        ...portableCatalog.workers,
        { name: "deep-review", description: "Escalation reviewer.", config: { worker: "grok" } },
      ],
    });
    await runEffect(installWorkflowWorkersFromFiles(prismHome, [source]));
    const listed = await runEffect(listWorkflowWorkers(prismHome));
    if (Exit.isFailure(listed)) throw listed.cause;
    expect(projectNamedWorkerRefs(listed.value.catalog).map((entry) => entry.ref)).toEqual([
      "workers.reviewer",
      'workers["fast-iteration"]',
      'workers["deep-review"]',
    ]);
  });
});
