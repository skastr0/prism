/**
 * Acceptance gate: Prism workflow generated-tool E2E matrix.
 *
 * Modes:
 *   temp  — use temporary HOME and PRISM_HOME; useful for repeatable root/config learning.
 *   live  — use the operator's current harness configs; optional Tower reporting.
 *
 * Usage:
 *   bun scripts/acceptance/workflow-e2e-matrix.ts --mode temp
 *   bun scripts/acceptance/workflow-e2e-matrix.ts --mode temp --seed-live-configs
 *     Seeds non-secret config/cache files only. OAuth/session state is never copied.
 *   bun scripts/acceptance/workflow-e2e-matrix.ts --mode live --tower
 *   bun scripts/acceptance/workflow-e2e-matrix.ts --cleanup-qa-only
 */
import { pluginServerKey, renderPluginAllowlist, renderPluginWire } from "@skastr0/prism-sdk/mcp/wire-naming";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  CHALLENGE_PROOF_SECRET_ENV,
  CHALLENGE_PROOF_SECRET_FILENAME,
  keyedChallengeProof,
} from "../../examples/prism-harness-qa/tools/proof.js";
import { generatedOwnerToolName } from "../../src/compile/generated-plugin.js";
import { getHarness, resolveHarnessRoot } from "../../src/harnesses.js";
import { syncDesiredRoot } from "../../src/sync/run.js";
import { cleanupPrismMcpProcessesUnder } from "../../src/testing/mcp-process-cleanup.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PLUGIN_PATH = resolve(REPO_ROOT, "examples", "prism-harness-qa");
const QA_PLUGIN_NAME = "prism-harness-qa";
const QA_FILE_ROUTER_PLUGIN_NAME = `${QA_PLUGIN_NAME}#file-router`;
const QA_GENERATED_PLUGIN_NAME = "prism-generated-prism-harness-qa";
const STORE_ROOT = "/tmp";
const WORKFLOW_HARNESSES = ["opencode", "claude-code", "codex-cli", "grok", "hermes", "kimi-code", "amp-code"] as const;
const COMPILED_AGENT_HARNESSES = ["opencode", "claude-code", "codex-cli", "grok", "kimi-code", "amp-code"] as const;
export const TOWER_COMMENT_FAMILY = "glyphs";

type Harness = "opencode" | "claude-code" | "codex-cli" | "grok" | "hermes" | "kimi-code" | "amp-code";
type Mode = "temp" | "live";
export type HermesAuthScope = "root" | "profile";

interface MatrixEntry {
  readonly harness: Harness;
  readonly workflow: string;
  readonly challenge: string;
  readonly expectedModel: string;
}

const MATRIX: readonly MatrixEntry[] = [
  {
    harness: "opencode",
    workflow: "smoke-opencode.workflow.ts",
    challenge: "opencode-2026-06-20-001",
    expectedModel: "ollama-cloud/deepseek-v4-flash",
  },
  {
    harness: "claude-code",
    workflow: "smoke-claude-code.workflow.ts",
    challenge: "claude-code-2026-06-20-001",
    expectedModel: "sonnet",
  },
  {
    harness: "codex-cli",
    workflow: "smoke-codex-cli.workflow.ts",
    challenge: "codex-cli-2026-06-20-001",
    expectedModel: "gpt-5.4-mini",
  },
  {
    harness: "grok",
    workflow: "smoke-grok.workflow.ts",
    challenge: "grok-2026-06-20-001",
    // Not "grok-build" — see the model comment in smoke-grok.workflow.ts (PQ-176).
    expectedModel: "grok-composer-2.5-fast",
  },
  {
    harness: "hermes",
    workflow: "smoke-hermes.workflow.ts",
    challenge: "hermes-2026-06-20-001",
    expectedModel: "grok-composer-2.5-fast",
  },
  {
    harness: "kimi-code",
    workflow: "smoke-kimi-code.workflow.ts",
    challenge: "kimi-code-2026-06-20-001",
    expectedModel: "kimi-code/kimi-for-coding",
  },
  {
    harness: "amp-code",
    workflow: "smoke-amp-code-deep.workflow.ts",
    challenge: "amp-code-deep-2026-06-20-001",
    expectedModel: "deep",
  },
  {
    harness: "amp-code",
    workflow: "smoke-amp-code-rush.workflow.ts",
    challenge: "amp-code-rush-2026-06-20-001",
    expectedModel: "rush",
  },
];

const ALL_HARNESSES = new Set<Harness>(MATRIX.map((entry) => entry.harness));

interface CommandResult {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

interface HarnessResult {
  readonly harness: Harness;
  readonly workflow: string;
  readonly challenge: string;
  readonly refresh: CommandResult;
  readonly validate: CommandResult;
  readonly run?: CommandResult;
  readonly setupBlocker?: HarnessSetupBlocker;
  readonly proof?: {
    readonly pass: boolean;
    readonly output?: unknown;
    readonly metadata?: unknown;
    readonly detail?: string;
  };
  readonly checks?: readonly HarnessCheck[];
  readonly tower?: CommandResult | { readonly skipped: string };
}

interface HarnessSetupBlocker {
  readonly harness: Harness;
  readonly code: string;
  readonly message: string;
  readonly retryCommand?: string;
}

interface HarnessCheck {
  readonly name: string;
  readonly status: "pass" | "fail" | "not-applicable" | "skipped";
  readonly detail?: string;
}

interface ModelSelectionExpectedTask {
  readonly id: string;
  readonly challenge: string;
  readonly expectedModel: string;
}

interface ModelSelectionResult {
  readonly harness: "opencode";
  readonly workflow: string;
  readonly invalidWorkflow: string;
  readonly refresh: CommandResult;
  readonly validate: CommandResult;
  readonly invalidValidate: CommandResult;
  readonly run?: CommandResult;
  readonly invalidRun?: CommandResult;
  readonly checks?: readonly HarnessCheck[];
}

interface ConfigSeedEntry {
  readonly label: string;
  readonly harnesses: readonly Harness[];
  readonly from: string;
  readonly to: string;
  readonly copied: boolean;
}

interface ConfigSeedSummary {
  readonly liveHome: string;
  readonly tempHome: string;
  readonly credentialStrategy: "config-only-no-oauth-copy";
  readonly hermesAuthScope?: HermesAuthScope;
  readonly hermesProfile?: string;
  readonly entries: readonly ConfigSeedEntry[];
}

interface ConfigSeedRule {
  readonly label: string;
  readonly harnesses: readonly Harness[];
  readonly from: string;
  readonly to: string;
  readonly exclude?: ReadonlyArray<RegExp>;
}

interface WorkflowE2EQaCleanupRootSummary {
  readonly harness: Harness | "cursor";
  readonly root: string;
  readonly syncOps: number;
  readonly fallbackRemoved: readonly string[];
  readonly fallbackPatched: readonly string[];
  readonly failures: readonly string[];
}

interface WorkflowE2EQaCleanupSummary {
  readonly prismHome: string;
  readonly runtimeMcpRoot: string;
  readonly runtimeRemoved: boolean;
  readonly roots: readonly WorkflowE2EQaCleanupRootSummary[];
  readonly success: boolean;
}

const args = process.argv.slice(2);

const MODEL_SELECTION_WORKFLOW = "model-selection.workflow.ts";
const MODEL_SELECTION_INVALID_WORKFLOW = "model-selection-invalid.workflow.ts";
const TEMP_PLUGIN_PREFIX = "pwe2e-plugin-";
const TEMP_HOME_PREFIX = "pwe2e-home-";
const TEMP_PRISM_HOME_PREFIX = "pwe2e-prism-";

// Canonical shim-era wire naming, derived from the same modules the compile
// pipeline and the shim use — never hand-maintained string literals.
const CHALLENGE_TOOL_WIRE_SEGMENT = generatedOwnerToolName(QA_PLUGIN_NAME, "challenge_echo");
export const CLAUDE_CHALLENGE_TOOL_NAME = renderPluginAllowlist(
  "claude-code",
  QA_PLUGIN_NAME,
  CHALLENGE_TOOL_WIRE_SEGMENT,
);
export const CODEX_CHALLENGE_COMPLETED_LINE =
  `mcp: ${pluginServerKey(QA_PLUGIN_NAME)}/${renderPluginWire("codex-cli", QA_PLUGIN_NAME, CHALLENGE_TOOL_WIRE_SEGMENT)} (completed)`;
export const OPENCODE_MODEL_SELECTION_SMOKE_MODEL = "ollama-cloud/deepseek-v4-flash";
const MODEL_SELECTION_EXPECTED_TASKS: readonly ModelSelectionExpectedTask[] = [
  {
    id: "agent-default-modelspace",
    challenge: "model-agent-default-2026-06-20-001",
    expectedModel: OPENCODE_MODEL_SELECTION_SMOKE_MODEL,
  },
  {
    id: "explicit-model-profile",
    challenge: "model-explicit-profile-2026-06-20-001",
    expectedModel: OPENCODE_MODEL_SELECTION_SMOKE_MODEL,
  },
  {
    id: "raw-model-override",
    challenge: "model-raw-override-2026-06-20-001",
    expectedModel: OPENCODE_MODEL_SELECTION_SMOKE_MODEL,
  },
  {
    id: "model-resolver",
    challenge: "model-resolver-2026-06-20-001",
    expectedModel: OPENCODE_MODEL_SELECTION_SMOKE_MODEL,
  },
];

const argValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
};

const hasFlag = (name: string): boolean => args.includes(name);

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const removePathIfExists = async (path: string): Promise<boolean> => {
  if (!(await pathExists(path))) return false;
  await rm(path, { recursive: true, force: true });
  return true;
};

const HERMES_PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;
const mutableLiveConfigSeedPath = /(^|\/)(auth\.json|\.credentials\.json|credentials|oauth|session\.json|secrets\.json|device_id|device-id\.json|installation_id|agent_id|\.metadata_version)$/u;
const mutableLiveConfigSeedExactPaths = new Set([
  ".claude.json",
]);

export const isMutableLiveConfigSeedPath = (path: string): boolean => {
  const normalized = path.split("\\").join("/");
  return mutableLiveConfigSeedExactPaths.has(normalized) || mutableLiveConfigSeedPath.test(normalized);
};

const safeHermesProfileName = (profile: string): boolean =>
  profile.length > 0 && HERMES_PROFILE_NAME_PATTERN.test(profile) && profile !== "." && profile !== "..";

export const resolveHermesAuthScopeForE2E = (
  requestedScope: string | undefined,
  requestedProfile: string | undefined,
): HermesAuthScope => {
  if (requestedScope === undefined || requestedScope.length === 0) {
    if (requestedProfile !== undefined && requestedProfile.length > 0) {
      throw new Error("PRISM_E2E_HERMES_PROFILE requires PRISM_E2E_HERMES_AUTH_SCOPE=profile; default Hermes E2E auth scope is root");
    }
    return "root";
  }
  if (requestedScope === "root" || requestedScope === "profile") return requestedScope;
  throw new Error(`invalid PRISM_E2E_HERMES_AUTH_SCOPE ${requestedScope}; expected root or profile`);
};

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export const hermesAuthHasXaiOauthCredential = (auth: unknown): boolean => {
  const root = objectValue(auth);
  const providers = objectValue(root?.providers);
  const xaiProvider = objectValue(providers?.["xai-oauth"]);
  const providerTokens = objectValue(xaiProvider?.tokens);
  if (typeof providerTokens?.access_token === "string" && providerTokens.access_token.length > 0) {
    return true;
  }

  const credentialPool = objectValue(root?.credential_pool);
  const xaiPool = credentialPool?.["xai-oauth"];
  if (!Array.isArray(xaiPool)) return false;
  return xaiPool.some((entry) => {
    const record = objectValue(entry);
    return typeof record?.access_token === "string" && record.access_token.length > 0;
  });
};

const readJsonIfExists = async (path: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

export const resolveHermesProfileForE2E = async (
  liveHome: string,
  requestedProfile: string | undefined,
): Promise<string | undefined> => {
  if (requestedProfile !== undefined && requestedProfile.length > 0) {
    if (!safeHermesProfileName(requestedProfile)) {
      throw new Error(`unsafe PRISM_E2E_HERMES_PROFILE value: ${requestedProfile}`);
    }
    return requestedProfile;
  }

  const profilesRoot = join(liveHome, ".hermes", "profiles");
  let profileNames: string[];
  try {
    profileNames = (await readdir(profilesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && safeHermesProfileName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return undefined;
  }

  for (const profile of profileNames) {
    const auth = await readJsonIfExists(join(profilesRoot, profile, "auth.json"));
    if (hermesAuthHasXaiOauthCredential(auth)) return profile;
  }
  return undefined;
};

export const CONFIG_SEED_RULES: readonly ConfigSeedRule[] = [
  // Config seeding is intentionally config/cache-only. Never copy OAuth,
  // session, refresh-token, or device identity files into disposable homes.
  {
    label: "claude-code-settings",
    harnesses: ["claude-code"],
    from: ".claude/settings.json",
    to: ".claude/settings.json",
  },
  {
    label: "opencode-config",
    harnesses: ["opencode"],
    from: ".config/opencode/opencode.json",
    to: ".config/opencode/opencode.json",
  },
  {
    label: "codex-cli-config",
    harnesses: ["codex-cli"],
    from: ".codex/config.toml",
    to: ".codex/config.toml",
  },
  {
    label: "codex-cli-model-cache",
    harnesses: ["codex-cli"],
    from: ".codex/models_cache.json",
    to: ".codex/models_cache.json",
  },
  {
    label: "grok-model-cache",
    harnesses: ["grok"],
    from: ".grok/models_cache.json",
    to: ".grok/models_cache.json",
  },
  {
    label: "grok-version",
    harnesses: ["grok"],
    from: ".grok/version.json",
    to: ".grok/version.json",
  },
  {
    label: "hermes-config",
    harnesses: ["hermes"],
    from: ".hermes/config.yaml",
    to: ".hermes/config.yaml",
  },
  {
    label: "kimi-code-config",
    harnesses: ["kimi-code"],
    from: ".kimi-code/config.toml",
    to: ".kimi-code/config.toml",
  },
  {
    label: "amp-code-settings",
    harnesses: ["amp-code"],
    from: ".config/amp/settings.json",
    to: ".config/amp/settings.json",
  },
  {
    label: "amp-code-settings-haiku",
    harnesses: ["amp-code"],
    from: ".config/amp/settings-haiku.json",
    to: ".config/amp/settings-haiku.json",
  },
];

const parseMode = (): Mode => {
  const value = argValue("--mode") ?? "temp";
  if (value === "temp" || value === "live") return value;
  throw new Error(`invalid --mode ${value}; expected temp or live`);
};

const parseHarnesses = (): readonly Harness[] | undefined => {
  const value = argValue("--harness");
  if (value === undefined) return undefined;
  const harnesses = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (harnesses.length === 0) {
    throw new Error("--harness must name at least one supported workflow harness");
  }
  for (const harness of harnesses) {
    if (!ALL_HARNESSES.has(harness as Harness)) {
      throw new Error(`unsupported --harness ${harness}; expected one of ${[...ALL_HARNESSES].sort().join(", ")}`);
    }
  }
  return [...new Set(harnesses)] as Harness[];
};

const runCommand = async (
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<CommandResult> => {
  const started = Date.now();
  const proc = Bun.spawn({
    cmd: [...command],
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { command, exitCode, stdout, stderr, durationMs: Date.now() - started };
};

const writeE2EManifest = async (pluginRoot: string): Promise<void> => {
  await writeFile(join(pluginRoot, "plugin.json"), `${JSON.stringify({
    name: "prism-harness-qa",
    version: "0.1.0",
    description: "Generated-tool workflow E2E fixture for Prism supported workflow harnesses.",
    targets: {
      skills: WORKFLOW_HARNESSES,
      agents: COMPILED_AGENT_HARNESSES,
      orbits: WORKFLOW_HARNESSES,
      modelspaces: WORKFLOW_HARNESSES,
      tools: WORKFLOW_HARNESSES,
    },
  }, null, 2)}\n`);
};

const preparePluginRoot = async (roots: string[]): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), TEMP_PLUGIN_PREFIX));
  roots.push(parent);
  const pluginRoot = join(parent, "prism-harness-qa");
  await cp(PLUGIN_PATH, pluginRoot, { recursive: true });
  await Promise.all([
    rm(join(pluginRoot, "commands"), { recursive: true, force: true }),
    rm(join(pluginRoot, "harness"), { recursive: true, force: true }),
    rm(join(pluginRoot, "hooks"), { recursive: true, force: true }),
    rm(join(pluginRoot, "rules"), { recursive: true, force: true }),
  ]);
  await writeE2EManifest(pluginRoot);
  return pluginRoot;
};

export const removeWorkflowE2ETempRoots = async (roots: readonly string[]): Promise<void> => {
  await Promise.all(roots.map((root) => cleanupPrismMcpProcessesUnder(root)));
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
};

const JSONC_FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

const workflowE2EHarnessRoot = (harness: QaCleanupHarness): string => {
  const root = resolveHarnessRoot(getHarness(harness), "global");
  if (root === null) throw new Error(`workflow E2E cleanup cannot resolve global root for ${harness}`);
  return resolve(root);
};

const nestedValue = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const jsoncRemovePath = (content: string, path: ReadonlyArray<string | number>): string =>
  applyEdits(content, modify(content, path, undefined, { formattingOptions: JSONC_FORMAT }));

const jsoncRemoveArrayMember = (
  content: string,
  arrayPath: ReadonlyArray<string | number>,
  predicate: (value: unknown) => boolean,
): string => {
  const parsed = parseJsonc(content, [], { allowTrailingComma: true });
  const array = nestedValue(parsed, arrayPath);
  if (!Array.isArray(array)) return content;
  let next = content;
  for (let index = array.length - 1; index >= 0; index -= 1) {
    if (!predicate(array[index])) continue;
    next = jsoncRemovePath(next, [...arrayPath, index]);
  }
  return next;
};

const patchTextFileIfChanged = async (
  path: string,
  patch: (content: string) => string,
): Promise<boolean> => {
  if (!(await pathExists(path))) return false;
  const before = await readFile(path, "utf8");
  const after = patch(before);
  if (after === before) return false;
  await writeFile(path, after);
  return true;
};

const removePrismMarkerBlock = (content: string, regionKey: string): string => {
  const escaped = regionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(
    new RegExp(`\\n?# --- prism:${escaped} begin ---[\\s\\S]*?# --- prism:${escaped} end ---\\n?`, "g"),
    "\n",
  );
};

const removeYamlMapEntry = (content: string, parentKey: string, entryKey: string): string => {
  const lines = content.split(/(?<=\n)/u);
  const parentPattern = new RegExp(`^${parentKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(?:#.*)?\\n?$`, "u");
  const entryPattern = new RegExp(`^  ${entryKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(?:#.*)?\\n?$`, "u");

  const parentIndex = lines.findIndex((line) => parentPattern.test(line));
  if (parentIndex === -1) return content;
  const entryIndex = lines.findIndex((line, index) => index > parentIndex && entryPattern.test(line));
  if (entryIndex === -1) return content;

  let endIndex = entryIndex + 1;
  while (endIndex < lines.length) {
    const line = lines[endIndex] ?? "";
    if (/^\S/u.test(line) || /^  \S/u.test(line)) break;
    endIndex += 1;
  }

  return [...lines.slice(0, entryIndex), ...lines.slice(endIndex)].join("");
};

const workflowE2EQaFallbackPaths = (harness: QaCleanupHarness, root: string): readonly string[] => {
  switch (harness) {
    case "cursor":
      return [];
    case "opencode":
      return [
        join(root, "plugins", QA_GENERATED_PLUGIN_NAME),
        join(root, "agents", "qa-tester.md"),
        join(root, "skills", "qa-helper"),
        join(root, "skills", "qa-orbit"),
      ];
    case "claude-code":
      return [join(root, "skills", QA_GENERATED_PLUGIN_NAME)];
    case "codex-cli":
      return [
        join(root, "agents", "qa-tester.toml"),
        join(root, "skills", "qa-helper"),
        join(root, "skills", "qa-orbit"),
        join(root, "prism-orphans", "agents", "qa-tester.toml"),
      ];
    case "grok":
      return [join(root, "plugins", QA_GENERATED_PLUGIN_NAME)];
    case "hermes":
      return [
        join(root, "skills", "qa-helper"),
        join(root, "skills", "qa-orbit"),
      ];
    case "kimi-code":
      return [join(root, "plugins", "managed", QA_GENERATED_PLUGIN_NAME)];
    case "amp-code":
      return [
        join(root, "plugins", `${QA_GENERATED_PLUGIN_NAME}.ts`),
        join(root, "skills", "prism-agent-qa-tester"),
        join(root, "skills", "qa-helper"),
        join(root, "skills", "qa-orbit"),
      ];
  }
};

const workflowE2EQaStaleFallbackPaths = async (harness: QaCleanupHarness, root: string): Promise<readonly string[]> => {
  const stalePaths: string[] = [];
  const stalePluginRoots =
    harness === "opencode" ? [root]
      : harness === "claude-code" ? [root]
        : harness === "kimi-code" ? [join(root, "plugins")]
          : [];

  for (const staleRoot of stalePluginRoots) {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(staleRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/-stale-\d{8}$/u.test(entry.name)) continue;
      const stalePath = join(staleRoot, entry.name, QA_GENERATED_PLUGIN_NAME);
      if (await pathExists(stalePath)) stalePaths.push(stalePath);
    }
  }
  return stalePaths;
};

const cleanupWorkflowE2EQaConfigFallbacks = async (
  harness: Harness,
  root: string,
): Promise<readonly string[]> => {
  const patched: string[] = [];
  switch (harness) {
    case "opencode": {
      const path = join(root, "opencode.json");
      if (await patchTextFileIfChanged(path, (content) => {
        let next = jsoncRemovePath(content, ["agent", "qa-tester"]);
        next = jsoncRemovePath(next, ["permission", "prism_harness_qa_*"]);
        next = jsoncRemoveArrayMember(next, ["plugin"], (value) =>
          typeof value === "string" && value.includes(`/${QA_GENERATED_PLUGIN_NAME}/`),
        );
        return next;
      })) patched.push(path);
      return patched;
    }
    case "codex-cli": {
      const path = join(root, "config.toml");
      if (await patchTextFileIfChanged(path, (content) =>
        removePrismMarkerBlock(content, `codex.mcp.${QA_GENERATED_PLUGIN_NAME}`),
      )) patched.push(path);
      return patched;
    }
    case "hermes": {
      const path = join(root, "config.yaml");
      if (await patchTextFileIfChanged(path, (content) => {
        const withoutMarker = removePrismMarkerBlock(content, `hermes.mcp.${QA_GENERATED_PLUGIN_NAME}`);
        return removeYamlMapEntry(withoutMarker, "mcp_servers", QA_GENERATED_PLUGIN_NAME);
      })) patched.push(path);
      return patched;
    }
    case "kimi-code": {
      const path = join(root, "plugins", "installed.json");
      if (await patchTextFileIfChanged(path, (content) =>
        jsoncRemoveArrayMember(content, ["plugins"], (value) =>
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          (value as Record<string, unknown>).id === QA_GENERATED_PLUGIN_NAME,
        ),
      )) patched.push(path);
      return patched;
    }
    case "grok": {
      // The QA compile registers the stdio shim as a managed region in
      // grok's config.toml; strip it if snapshot-driven removal missed it.
      const path = join(root, "config.toml");
      if (await patchTextFileIfChanged(path, (content) =>
        removePrismMarkerBlock(content, "grok.mcp.prism"),
      )) patched.push(path);
      return patched;
    }
    case "claude-code":
    case "amp-code":
      return patched;
  }
};

/** QA lowers a cursor server for the single-config live proof; cleanup must reach it too. */
type QaCleanupHarness = Harness | "cursor";

export const cleanupWorkflowE2EQaArtifacts = async (input: {
  readonly prismHome: string;
  readonly harnesses: ReadonlySet<QaCleanupHarness>;
  readonly harnessRoots?: Partial<Record<QaCleanupHarness, string>>;
}): Promise<WorkflowE2EQaCleanupSummary> => {
  const prismHome = resolve(input.prismHome);
  const runtimeMcpRoot = join(prismHome, "runtime", "mcp", QA_PLUGIN_NAME);
  const roots: WorkflowE2EQaCleanupRootSummary[] = [];
  const cleanupScope = new Set([QA_PLUGIN_NAME, QA_FILE_ROUTER_PLUGIN_NAME]);

  for (const harness of [...input.harnesses].sort()) {
    const root = resolve(input.harnessRoots?.[harness] ?? workflowE2EHarnessRoot(harness));
    const syncReport = await syncDesiredRoot({
      prismHome,
      desired: { harness, root, files: [], regions: [] },
      scopePlugins: cleanupScope,
      dryRun: false,
      overwrite: true,
    });
    const fallbackRemoved: string[] = [];
    const failures = [
      ...syncReport.failures.map((failure) => failure.message),
      ...syncReport.blocked.map((blocked) => blocked.hint),
    ];

    for (const path of [
      ...workflowE2EQaFallbackPaths(harness, root),
      ...(await workflowE2EQaStaleFallbackPaths(harness, root)),
    ]) {
      if (await removePathIfExists(path)) fallbackRemoved.push(path);
    }

    const fallbackPatched = await cleanupWorkflowE2EQaConfigFallbacks(harness, root);

    roots.push({
      harness,
      root,
      syncOps: syncReport.ops.length,
      fallbackRemoved,
      fallbackPatched,
      failures,
    });
  }

  await cleanupPrismMcpProcessesUnder(runtimeMcpRoot);
  const runtimeRemoved = await removePathIfExists(runtimeMcpRoot);
  return {
    prismHome,
    runtimeMcpRoot,
    runtimeRemoved,
    roots,
    success: roots.every((root) => root.failures.length === 0),
  };
};

const copyLiveConfigSeed = async (
  rule: ConfigSeedRule,
  liveHome: string,
  tempHome: string,
): Promise<ConfigSeedEntry> => {
  if (isMutableLiveConfigSeedPath(rule.from) || isMutableLiveConfigSeedPath(rule.to)) {
    throw new Error(`refusing to seed mutable auth/session state for ${rule.label}: ${rule.from} -> ${rule.to}`);
  }

  const source = join(liveHome, rule.from);
  const target = join(tempHome, rule.to);
  if (!(await pathExists(source))) {
    return { label: rule.label, harnesses: rule.harnesses, from: source, to: target, copied: false };
  }

  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    force: true,
    filter: (candidate) => {
      const rel = relative(source, candidate).split("\\").join("/");
      if (rel === "") return true;
      return !(rule.exclude ?? []).some((pattern) => pattern.test(rel));
    },
  });
  return { label: rule.label, harnesses: rule.harnesses, from: source, to: target, copied: true };
};

const seedLiveConfigs = async (input: {
  readonly liveHome: string;
  readonly tempHome: string;
  readonly harnesses: ReadonlySet<Harness>;
  readonly hermesAuthScope?: HermesAuthScope;
  readonly hermesProfile?: string;
}): Promise<ConfigSeedSummary> => {
  const rules = CONFIG_SEED_RULES.filter((rule) =>
    rule.harnesses.some((harness) => input.harnesses.has(harness))
  );
  const entries: ConfigSeedEntry[] = [];
  for (const rule of rules) {
    entries.push(await copyLiveConfigSeed(rule, input.liveHome, input.tempHome));
  }
  if (input.harnesses.has("hermes") && input.hermesProfile !== undefined) {
    const profileRoot = `.hermes/profiles/${input.hermesProfile}`;
    entries.push(await copyLiveConfigSeed({
      label: "hermes-profile-config",
      harnesses: ["hermes"],
      from: `${profileRoot}/config.yaml`,
      to: `${profileRoot}/config.yaml`,
    }, input.liveHome, input.tempHome));
  }
  return {
    liveHome: input.liveHome,
    tempHome: input.tempHome,
    credentialStrategy: "config-only-no-oauth-copy",
    ...(input.hermesAuthScope !== undefined ? { hermesAuthScope: input.hermesAuthScope } : {}),
    ...(input.hermesProfile !== undefined ? { hermesProfile: input.hermesProfile } : {}),
    entries,
  };
};

const workflowPath = (pluginRoot: string, entry: MatrixEntry): string =>
  join(pluginRoot, "workflows", entry.workflow);

const proofFromRun = (
  entry: MatrixEntry,
  run: CommandResult,
  expectedProof: string,
): HarnessResult["proof"] => {
  if (run.exitCode !== 0) {
    return { pass: false, detail: "workflow run exited non-zero" };
  }
  try {
    const parsed = JSON.parse(run.stdout) as {
      readonly tasks?: readonly Array<{ readonly output?: unknown; readonly metadata?: unknown }>;
    };
    const task = parsed.tasks?.[0];
    const output = task?.output as {
      readonly challenge?: unknown;
      readonly proof?: unknown;
      readonly source?: unknown;
    } | undefined;
    const pass =
      output?.challenge === entry.challenge &&
      output?.proof === expectedProof &&
      output?.source === "prism-generated-tool";
    return {
      pass,
      output,
      metadata: task?.metadata,
      ...(pass ? {} : { detail: "keyed generated-tool proof did not match" }),
    };
  } catch (error) {
    return {
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

export const classifySetupBlocker = (
  entry: Pick<MatrixEntry, "harness">,
  run: Pick<CommandResult, "exitCode" | "stdout" | "stderr"> | undefined,
): HarnessSetupBlocker | undefined => {
  if (run === undefined || run.exitCode === 0) return undefined;
  const output = `${run.stdout}\n${run.stderr}`;
  switch (entry.harness) {
    case "grok":
      if (/grok requires xAI OAuth login|run `grok login`|refresh Grok credentials/iu.test(output)) {
        return {
          harness: entry.harness,
          code: "grok-oauth-login-required",
          message: "Grok requires xAI OAuth login before workflow run.",
          retryCommand: "grok login",
        };
      }
      return undefined;
    case "hermes":
      if (/xAI OAuth state is missing access_token|Run `hermes model` to re-authenticate|Re-authenticate with `hermes model`/iu.test(output)) {
        return {
          harness: entry.harness,
          code: "hermes-xai-oauth-access-token-missing",
          message: "Hermes xAI OAuth state is missing an access token.",
          retryCommand: "hermes model",
        };
      }
      return undefined;
    case "kimi-code":
      if (/reached your usage limit for this billing cycle|provider\.api_error: 403/iu.test(output)) {
        return {
          harness: entry.harness,
          code: "kimi-quota-exhausted",
          message: "Kimi Code provider quota is exhausted for this billing cycle.",
          retryCommand: "wait for quota refresh or upgrade the Kimi plan",
        };
      }
      if (/kimi-code requires OAuth login|run `kimi login`|refresh Kimi Code credentials/iu.test(output)) {
        return {
          harness: entry.harness,
          code: "kimi-oauth-login-required",
          message: "Kimi Code requires OAuth login before workflow run.",
          retryCommand: "kimi login",
        };
      }
      return undefined;
    case "amp-code":
    case "claude-code":
    case "codex-cli":
    case "opencode":
      return undefined;
  }
};

const EXPECTED_ADAPTERS: Readonly<Record<Harness, string>> = {
  "amp-code": "amp-code",
  "claude-code": "claude-code",
  "codex-cli": "codex-cli",
  grok: "grok-cli",
  hermes: "hermes",
  "kimi-code": "kimi-code",
  opencode: "opencode-cli",
};

const BLOCKED_TOOL_OUTPUT_PATTERN =
  /\b(blocked tool|tool use blocked|permission denied|requires approval|approval required|tool use rejected|interrupted by user)\b/iu;

const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const stringField = (value: unknown, key: string): string | undefined => {
  const record = objectRecord(value);
  const field = record?.[key];
  return typeof field === "string" ? field : undefined;
};

const numberField = (value: unknown, key: string): number | undefined => {
  const record = objectRecord(value);
  const field = record?.[key];
  return typeof field === "number" ? field : undefined;
};

const stringArrayField = (value: unknown, key: string): readonly string[] => {
  const record = objectRecord(value);
  const field = record?.[key];
  return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : [];
};

const isCodexChallengeOutputLine = (
  line: string,
  expectedChallenge: string,
  expectedProof: string,
): boolean => {
  if (!line.trimStart().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(line) as unknown;
    const output = objectRecord(parsed);
    return output?.challenge === expectedChallenge &&
      output.proof === expectedProof &&
      output.source === "prism-generated-tool";
  } catch {
    return false;
  }
};

const codexChallengeToolCallMatches = (
  stderrExcerpt: string,
  expectedChallenge: string,
  expectedProof: string,
): boolean => {
  const lines = stderrExcerpt.split(/\r?\n/u).map((line) => line.trim());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line !== CODEX_CHALLENGE_COMPLETED_LINE) continue;
    // Codex currently prints the tool result immediately after the completed MCP line.
    // Keep this bounded and stop at another MCP line so evidence fails closed if the
    // stderr shape changes or output from another tool is interleaved.
    for (const candidate of lines.slice(index + 1, index + 4)) {
      if (candidate.startsWith("mcp:")) break;
      if (isCodexChallengeOutputLine(candidate, expectedChallenge, expectedProof)) return true;
    }
  }
  return false;
};

const check = (
  name: string,
  pass: boolean,
  detail?: string,
): HarnessCheck => ({
  name,
  status: pass ? "pass" : "fail",
  ...(!pass && detail !== undefined ? { detail } : {}),
});

const notApplicable = (name: string, detail: string): HarnessCheck => ({
  name,
  status: "not-applicable",
  detail,
});

const skipped = (name: string, detail: string): HarnessCheck => ({
  name,
  status: "skipped",
  detail,
});

const incomplete = (name: string, run: CommandResult | undefined): HarnessCheck =>
  skipped(name, run === undefined ? "workflow was not run" : `workflow exited ${run.exitCode}`);

const expectedAgentCheck = (
  entry: MatrixEntry,
  metadata: unknown,
  run: CommandResult | undefined,
  options?: { readonly hermesAuthScope?: HermesAuthScope },
): HarnessCheck => {
  if (run?.exitCode !== 0) return incomplete("intended-agent-selection", run);
  switch (entry.harness) {
    case "opencode":
    case "claude-code":
    case "grok":
      return check(
        "intended-agent-selection",
        stringField(metadata, "nativeAgent") === "qa-tester",
        `expected nativeAgent qa-tester, got ${stringField(metadata, "nativeAgent") ?? "<missing>"}`,
      );
    case "hermes":
    case "kimi-code": {
      const agent = objectRecord(objectRecord(metadata)?.agent);
      const agentName = typeof agent?.name === "string" ? agent.name : undefined;
      const agentSelection = stringField(metadata, "agentSelection");
      const expectedSelection = entry.harness === "hermes" && options?.hermesAuthScope === "profile"
        ? "profile"
        : "prompted-contract";
      return check(
        "intended-agent-selection",
        agentSelection === expectedSelection && agentName === "qa-tester",
        `expected ${expectedSelection} qa-tester, got ${agentSelection ?? "<missing>"} ${agentName ?? "<missing>"}`,
      );
    }
    case "codex-cli":
      return notApplicable("intended-agent-selection", "Codex CLI workflow execution has no Prism native agent file surface");
    case "amp-code":
      return notApplicable("intended-agent-selection", "Amp Code workflow execution uses mode selection rather than Prism native agents");
  }
};

const noDefaultFallbackCheck = (
  entry: MatrixEntry,
  metadata: unknown,
  run: CommandResult | undefined,
  options?: { readonly hermesAuthScope?: HermesAuthScope },
): HarnessCheck => {
  if (run?.exitCode !== 0) return incomplete("no-default-agent-fallback", run);
  switch (entry.harness) {
    case "opencode":
    case "claude-code":
    case "grok":
      return check(
        "no-default-agent-fallback",
        stringField(metadata, "nativeAgent") === "qa-tester",
        `nativeAgent was ${stringField(metadata, "nativeAgent") ?? "<missing>"}`,
      );
    case "hermes":
      {
        const expectedSelection = options?.hermesAuthScope === "profile" ? "profile" : "prompted-contract";
        return check(
          "no-default-agent-fallback",
          stringField(metadata, "agentSelection") === expectedSelection,
          `agentSelection was ${stringField(metadata, "agentSelection") ?? "<missing>"}`,
        );
      }
    case "kimi-code":
      return check(
        "no-default-agent-fallback",
        stringField(metadata, "agentSelection") === "prompted-contract",
        `agentSelection was ${stringField(metadata, "agentSelection") ?? "<missing>"}`,
      );
    case "codex-cli":
      return notApplicable("no-default-agent-fallback", "Codex CLI has no Prism native agent selection surface");
    case "amp-code":
      return notApplicable("no-default-agent-fallback", "Amp Code workflow mode is validated separately");
  }
};

const generatedToolCallObservedCheck = (
  entry: MatrixEntry,
  metadata: unknown,
  run: CommandResult | undefined,
  expectedProof: string,
): HarnessCheck => {
  if (run?.exitCode !== 0) return incomplete("generated-tool-call-observed", run);
  switch (entry.harness) {
    case "claude-code": {
      const toolCalls = stringArrayField(metadata, "claudeToolCallNames");
      return check(
        "generated-tool-call-observed",
        toolCalls.includes(CLAUDE_CHALLENGE_TOOL_NAME),
        `expected Claude stream-json tool_use ${CLAUDE_CHALLENGE_TOOL_NAME}, got ${toolCalls.length === 0 ? "<none>" : toolCalls.join(", ")}`,
      );
    }
    case "opencode":
      return notApplicable(
        "generated-tool-call-observed",
        "OpenCode worker metadata carries no tool-call telemetry (in-process generated tools log nothing to stderr); the keyed challenge proof validates tool execution",
      );
    case "codex-cli": {
      const stderrExcerpt = stringField(metadata, "stderrExcerpt") ?? "";
      return check(
        "generated-tool-call-observed",
        codexChallengeToolCallMatches(stderrExcerpt, entry.challenge, expectedProof),
        "expected Codex stderr excerpt to include shim MCP challenge_echo completion with matching keyed JSON output",
      );
    }
    case "amp-code":
      return notApplicable("generated-tool-call-observed", "Amp Code native execute output does not expose structured tool-use telemetry");
    case "grok":
      return notApplicable("generated-tool-call-observed", "Grok workflow output does not expose structured generated-tool telemetry; deterministic proof is validated separately");
    case "hermes":
      return notApplicable("generated-tool-call-observed", "Hermes workflow output does not expose structured generated-tool telemetry; deterministic proof is validated separately");
    case "kimi-code":
      return notApplicable("generated-tool-call-observed", "Kimi Code workflow output does not expose structured generated-tool telemetry; deterministic proof is validated separately");
  }
};

export const evaluateHarnessChecks = (
  entry: MatrixEntry,
  input: Pick<HarnessResult, "run" | "proof"> & { readonly expectedProof: string },
  options?: { readonly hermesAuthScope?: HermesAuthScope },
): readonly HarnessCheck[] => {
  const metadata = input.proof?.metadata;
  const finish = objectRecord(objectRecord(metadata)?.finish);
  const diagnosticText = input.run?.stderr ?? "";
  const runCompleted = input.run?.exitCode === 0;
  const adapter = stringField(metadata, "adapter");
  const model = stringField(metadata, "model");
  const repairs = numberField(finish, "repairs");

  return [
    check("deterministic-generated-tool-proof", input.proof?.pass === true, input.proof?.detail),
    runCompleted
      ? check("intended-worker", adapter === EXPECTED_ADAPTERS[entry.harness], `expected ${EXPECTED_ADAPTERS[entry.harness]}, got ${adapter ?? "<missing>"}`)
      : incomplete("intended-worker", input.run),
    runCompleted
      ? check("model-resolved", model === entry.expectedModel, `expected ${entry.expectedModel}, got ${model ?? "<missing>"}`)
      : incomplete("model-resolved", input.run),
    generatedToolCallObservedCheck(entry, metadata, input.run, input.expectedProof),
    expectedAgentCheck(entry, metadata, input.run, options),
    noDefaultFallbackCheck(entry, metadata, input.run, options),
    check(
      "no-blocked-tool-interruption",
      !BLOCKED_TOOL_OUTPUT_PATTERN.test(diagnosticText),
      "workflow stderr contained a blocked-tool/interruption pattern",
    ),
    runCompleted
      ? check("no-finish-repairs", repairs === 0, `finish repairs was ${repairs ?? "<missing>"}`)
      : incomplete("no-finish-repairs", input.run),
  ];
};

const taskOutputProofPass = (
  task: { readonly output?: unknown } | undefined,
  challenge: string,
  expectedProof: string,
): boolean => {
  const output = objectRecord(task?.output);
  return (
    output?.challenge === challenge &&
    output?.proof === expectedProof &&
    output?.source === "prism-generated-tool"
  );
};

export const evaluateModelSelectionChecks = (
  run: Pick<CommandResult, "exitCode" | "stdout" | "stderr"> | undefined,
  expectedProofFor: (challenge: string) => string,
): readonly HarnessCheck[] => {
  if (run === undefined) {
    return [skipped("model-selection-run", "workflow was not run")];
  }
  if (run.exitCode !== 0) {
    return [check("model-selection-run", false, "model-selection workflow exited non-zero")];
  }

  let tasks: readonly Array<{ readonly id?: unknown; readonly output?: unknown; readonly metadata?: unknown }>;
  try {
    const parsed = JSON.parse(run.stdout) as {
      readonly tasks?: readonly Array<{ readonly id?: unknown; readonly output?: unknown; readonly metadata?: unknown }>;
    };
    tasks = parsed.tasks ?? [];
  } catch (error) {
    return [check("model-selection-run", false, error instanceof Error ? error.message : String(error))];
  }

  const byId = new Map<string, { readonly output?: unknown; readonly metadata?: unknown }>();
  for (const task of tasks) {
    if (typeof task.id === "string") byId.set(task.id, task);
  }

  return [
    check("model-selection-run", true),
    ...MODEL_SELECTION_EXPECTED_TASKS.flatMap((expected): HarnessCheck[] => {
      const task = byId.get(expected.id);
      const metadata = task?.metadata;
      const finish = objectRecord(objectRecord(metadata)?.finish);
      const repairs = numberField(finish, "repairs");
      return [
        check(`${expected.id}-proof`, taskOutputProofPass(task, expected.challenge, expectedProofFor(expected.challenge)), "keyed generated-tool proof did not match"),
        check(
          `${expected.id}-model`,
          stringField(metadata, "model") === expected.expectedModel,
          `expected ${expected.expectedModel}, got ${stringField(metadata, "model") ?? "<missing>"}`,
        ),
        check(`${expected.id}-no-finish-repairs`, repairs === 0, `finish repairs was ${repairs ?? "<missing>"}`),
      ];
    }),
  ];
};

export const evaluateInvalidModelSelectionCheck = (
  run: Pick<CommandResult, "exitCode" | "stdout" | "stderr"> | undefined,
): HarnessCheck => {
  if (run === undefined) return skipped("invalid-modelspace-fail-closed", "workflow was not run");
  if (run.exitCode === 0) {
    return check("invalid-modelspace-fail-closed", false, "invalid modelspace workflow unexpectedly succeeded");
  }
  const text = `${run.stdout}\n${run.stderr}`;
  return check(
    "invalid-modelspace-fail-closed",
    /modelspace profile .* has no concrete model for workflow worker 'opencode'/iu.test(text),
    "missing expected modelspace fail-closed diagnostic",
  );
};

/**
 * `workflow validate` performs model resolution, so the intentionally-invalid
 * modelspace workflow is REQUIRED to fail validation with the fail-closed
 * diagnostic — a zero exit there would mean the fail-closed gate is broken.
 */
const invalidModelSelectionValidatePass = (
  invalidValidate: Pick<CommandResult, "exitCode" | "stdout" | "stderr">,
): boolean => evaluateInvalidModelSelectionCheck(invalidValidate).status === "pass";

const checksPass = (checks: readonly HarnessCheck[] | undefined): boolean =>
  checks === undefined ? false : checks.every((item) => item.status !== "fail");

const harnessResultPass = (result: HarnessResult, validateOnly: boolean): boolean => {
  // An environmental setup blocker (OAuth absent, provider quota exhausted)
  // excludes the leg from the gate — mirrored from the council's verdict
  // semantics. The blocker is still surfaced in setupBlockers with a retry
  // path, so a blocked leg is reported, never silently skipped.
  if (result.setupBlocker !== undefined) return true;
  return (
    result.refresh.exitCode === 0 &&
    result.validate.exitCode === 0 &&
    (validateOnly || (result.proof?.pass === true && checksPass(result.checks)))
  );
};

const modelSelectionPass = (result: ModelSelectionResult | undefined, validateOnly: boolean): boolean =>
  result === undefined ||
  (
    result.refresh.exitCode === 0 &&
    result.validate.exitCode === 0 &&
    invalidModelSelectionValidatePass(result.invalidValidate) &&
    (validateOnly || checksPass(result.checks))
  );

const acceptancePass = (input: {
  readonly results: readonly HarnessResult[];
  readonly modelSelection?: ModelSelectionResult;
  readonly validateOnly: boolean;
}): boolean =>
  input.results.every((result) => harnessResultPass(result, input.validateOnly)) &&
  modelSelectionPass(input.modelSelection, input.validateOnly);

const towerBody = (input: {
  readonly mode: Mode;
  readonly result: HarnessResult;
}): string => JSON.stringify({
  kind: "prism.workflow-e2e.generated-tool",
  mode: input.mode,
  harness: input.result.harness,
  workflow: input.result.workflow,
  challenge: input.result.challenge,
  proof: input.result.proof,
  setupBlocker: input.result.setupBlocker,
  checks: input.result.checks,
  refreshExitCode: input.result.refresh.exitCode,
  validateExitCode: input.result.validate.exitCode,
  runExitCode: input.result.run?.exitCode,
}, null, 2);

const submitTowerEvidence = async (
  mode: Mode,
  result: HarnessResult,
  env: Record<string, string | undefined>,
): Promise<HarnessResult["tower"]> => {
  if (mode !== "live" || !hasFlag("--tower")) return { skipped: "tower disabled" };
  const glyph = argValue("--tower-glyph") ?? process.env.PRISM_E2E_TOWER_GLYPH;
  if (!glyph) {
    return { skipped: "set --tower-glyph to attach evidence as a Forge glyph comment" };
  }
  return runCommand([
    "tower",
    "comments",
    "add",
    "--family",
    TOWER_COMMENT_FAMILY,
    "--orbit",
    "forge",
    "--id",
    glyph,
    "--source",
    "prism-workflow-e2e",
    "--body",
    towerBody({ mode, result }),
    "prism",
  ], env);
};

const runModelSelectionScenario = async (input: {
  readonly mode: Mode;
  readonly pluginRoot: string;
  readonly env: Record<string, string | undefined>;
  readonly validateOnly: boolean;
  readonly expectedProofFor: (challenge: string) => string;
}): Promise<ModelSelectionResult> => {
  const refresh = await runCommand([
    process.execPath,
    "run",
    "src/cli.ts",
    "refresh",
    input.pluginRoot,
    "--harness",
    "opencode",
    "--scope",
    "global",
  ], input.env);

  const validate = await runCommand([
    process.execPath,
    "run",
    "src/cli.ts",
    "workflow",
    "validate",
    join(input.pluginRoot, "workflows", MODEL_SELECTION_WORKFLOW),
  ], input.env);

  const invalidValidate = await runCommand([
    process.execPath,
    "run",
    "src/cli.ts",
    "workflow",
    "validate",
    join(input.pluginRoot, "workflows", MODEL_SELECTION_INVALID_WORKFLOW),
  ], input.env);

  let run: CommandResult | undefined;
  let invalidRun: CommandResult | undefined;
  if (!input.validateOnly) {
    run = await runCommand([
      process.execPath,
      "run",
      "src/cli.ts",
      "workflow",
      "run",
      join(input.pluginRoot, "workflows", MODEL_SELECTION_WORKFLOW),
      "--store",
      join(STORE_ROOT, `prism-workflow-e2e-${input.mode}-model-selection-opencode.sqlite`),
      "--no-cache",
    ], input.env);
    invalidRun = await runCommand([
      process.execPath,
      "run",
      "src/cli.ts",
      "workflow",
      "run",
      join(input.pluginRoot, "workflows", MODEL_SELECTION_INVALID_WORKFLOW),
      "--store",
      join(STORE_ROOT, `prism-workflow-e2e-${input.mode}-model-selection-invalid-opencode.sqlite`),
      "--no-cache",
    ], input.env);
  }

  const checks = input.validateOnly
    ? undefined
    : [...evaluateModelSelectionChecks(run, input.expectedProofFor), evaluateInvalidModelSelectionCheck(invalidRun)];

  return {
    harness: "opencode",
    workflow: MODEL_SELECTION_WORKFLOW,
    invalidWorkflow: MODEL_SELECTION_INVALID_WORKFLOW,
    refresh,
    validate,
    invalidValidate,
    ...(run ? { run } : {}),
    ...(invalidRun ? { invalidRun } : {}),
    ...(checks ? { checks } : {}),
  };
};

const main = async (): Promise<void> => {
  const mode = parseMode();
  const selected = parseHarnesses();
  const validateOnly = hasFlag("--validate-only");
  const roots: string[] = [];
  const env: Record<string, string | undefined> = {};
  const entries = MATRIX.filter((entry) => selected === undefined || selected.includes(entry.harness));
  const shouldRunModelSelection = entries.some((entry) => entry.harness === "opencode");
  const liveHome = resolve(process.env.PRISM_E2E_LIVE_HOME ?? homedir());
  const livePrismHome = resolve(process.env.PRISM_HOME ?? join(homedir(), ".prism"));
  const qaCleanupHarnesses = new Set<Harness | "cursor">(entries.map((entry) => entry.harness));
  if (shouldRunModelSelection) qaCleanupHarnesses.add("opencode");
  // The QA plugin targets cursor for the single-config live proof; its
  // server entry must be cleaned even though cursor runs no workflow leg.
  qaCleanupHarnesses.add("cursor");

  if (hasFlag("--cleanup-qa-only")) {
    const qaCleanup = await cleanupWorkflowE2EQaArtifacts({
      prismHome: livePrismHome,
      harnesses: qaCleanupHarnesses,
    });
    console.log(JSON.stringify({
      schema: "prism.acceptance.workflow-e2e-qa-cleanup.v1",
      pass: qaCleanup.success,
      qaCleanup,
    }, null, 2));
    process.exitCode = qaCleanup.success ? 0 : 1;
    return;
  }

  const pluginRoot = await preparePluginRoot(roots);

  // Per-run keyed proof secret (finding: the old static proof was derivable
  // from the prompt, so a leg could "pass" without ever reaching the tool).
  // Injected via env for the workflow-run process and in-process tool bundles,
  // and via a runtime-dir file for shim daemons (read per call, so a reused
  // daemon still proves against THIS run's secret).
  const proofSecret = randomBytes(32).toString("hex");
  env[CHALLENGE_PROOF_SECRET_ENV] = proofSecret;
  const expectedProofFor = (challenge: string): string => keyedChallengeProof(challenge, proofSecret);

  const hermesAuthScope = entries.some((entry) => entry.harness === "hermes")
    ? resolveHermesAuthScopeForE2E(process.env.PRISM_E2E_HERMES_AUTH_SCOPE, process.env.PRISM_E2E_HERMES_PROFILE)
    : undefined;
  const hermesProfile = hermesAuthScope === "profile"
    ? await resolveHermesProfileForE2E(liveHome, process.env.PRISM_E2E_HERMES_PROFILE)
    : undefined;
  if (hermesAuthScope === "profile" && hermesProfile !== undefined) {
    env.PRISM_E2E_HERMES_PROFILE = hermesProfile;
  }
  let configSeed: ConfigSeedSummary | undefined;
  let modelSelection: ModelSelectionResult | undefined;
  let activePrismHome = livePrismHome;

  if (mode === "temp") {
    const home = await mkdtemp(join(tmpdir(), TEMP_HOME_PREFIX));
    const prismHome = await mkdtemp(join(tmpdir(), TEMP_PRISM_HOME_PREFIX));
    activePrismHome = prismHome;
    roots.push(home, prismHome);
    if (hasFlag("--seed-live-configs")) {
      configSeed = await seedLiveConfigs({
        liveHome,
        tempHome: home,
        harnesses: new Set(entries.map((entry) => entry.harness)),
        hermesAuthScope,
        hermesProfile,
      });
      if (entries.some((entry) => entry.harness === "grok")) {
        // Grok keeps auth, installed plugins, and the resumable session store under one
        // home; run it against the live ~/.grok directly instead of seeding copies.
        env.GROK_HOME = join(liveHome, ".grok");
      }
    }
    env.HOME = home;
    env.PRISM_HOME = prismHome;
    env.KIMI_CODE_HOME = join(home, ".kimi-code");
  }

  // Shim daemons read the secret from this file per call; `prism refresh`
  // never wipes the runtime dir, and live-mode cleanup removes it after the
  // run, so a run's secret never outlives that run.
  const qaRuntimeDir = join(activePrismHome, "runtime", "mcp", QA_PLUGIN_NAME);
  await mkdir(qaRuntimeDir, { recursive: true });
  await writeFile(join(qaRuntimeDir, CHALLENGE_PROOF_SECRET_FILENAME), proofSecret, { mode: 0o600 });

  const results: HarnessResult[] = [];
  let qaCleanup: WorkflowE2EQaCleanupSummary | undefined;

  try {
    for (const entry of entries) {
      const refresh = await runCommand([
        process.execPath,
        "run",
        "src/cli.ts",
        "refresh",
        pluginRoot,
        "--harness",
        entry.harness,
        "--scope",
        "global",
      ], env);

      const validate = await runCommand([
        process.execPath,
        "run",
        "src/cli.ts",
        "workflow",
        "validate",
        workflowPath(pluginRoot, entry),
      ], env);

      let run: CommandResult | undefined;
      let proof: HarnessResult["proof"];
      if (!validateOnly) {
        const store = join(STORE_ROOT, `prism-workflow-e2e-${mode}-${entry.harness}-${basename(entry.workflow)}.sqlite`);
        run = await runCommand([
          process.execPath,
          "run",
          "src/cli.ts",
          "workflow",
          "run",
          workflowPath(pluginRoot, entry),
          "--store",
          store,
          "--no-cache",
        ], env);
        proof = proofFromRun(entry, run, expectedProofFor(entry.challenge));
      }
      const checks = validateOnly
        ? undefined
        : evaluateHarnessChecks(entry, { run, proof, expectedProof: expectedProofFor(entry.challenge) }, { hermesAuthScope });
      const setupBlocker = classifySetupBlocker(entry, run);

      const partial: HarnessResult = {
        harness: entry.harness,
        workflow: entry.workflow,
        challenge: entry.challenge,
        refresh,
        validate,
        ...(run ? { run } : {}),
        ...(setupBlocker ? { setupBlocker } : {}),
        ...(proof ? { proof } : {}),
        ...(checks ? { checks } : {}),
      };

      const tower = await submitTowerEvidence(mode, partial, env);
      results.push({ ...partial, ...(tower ? { tower } : {}) });
    }

    if (shouldRunModelSelection) {
      modelSelection = await runModelSelectionScenario({ mode, pluginRoot, env, validateOnly, expectedProofFor });
    }
  } finally {
    if (mode === "live") {
      qaCleanup = await cleanupWorkflowE2EQaArtifacts({
        prismHome: livePrismHome,
        harnesses: qaCleanupHarnesses,
      });
    }
    if (!(mode === "temp" && hasFlag("--keep-temp"))) {
      await removeWorkflowE2ETempRoots(roots);
    } else {
      await writeFile("/tmp/prism-workflow-e2e-temp-roots.json", JSON.stringify({ roots }, null, 2));
    }
  }

  const pass = acceptancePass({ results, modelSelection, validateOnly }) && (qaCleanup?.success ?? true);

  console.log(JSON.stringify({
    schema: "prism.acceptance.workflow-e2e-matrix.v1",
    mode,
    pass,
    validateOnly,
    setupBlockers: results.flatMap((result) => result.setupBlocker ? [result.setupBlocker] : []),
    ...(hermesAuthScope !== undefined ? { hermesAuthScope } : {}),
    ...(hermesProfile !== undefined ? { hermesProfile } : {}),
    ...(configSeed ? { configSeed } : {}),
    ...(qaCleanup ? { qaCleanup } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    results,
  }, null, 2));

  process.exitCode = pass ? 0 : 1;
};

if (import.meta.main) {
  await main();
}
