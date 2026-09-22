import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { buildClaudeArgs } from "./workflow-claude-worker.js";
import { buildOmpArgs } from "./workflow-omp-worker.js";
import { defineTask, type WorkflowTaskWorkerOptions } from "./workflows.js";
import { workflowTaskIdentity } from "./workflow-identity.js";
import {
  WorkflowWorkerCatalogError,
  decodeWorkflowWorkerCatalog,
  ensureWorkflowWorkersModule,
  installWorkflowWorkerCatalog,
  loadWorkflowWorkerCatalog,
  renderWorkflowWorkersModule,
  workflowWorkerCatalogPath,
  workflowWorkersModulePath,
} from "./workflow-named-workers.js";

const PatchReport = Schema.Struct({ summary: Schema.String });
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-named-workers-"));
  roots.push(root);
  return root;
};

const catalogFile = async (root: string, name: string, value: unknown): Promise<string> => {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
};

const worker = (
  name: string,
  config: Record<string, unknown>,
  description = `${name} does review work`,
) => ({ name, description, config });

const readInstalled = async (home: string): Promise<string> =>
  await Bun.file(workflowWorkerCatalogPath(home)).text();

const readModule = async (home: string): Promise<string> =>
  await Bun.file(workflowWorkersModulePath(home)).text();

const expectTypedFailure = async (effect: Effect.Effect<unknown, WorkflowWorkerCatalogError>): Promise<WorkflowWorkerCatalogError> => {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected a typed catalog failure");
  expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(false);
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(WorkflowWorkerCatalogError);
  expect(error._tag).toBe("WorkflowWorkerCatalogError");
  return error;
};

const taskFor = (worker: WorkflowTaskWorkerOptions) => defineTask({
  id: "review",
  prompt: "Review the diff.",
  output: PatchReport,
  worker,
});

describe("named workflow worker catalogs", () => {
  test("keeps two names on the same harness and round-trips without machine paths", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const source = await catalogFile(root, "workers.json", {
      version: 1,
      workers: [
        worker("reviewer", { worker: "claude-code", model: "claude-opus", permission: "restricted", restrictedTools: ["Read"] }),
        worker("editor", { worker: "claude-code", model: "claude-sonnet", sessionPersistence: "ephemeral" }, "edits after review"),
      ],
    });

    const installed = await Effect.runPromise(installWorkflowWorkerCatalog(home, [source]));

    expect(installed.workers.map((entry) => entry.name)).toEqual(["reviewer", "editor"]);
    expect(installed.workers.every((entry) => entry.config.worker === "claude-code")).toBe(true);
    const onDisk = decodeWorkflowWorkerCatalog(JSON.parse(await readInstalled(home)));
    expect(onDisk).toEqual(installed);
    expect(JSON.stringify(onDisk)).not.toContain(root);
    expect(JSON.stringify(onDisk)).not.toMatch(/HOME|API_KEY|SECRET|TOKEN/u);

    const exported = decodeWorkflowWorkerCatalog(JSON.parse(JSON.stringify(installed)));
    expect(exported).toEqual(installed);
  });

  test("rejects a duplicate name across files before replacing the previous install", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const first = await catalogFile(root, "first.json", {
      version: 1,
      workers: [worker("reviewer", { worker: "grok", model: "grok-4" })],
    });
    await Effect.runPromise(installWorkflowWorkerCatalog(home, [first]));
    const previous = await readInstalled(home);
    const previousModule = await readModule(home);

    const left = await catalogFile(root, "left.json", {
      version: 1,
      workers: [worker("reviewer", { worker: "claude-code", model: "opus" })],
    });
    const right = await catalogFile(root, "right.json", {
      version: 1,
      workers: [worker("reviewer", { worker: "codex-cli", model: "gpt-5" })],
    });
    const error = await expectTypedFailure(installWorkflowWorkerCatalog(home, [left, right]));

    expect(error.message).toContain("reviewer");
    expect(await readInstalled(home)).toBe(previous);
    expect(await readModule(home)).toBe(previousModule);
  });

  test("rejects a duplicate name inside one file", async () => {
    const root = await tempRoot();
    const source = await catalogFile(root, "dup.json", {
      version: 1,
      workers: [
        worker("reviewer", { worker: "grok" }),
        worker("reviewer", { worker: "hermes" }),
      ],
    });

    const error = await expectTypedFailure(installWorkflowWorkerCatalog(join(root, "home"), [source]));
    expect(error.message).toContain("reviewer");
    expect(await Bun.file(workflowWorkerCatalogPath(join(root, "home"))).exists()).toBe(false);
  });

  test("rejects unknown fields instead of dropping them", () => {
    expect(() => decodeWorkflowWorkerCatalog({
      version: 1,
      workers: [worker("reviewer", { worker: "grok", model: "grok-4", secret: "do-not-keep" })],
    })).toThrow(/secret|excess|unexpected/iu);
    expect(() => decodeWorkflowWorkerCatalog({
      version: 1,
      workers: [worker("reviewer", { worker: "claude-code", effort: "high" })],
    })).toThrow(/effort|excess|unexpected/iu);
  });

  test("rejects invalid permission, session persistence, blank name, and missing worker", () => {
    const cases: Array<readonly [string, unknown]> = [
      ["amp restricted", worker("reviewer", { worker: "amp-code", permission: "restricted" })],
      ["grok session", worker("reviewer", { worker: "grok", sessionPersistence: "persistent" })],
      ["blank name", { name: "  ", description: "blank", config: { worker: "grok" } }],
      ["missing worker", worker("reviewer", { model: "grok-4" })],
      ["bad retry", worker("reviewer", { worker: "grok", retry: { maxAttempts: 0 } })],
      ["uppercase name", worker("Reviewer", { worker: "grok" })],
    ];
    for (const [label, input] of cases) {
      expect(() => decodeWorkflowWorkerCatalog({ version: 1, workers: [input] }), label).toThrow();
    }
  });

  test("accepts the DSL permission for devin and omp restricted workers", () => {
    const devin = decodeWorkflowWorkerCatalog({
      version: 1,
      workers: [worker("reviewer", { worker: "devin", permission: "restricted" })],
    });
    const omp = decodeWorkflowWorkerCatalog({
      version: 1,
      workers: [worker("reviewer", { worker: "omp", permission: "restricted", restrictedTools: ["read"] })],
    });
    expect(devin.workers[0]?.config).toEqual({ worker: "devin", permission: "restricted" });
    expect(omp.workers[0]?.config).toEqual({
      worker: "omp",
      permission: "restricted",
      restrictedTools: ["read"],
    });
  });

  test("accepts a modelspace profile ref and preserves target variant and provider", () => {
    const catalog = decodeWorkflowWorkerCatalog({
      version: 1,
      workers: [worker("reviewer", {
        worker: "codex-cli",
        model: {
          kind: "model-profile-ref",
          plugin: "local",
          modelspace: "defaults",
          profile: "fast",
          targets: { "codex-cli": { model: "gpt-5", variant: "low", provider: "openai" } },
        },
      })],
    });
    expect(catalog.workers[0]?.config.model).toEqual({
      kind: "model-profile-ref",
      plugin: "local",
      modelspace: "defaults",
      profile: "fast",
      targets: { "codex-cli": { model: "gpt-5", variant: "low", provider: "openai" } },
    });
  });

  test("keeps a hostile description out of generated code", () => {
    const catalog = decodeWorkflowWorkerCatalog({
      version: 1,
      workers: [worker(
        "reviewer",
        { worker: "claude-code", model: "opus" },
        "closes */\nexport const stolen = process.env.HOME; /*",
      )],
    });
    const source = renderWorkflowWorkersModule(catalog);

    expect(source).toContain('import type { WorkflowTaskWorkerOptions } from "prism";');
    expect(source).not.toMatch(/\*\/\s*export const stolen/u);
    expect(source).toContain("* / export const stolen = process.env.HOME");
    expect(source).toContain('"reviewer": {"model":"opus","worker":"claude-code"}');
    const statements = source.split("\n").filter((line) => line.startsWith("export const "));
    expect(statements).toEqual(["export const workers = {"]);
  });

  test("reloads from the installed catalog after the source file is deleted", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const source = await catalogFile(root, "portable.json", {
      version: 1,
      workers: [worker("reviewer-2", { worker: "omp", model: "model-a", permission: "restricted", restrictedTools: ["read"] })],
    });
    await Effect.runPromise(installWorkflowWorkerCatalog(home, [source]));
    await rm(source);

    const loaded = await Effect.runPromise(loadWorkflowWorkerCatalog(home));
    const modulePath = await Effect.runPromise(ensureWorkflowWorkersModule(home));

    expect(loaded.workers).toEqual([{
      name: "reviewer-2",
      description: "reviewer-2 does review work",
      config: { worker: "omp", model: "model-a", permission: "restricted", restrictedTools: ["read"] },
    }]);
    expect(modulePath).toBe(workflowWorkersModulePath(home));
    const generated = await readModule(home);
    expect(generated).toContain('"reviewer-2":');
    expect(generated).toContain("as const satisfies Record<string, WorkflowTaskWorkerOptions>");
    expect(generated).not.toContain(source);
  });

  test("does not rewrite an unchanged generated module", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const source = await catalogFile(root, "stable.json", {
      version: 1,
      workers: [worker("reviewer", { worker: "hermes", profile: "default" })],
    });
    await Effect.runPromise(installWorkflowWorkerCatalog(home, [source]));
    const before = await Bun.file(workflowWorkersModulePath(home)).stat();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await Effect.runPromise(ensureWorkflowWorkersModule(home));
    const after = await Bun.file(workflowWorkersModulePath(home)).stat();

    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("does not treat an unreadable catalog as empty", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const path = workflowWorkerCatalogPath(home);
    await mkdir(join(home, "state", "workflow-workers"), { recursive: true });
    await writeFile(path, '{"version":1,"workers":[]}\n');
    await chmod(path, 0);

    const error = await expectTypedFailure(loadWorkflowWorkerCatalog(home));
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as NodeJS.ErrnoException).code).not.toBe("ENOENT");
  });

  test("returns an empty catalog only when the installed file is absent", async () => {
    const home = join(await tempRoot(), "missing-home");
    const loaded = await Effect.runPromise(loadWorkflowWorkerCatalog(home));
    expect(loaded).toEqual({ version: 1, workers: [] });
  });
});

describe("workflow task identity configuration axes", () => {
  const hash = (worker: WorkflowTaskWorkerOptions) => workflowTaskIdentity("named", taskFor(worker)).promptHash;

  test("separates variant, provider, permission, and restricted tool lists", () => {
    const codex = {
      worker: "codex-cli",
      model: { kind: "model-profile-ref", plugin: "p", modelspace: "m", profile: "fast", targets: { "codex-cli": { model: "gpt-5", variant: "low" } } },
    } as const satisfies WorkflowTaskWorkerOptions;
    const codexHigh = {
      worker: "codex-cli",
      model: { kind: "model-profile-ref", plugin: "p", modelspace: "m", profile: "fast", targets: { "codex-cli": { model: "gpt-5", variant: "high" } } },
    } as const satisfies WorkflowTaskWorkerOptions;
    expect(hash(codex)).not.toBe(hash(codexHigh));

    const hermes = {
      worker: "hermes",
      model: { kind: "model-profile-ref", plugin: "p", modelspace: "m", profile: "x", targets: { hermes: { model: "grok", provider: "xai" } } },
    } as const satisfies WorkflowTaskWorkerOptions;
    const hermesOther = {
      worker: "hermes",
      model: { kind: "model-profile-ref", plugin: "p", modelspace: "m", profile: "x", targets: { hermes: { model: "grok", provider: "openai" } } },
    } as const satisfies WorkflowTaskWorkerOptions;
    expect(hash(hermes)).not.toBe(hash(hermesOther));

    const omp = {
      worker: "omp",
      model: { kind: "model-profile-ref", plugin: "p", modelspace: "m", profile: "x", targets: { omp: { model: "m1", provider: "a", variant: "low" } } },
    } as const satisfies WorkflowTaskWorkerOptions;
    const ompProvider = {
      worker: "omp",
      model: { kind: "model-profile-ref", plugin: "p", modelspace: "m", profile: "x", targets: { omp: { model: "m1", provider: "b", variant: "low" } } },
    } as const satisfies WorkflowTaskWorkerOptions;
    const ompVariant = {
      worker: "omp",
      model: { kind: "model-profile-ref", plugin: "p", modelspace: "m", profile: "x", targets: { omp: { model: "m1", provider: "a", variant: "high" } } },
    } as const satisfies WorkflowTaskWorkerOptions;
    expect(new Set([hash(omp), hash(ompProvider), hash(ompVariant)]).size).toBe(3);

    const permissive = hash({ worker: "claude-code", model: "opus" });
    const explicitPermissive = hash({ worker: "claude-code", model: "opus", permission: "permissive" });
    const legacy = hash({ worker: "claude-code", model: "opus", permission: "legacy" });
    const readOnly = hash({ worker: "claude-code", model: "opus", permission: "restricted", restrictedTools: ["Read"] });
    const edit = hash({ worker: "claude-code", model: "opus", permission: "restricted", restrictedTools: ["Edit"] });
    expect(permissive).toBe(explicitPermissive);
    expect(legacy).not.toBe(permissive);
    expect(readOnly).not.toBe(edit);
    expect(readOnly).not.toBe(permissive);
  });

  test("hashes compiled raw options, not the curated name", () => {
    const raw = { worker: "amp-code", catalogModel: "anthropic/claude", effort: "high" } as const satisfies WorkflowTaskWorkerOptions;
    const otherEffort = { worker: "amp-code", catalogModel: "anthropic/claude", effort: "low" } as const satisfies WorkflowTaskWorkerOptions;
    const unconfigured = { worker: "amp-code", model: "high" } as const satisfies WorkflowTaskWorkerOptions;
    const named = decodeWorkflowWorkerCatalog({
      version: 1,
      workers: [
        worker("reviewer", raw, "reviews with a catalog pin"),
        worker("editor", raw, "same pin, different role */ export const stolen"),
      ],
    });
    const renamed = decodeWorkflowWorkerCatalog({
      version: 1,
      workers: [worker("other-reviewer", raw, "a different description")],
    });

    expect(hash(named.workers[0]!.config)).toBe(hash(raw));
    expect(hash(named.workers[1]!.config)).toBe(hash(raw));
    expect(hash(renamed.workers[0]!.config)).toBe(hash(raw));
    expect(hash(raw)).not.toBe(hash(otherEffort));
    expect(hash(raw)).not.toBe(hash(unconfigured));
  });

  test("ignores a tool list unless permission is restricted", () => {
    const omitted = hash({ worker: "claude-code", model: "opus" });
    const permissive = hash({ worker: "claude-code", model: "opus", permission: "permissive", restrictedTools: ["Bash"] });
    const otherList = hash({ worker: "claude-code", model: "opus", restrictedTools: ["Read"] });
    const restricted = hash({
      worker: "claude-code",
      model: "opus",
      permission: "restricted",
      restrictedTools: ["Bash"],
    });
    const restrictedOther = hash({
      worker: "claude-code",
      model: "opus",
      permission: "restricted",
      restrictedTools: ["Read"],
    });

    expect(permissive).toBe(omitted);
    expect(otherList).toBe(omitted);
    expect(restricted).not.toBe(omitted);
    expect(restricted).not.toBe(restrictedOther);

    const ignored = buildClaudeArgs({ prompt: "p", restrictedTools: ["Bash"] });
    const explicit = buildClaudeArgs({ prompt: "p", permission: "permissive", restrictedTools: ["Read"] });
    const allowed = buildClaudeArgs({ prompt: "p", permission: "restricted", restrictedTools: ["Bash"] });
    expect(ignored).toEqual(explicit);
    expect(ignored.join(" ")).not.toContain("allowedTools");
    expect(allowed).toContain("--allowedTools=Bash");

    const ompIgnored = buildOmpArgs({ cwd: "/", prompt: "p", restrictedTools: ["read"] });
    const ompAllowed = buildOmpArgs({ cwd: "/", prompt: "p", permission: "restricted", restrictedTools: ["read"] });
    expect(ompIgnored.join(" ")).not.toContain("--tools");
    expect(ompAllowed).toContain("--tools");
  });
});
