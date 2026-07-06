import { expect, test } from "bun:test";
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
import {
  BlockedTargetError,
  BundleBuildError,
  isPrismError,
  McpBundleMissingError,
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
  new McpBundleMissingError({
    pluginName: "demo",
    bundlePath: "/tmp/prism-home/runtime/mcp/demo/server.mjs",
  }),
  new BlockedTargetError({
    targetPath: "/tmp/root/.codex/agents/builder.md",
    plugin: "demo",
    hint: "a file Prism has never managed already exists here with different content — delete or move it, then refresh",
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

test("BlockedTargetError renders its structured fields", () => {
  const error = new BlockedTargetError({
    targetPath: "/tmp/root/.codex/agents/builder.md",
    plugin: "demo-plugin",
    hint: "delete or move it, then refresh",
  });

  const rendered = renderPrismError(error);
  expect(rendered).toContain(
    "Refusing to overwrite a file Prism does not manage: /tmp/root/.codex/agents/builder.md",
  );
  expect(rendered).toContain("plugin: demo-plugin");
  expect(rendered).toContain("hint: delete or move it, then refresh");
  expect(rendered).not.toMatch(STACK_FRAME);
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

test("renderPrismCause unpacks an AggregateError's nested causes", async () => {
  const defect = new AggregateError(
    [new Error("Could not resolve: \"/packages/prism-sdk/src/mcp/uds-registry.js\"")],
    "Bundle failed",
  );

  const exit = await Effect.runPromiseExit(Effect.promise(() => Promise.reject(defect)));
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;

  const rendered = renderPrismCause(exit.cause);
  expect(rendered).toContain("AggregateError: Bundle failed");
  expect(rendered).toContain('Could not resolve: "/packages/prism-sdk/src/mcp/uds-registry.js"');
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
