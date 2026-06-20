/**
 * Acceptance gate: Prism workflow generated-tool E2E matrix.
 *
 * Modes:
 *   temp  — use temporary HOME and PRISM_HOME; useful for repeatable root/config learning.
 *   live  — use the operator's current harness configs; optional Tower reporting.
 *
 * Usage:
 *   bun scripts/acceptance/workflow-e2e-matrix.ts --mode temp
 *   bun scripts/acceptance/workflow-e2e-matrix.ts --mode live --tower
 */
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PLUGIN_PATH = resolve(REPO_ROOT, "examples", "prism-harness-qa");
const STORE_ROOT = "/tmp";
const WORKFLOW_HARNESSES = ["opencode", "claude-code", "codex-cli", "grok", "hermes", "kimi-code", "amp-code"] as const;
const COMPILED_AGENT_HARNESSES = ["opencode", "claude-code", "codex-cli", "grok", "kimi-code", "amp-code"] as const;

type Harness = "opencode" | "claude-code" | "codex-cli" | "grok" | "hermes" | "kimi-code" | "amp-code";
type Mode = "temp" | "live";

interface MatrixEntry {
  readonly harness: Harness;
  readonly workflow: string;
  readonly challenge: string;
}

const MATRIX: readonly MatrixEntry[] = [
  { harness: "opencode", workflow: "smoke-opencode.workflow.ts", challenge: "opencode-2026-06-20-001" },
  { harness: "claude-code", workflow: "smoke-claude-code.workflow.ts", challenge: "claude-code-2026-06-20-001" },
  { harness: "codex-cli", workflow: "smoke-codex-cli.workflow.ts", challenge: "codex-cli-2026-06-20-001" },
  { harness: "grok", workflow: "smoke-grok.workflow.ts", challenge: "grok-2026-06-20-001" },
  { harness: "hermes", workflow: "smoke-hermes.workflow.ts", challenge: "hermes-2026-06-20-001" },
  { harness: "kimi-code", workflow: "smoke-kimi-code.workflow.ts", challenge: "kimi-code-2026-06-20-001" },
  { harness: "amp-code", workflow: "smoke-amp-code-deep.workflow.ts", challenge: "amp-code-deep-2026-06-20-001" },
  { harness: "amp-code", workflow: "smoke-amp-code-rush.workflow.ts", challenge: "amp-code-rush-2026-06-20-001" },
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
  readonly proof?: {
    readonly pass: boolean;
    readonly output?: unknown;
    readonly metadata?: unknown;
    readonly detail?: string;
  };
  readonly tower?: CommandResult | { readonly skipped: string };
}

const args = process.argv.slice(2);

const argValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
};

const hasFlag = (name: string): boolean => args.includes(name);

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
  const parent = await mkdtemp(join(tmpdir(), "prism-workflow-e2e-plugin-"));
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

const workflowPath = (pluginRoot: string, entry: MatrixEntry): string =>
  join(pluginRoot, "workflows", entry.workflow);

const proofFromRun = (entry: MatrixEntry, run: CommandResult): HarnessResult["proof"] => {
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
      output?.proof === `prism-tool-proof:${entry.challenge}` &&
      output?.source === "prism-generated-tool";
    return {
      pass,
      output,
      metadata: task?.metadata,
      ...(pass ? {} : { detail: "deterministic generated-tool proof did not match" }),
    };
  } catch (error) {
    return {
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

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
    "glyph",
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

const main = async (): Promise<void> => {
  const mode = parseMode();
  const selected = parseHarnesses();
  const validateOnly = hasFlag("--validate-only");
  const roots: string[] = [];
  const env: Record<string, string | undefined> = {};
  const pluginRoot = await preparePluginRoot(roots);

  if (mode === "temp") {
    const home = await mkdtemp(join(tmpdir(), "prism-workflow-e2e-home-"));
    const prismHome = await mkdtemp(join(tmpdir(), "prism-workflow-e2e-prism-home-"));
    roots.push(home, prismHome);
    env.HOME = home;
    env.PRISM_HOME = prismHome;
    env.KIMI_CODE_HOME = join(home, ".kimi-code");
  }

  const entries = MATRIX.filter((entry) => selected === undefined || selected.includes(entry.harness));
  const results: HarnessResult[] = [];

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
        proof = proofFromRun(entry, run);
      }

      const partial: HarnessResult = {
        harness: entry.harness,
        workflow: entry.workflow,
        challenge: entry.challenge,
        refresh,
        validate,
        ...(run ? { run } : {}),
        ...(proof ? { proof } : {}),
      };

      const tower = await submitTowerEvidence(mode, partial, env);
      results.push({ ...partial, ...(tower ? { tower } : {}) });
    }
  } finally {
    if (!(mode === "temp" && hasFlag("--keep-temp"))) {
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    } else {
      await writeFile("/tmp/prism-workflow-e2e-temp-roots.json", JSON.stringify({ roots }, null, 2));
    }
  }

  const pass = results.every((result) =>
    result.refresh.exitCode === 0 &&
    result.validate.exitCode === 0 &&
    (validateOnly || result.proof?.pass === true),
  );

  console.log(JSON.stringify({
    schema: "prism.acceptance.workflow-e2e-matrix.v1",
    mode,
    pass,
    validateOnly,
    results,
  }, null, 2));

  process.exitCode = pass ? 0 : 1;
};

await main();
