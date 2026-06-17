import { Effect } from "effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Minimal in-memory authoring runtime that stubs the `prism` module for
 * plugin source files. It provides the typed-ref helpers and definition
 * builders used by `.agent.ts`, `.orbit.ts`, `.trait.ts`, `.tool.ts`,
 * `.toolspace.ts`, `.modelspace.ts`, `.skillspace.ts`, and `.hook.ts` files.
 *
 * The real semantic validation happens later in the compiler; this runtime
 * only needs to return plain data structures so that source modules can be
 * imported/bundled without resolving the full `prism` package.
 */
export const AUTHORING_RUNTIME_JS = `
const withNamedRef = (kind, first, second) =>
  second === undefined ? { kind, name: first } : { kind, plugin: first, name: second };

export const traitRef = (first, second) => withNamedRef("trait-ref", first, second);
export const agentRef = (first, second) => withNamedRef("agent-ref", first, second);
export const orbitRef = (first, second) => withNamedRef("orbit-ref", first, second);

export const toolRef = (first, second, third) =>
  third === undefined
    ? { kind: "tool-ref", toolspace: first, name: second }
    : { kind: "tool-ref", plugin: first, toolspace: second, name: third };

export const toolGroupRef = (first, second, third) =>
  third === undefined
    ? { kind: "tool-group-ref", toolspace: first, name: second }
    : { kind: "tool-group-ref", plugin: first, toolspace: second, name: third };

export const modelProfileRef = (first, second, third) =>
  third === undefined
    ? { kind: "model-profile-ref", modelspace: first, name: second }
    : { kind: "model-profile-ref", plugin: first, modelspace: second, name: third };

export const skillRef = (first, second) => withNamedRef("skill-ref", first, second);

export const skillspaceRef = (first, second, third) =>
  third === undefined
    ? { kind: "skillspace-ref", skillspace: first, name: second }
    : { kind: "skillspace-ref", plugin: first, skillspace: second, name: third };

export const schemaSlot = (options = {}) => ({ kind: "schema", ...options });
export const bindTrait = (trait, options = {}) => ({
  kind: "trait-binding",
  trait,
  ...(options.tools ? { tools: options.tools } : {}),
});

export const defineAgent = (agent) => agent;
export const defineTrait = (trait) => trait;
export const defineOrbit = (orbit) => orbit;
export const defineTool = (tool) => tool;
export const defineToolspace = (toolspace) => toolspace;
export const defineModelspace = (modelspace) => modelspace;
export const defineSkillspace = (skillspace) => skillspace;
export const defineHook = (hook) => hook;

export const hookEvent = {
  toolBefore: "tool.before",
  toolAfter: "tool.after",
  promptSubmit: "prompt.submit",
  permissionRequest: "permission.request",
  sessionStart: "session.start",
  sessionEnd: "session.end",
};

export const hookTool = {
  any: () => ({ kind: "hook-any-tool" }),
  tool: (tool) => ({ kind: "hook-toolspace-tool", tool }),
  group: (group) => ({ kind: "hook-toolspace-group", group }),
  canonical: (ref) => ({ kind: "hook-canonical-tool", ref }),
};

export const hookMatcher = {
  tool: hookTool,
};
`;

let cachedRuntimePath: string | undefined;
let cachedRuntimeDir: string | undefined;

class AuthoringRuntimeWriteError {
  readonly _tag = "AuthoringRuntimeWriteError";
  constructor(readonly cause: unknown) {}
}

/**
 * Return a file path to a persisted copy of the authoring runtime. The file
 * is written once per process and reused across plugin compiles.
 */
export const getAuthoringRuntimePath = Effect.fnUntraced(function* () {
  if (cachedRuntimePath !== undefined) {
    return cachedRuntimePath;
  }

  const dir = yield* Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "prism-authoring-runtime-")),
    catch: (cause) => new AuthoringRuntimeWriteError(cause),
  });
  cachedRuntimeDir = dir;
  const path = join(dir, "prism-authoring-runtime.mjs");
  yield* Effect.tryPromise({
    try: () => writeFile(path, AUTHORING_RUNTIME_JS, "utf8"),
    catch: (cause) => new AuthoringRuntimeWriteError(cause),
  });
  cachedRuntimePath = path;
  return path;
});

/**
 * For tests that need to clean up the machine-global temp runtime file.
 */
export const getAuthoringRuntimeDir = (): string | undefined => cachedRuntimeDir;
