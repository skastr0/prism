import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  AgentNameMismatchError,
  AgentValidationError,
  DependencyCycleError,
  DuplicateNameError,
  InvalidTargetScopeError,
  MissingTargetResolutionError,
  OrbitValidationError,
  SourceParseError,
  UnknownDependencyError,
  UnknownReferenceError,
  UnknownTargetError,
  UnsupportedTargetCapabilityError,
} from "./compile/errors.js";
import { executeStandardLowering } from "./compile/lowerers/shared.js";
import {
  BundleBuildError,
  describePrismCause,
  isPrismError,
  LoweringOwnershipError,
  PluginManifestError,
  PRISM_ERROR_TAGS,
  PrismConfigError,
  renderPrismCause,
  renderPrismError,
  type PrismError,
} from "./errors.js";

const STACK_FRAME = /\n\s+at /;

const SAMPLE_ERRORS: ReadonlyArray<PrismError> = [
  new SourceParseError({
    sourcePath: "/plugins/demo/agents/builder.agent.ts",
    kind: "agent",
    message: "unexpected token",
  }),
  new UnknownReferenceError({
    agentName: "builder",
    sourcePath: "/plugins/demo/agents/builder.agent.ts",
    field: "tool",
    referenceName: "submit-work",
  }),
  new OrbitValidationError({
    sourcePath: "/plugins/demo/orbits/forge.orbit.ts",
    orbitName: "forge",
    field: "phases",
    message: "phase list must not be empty",
  }),
  new AgentValidationError({
    sourcePath: "/plugins/demo/agents/builder.agent.ts",
    agentName: "builder",
    field: "traits",
    message: "declares duplicate trait 'demo:alpha'",
  }),
  new UnknownTargetError({
    target: "emacs",
    supportedTargets: ["opencode", "claude-code"],
  }),
  new InvalidTargetScopeError({
    target: "opencode",
    scope: "project",
    message: "project scope requires --project",
  }),
  new UnsupportedTargetCapabilityError({
    target: "cursor",
    capability: "hooks",
    message: "cursor has no hook runtime",
  }),
  new DuplicateNameError({
    kind: "agent",
    name: "builder",
    firstPath: "/plugins/demo/agents/builder.agent.ts",
    secondPath: "/plugins/demo/agents/copy/builder.agent.ts",
  }),
  new AgentNameMismatchError({
    sourcePath: "/plugins/demo/agents/builder.agent.ts",
    fileStem: "builder",
    agentName: "constructor-agent",
  }),
  new MissingTargetResolutionError({
    agentName: "builder",
    referenceKind: "tool",
    referenceName: "submit-work",
    target: "codex-cli",
  }),
  new UnknownDependencyError({
    sourcePath: "/plugins/demo/agents/builder.agent.ts",
    referenceName: "tower:submit",
    depPrefix: "tower",
    declaredDeps: ["foundations"],
  }),
  new DependencyCycleError({ cycle: ["a", "b", "a"] }),
  PluginManifestError.forPlugin("/plugins/demo", "Manifest validation failed", [
    "'name' is required",
  ]),
  new PrismConfigError({ message: "Prism config is not valid JSON: unexpected end of input" }),
  new BundleBuildError({
    bundleKind: "MCP server",
    diagnostics: "error: could not resolve './missing.js'",
  }),
  new LoweringOwnershipError({
    reason: "drifted-target",
    targetPath: "/tmp/root/.codex/agents/builder.md",
    plugin: "demo",
    harness: "codex-cli",
    ledgerHash: "sha256:aaaa",
    ledgerUpdatedAt: "2026-06-01T00:00:00.000Z",
    currentHash: "sha256:bbbb",
    hint: "the file was edited outside Prism — back up and remove the edited file, then re-run",
  }),
];

test("every PrismError tag renders headline + hint and never a stack frame", () => {
  const renderedTags = new Set<string>();

  for (const error of SAMPLE_ERRORS) {
    renderedTags.add(error._tag);
    expect(isPrismError(error)).toBe(true);

    const rendered = renderPrismError(error);
    const [headline] = rendered.split("\n");

    expect(headline?.trim().length).toBeGreaterThan(0);
    expect(rendered).toContain("hint:");
    expect(rendered).not.toMatch(STACK_FRAME);
  }

  // The sample list must cover the whole union — a new tag added to
  // PRISM_ERROR_TAGS without a render sample fails here.
  expect([...renderedTags].sort()).toEqual([...PRISM_ERROR_TAGS].sort());
});

test("LoweringOwnershipError renders its structured fields", () => {
  const error = new LoweringOwnershipError({
    reason: "drifted-target",
    targetPath: "/tmp/root/.codex/agents/builder.md",
    plugin: "demo-plugin",
    harness: "codex-cli",
    ledgerHash: "sha256:aaaa",
    ledgerUpdatedAt: "2026-06-01T00:00:00.000Z",
    currentHash: "sha256:bbbb",
    hint: "back up and remove the edited file, then re-run",
  });

  const rendered = renderPrismError(error);
  expect(rendered).toContain(
    "Managed compile target changed outside Prism: /tmp/root/.codex/agents/builder.md",
  );
  expect(rendered).toContain("plugin: demo-plugin · harness: codex-cli");
  expect(rendered).toContain("ledger hash: sha256:aaaa (recorded 2026-06-01T00:00:00.000Z)");
  expect(rendered).toContain("current hash: sha256:bbbb");
  expect(rendered).toContain("hint: back up and remove the edited file, then re-run");
  expect(rendered).not.toMatch(STACK_FRAME);

  // Message stays aligned with the historical headline for throw-site tests.
  expect(error.message).toBe(
    "Managed compile target changed outside Prism: /tmp/root/.codex/agents/builder.md",
  );
});

test("renderPrismCause finds typed failures inside an Exit cause", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.fail(
      new SourceParseError({
        sourcePath: "/plugins/demo/agents/builder.agent.ts",
        kind: "agent",
        message: "unexpected token",
      }),
    ),
  );

  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;

  const rendered = renderPrismCause(exit.cause);
  expect(rendered).toContain("failed to parse agent: unexpected token");
  expect(rendered).toContain("hint:");
  expect(rendered).not.toMatch(STACK_FRAME);
});

test("renderPrismCause renders unknown defects as name + message without stack", async () => {
  const defect = new Error("boom at the bundler");
  defect.stack = `Error: boom at the bundler\n    at secretFrame (/Users/nobody/code/file.ts:12:3)`;

  const exit = await Effect.runPromiseExit(Effect.promise(() => Promise.reject(defect)));

  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;

  const rendered = renderPrismCause(exit.cause);
  expect(rendered).toContain("Error: boom at the bundler");
  expect(rendered).not.toContain("secretFrame");
  expect(rendered).not.toMatch(STACK_FRAME);
});

test("renderPrismCause appends a hint line when a defect carries one", async () => {
  const defect = Object.assign(new Error("daemon not running"), {
    hint: "run: prism mcp serve <plugin>",
  });

  const exit = await Effect.runPromiseExit(Effect.promise(() => Promise.reject(defect)));
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;

  const rendered = renderPrismCause(exit.cause);
  expect(rendered).toContain("Error: daemon not running");
  expect(rendered).toContain("hint: run: prism mcp serve <plugin>");
});

// ---------------------------------------------------------------------------
// Compile path: a LoweringOwnershipError thrown by the lowering executor
// surfaces as a defect (the pipeline runs executors via Effect.promise) and
// must render its structured form at the edge.
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("LoweringOwnershipError through the compile execute path renders structured", async () => {
  const root = await mkdtemp(join(tmpdir(), "prism-errors-"));
  tempRoots.push(root);

  const targetRoot = join(root, ".codex");
  const targetPath = join(targetRoot, "agents", "builder.md");
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, "user content\n");

  const exit = await Effect.runPromiseExit(
    Effect.promise(() =>
      executeStandardLowering(
        [
          {
            kind: "write-md",
            target: targetPath,
            content: "generated content\n",
            reason: "changed",
          },
        ],
        {
          dryRun: false,
          target: {
            harness: "codex-cli",
            scope: "global",
            root: targetRoot,
            sourcePluginName: "errors-render-test",
            sourcePluginVersion: "0.1.0",
            sourcePluginPath: join(root, "plugin"),
          },
        },
      ),
    ),
  );

  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;

  const described = describePrismCause(exit.cause);
  expect(described.headline).toBe(
    `Compile target exists but is not owned by Prism: ${targetPath}`,
  );
  expect(described.path).toBe(targetPath);
  expect(described.hint).toContain("delete or move the file");

  const rendered = renderPrismCause(exit.cause);
  expect(rendered).toContain("plugin: errors-render-test · harness: codex-cli");
  expect(rendered).toContain("hint: Prism never overwrites foreign files");
  expect(rendered).not.toMatch(STACK_FRAME);
});
