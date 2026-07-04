import { workflowWorkerHarnessIds, type WorkflowWorkerHarnessId } from "./lowerer-capabilities.js";
import type { HarnessId } from "./types.js";
import { workflowBunRuntime } from "./workflow-bun-runtime.js";
import { WorkflowBunRuntimeUnavailableError, WorkflowUnsupportedHarnessError } from "./workflow-errors.js";

/**
 * Workflow-worker harness ids, derived from the capability registry's
 * `workflowWorker` bit (`lowerer-capabilities.ts`) — the single source of
 * truth for this set (PQ-163). Never hand-list these ids here; add a harness
 * by flipping its `workflowWorker` capability in the registry, which also
 * forces `WORKFLOW_HARNESS_DETECTION_SPECS` below to gain the matching entry
 * at compile time.
 */
export const WORKFLOW_HARNESS_IDS: ReadonlyArray<WorkflowWorkerHarnessId> = workflowWorkerHarnessIds();

export type WorkflowHarnessId = WorkflowWorkerHarnessId;

export type WorkflowHarnessDetectionStatus = "available" | "missing" | "broken";

export type WorkflowHarnessDetectionReasonCode =
  | "executable-found"
  | "executable-missing"
  | "probe-succeeded"
  | "probe-exited-nonzero"
  | "probe-timed-out"
  | "probe-failed";

export interface WorkflowHarnessDetectionReason {
  readonly code: WorkflowHarnessDetectionReasonCode;
  readonly message: string;
  readonly command: string;
  readonly executablePath?: string;
  readonly exitCode?: number | null;
  readonly stderr?: string;
}

export interface WorkflowHarnessDetection {
  readonly schema: "prism.workflow-harness-detection.v1";
  readonly harness: WorkflowHarnessId;
  readonly available: boolean;
  readonly status: WorkflowHarnessDetectionStatus;
  readonly reason: WorkflowHarnessDetectionReason;
}

export interface WorkflowHarnessDetectionSpec {
  readonly harness: WorkflowHarnessId;
  readonly command: string;
  readonly envVar: string;
  readonly probeArgs: ReadonlyArray<string>;
  /**
   * Cheap-fast-tier model used by `resolveWorkflowTaskModel` when a task
   * declares this harness but nothing (task, profile, or CLI --model) supplies
   * a concrete model. Chosen from the empirical modelspace's throughput/triage
   * profiles (not the premium tier) so a scaffolded workflow never crashes at
   * run with "no concrete model for workflow worker X".
   */
  readonly defaultModel: string;
}

export interface WorkflowHarnessProbeRunResult {
  readonly exitCode: number | null;
  readonly stderr?: string;
  readonly timedOut?: boolean;
}

export interface WorkflowHarnessProbeRunOptions {
  readonly timeoutMs: number;
}

export interface WorkflowHarnessDetectionOptions {
  /**
   * Environment map used only to read Prism workflow binary override variables.
   * Defaults to process.env when omitted.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional executable resolver. Inject this in apps/tests to keep detection
   * deterministic and side-effect free.
   */
  readonly resolveExecutable?: (command: string) => string | undefined | Promise<string | undefined>;
  /**
   * When true, detection runs a short version probe after resolving the binary.
   * The default false mode only inspects PATH/override variables and is safe to
   * call during application startup: no files are written, no config is loaded,
   * and no harness process is spawned.
   */
  readonly verify?: boolean;
  readonly probeTimeoutMs?: number;
  readonly runProbe?: (
    command: string,
    args: ReadonlyArray<string>,
    options: WorkflowHarnessProbeRunOptions,
  ) => Promise<WorkflowHarnessProbeRunResult>;
}

export const WORKFLOW_HARNESS_DETECTION_SPECS: Readonly<Record<WorkflowHarnessId, WorkflowHarnessDetectionSpec>> = {
  "amp-code": {
    harness: "amp-code",
    command: "amp",
    envVar: "PRISM_WORKFLOW_AMP_BIN",
    probeArgs: ["--version"],
    // "rush" is Amp's fast mode (vs. "deep"); the only two valid values.
    defaultModel: "rush",
  },
  "antigravity-cli": {
    harness: "antigravity-cli",
    command: "agy",
    envVar: "PRISM_WORKFLOW_ANTIGRAVITY_BIN",
    probeArgs: ["--version"],
    defaultModel: "Gemini 3.5 Flash (Low)",
  },
  "claude-code": {
    harness: "claude-code",
    command: "claude",
    envVar: "PRISM_WORKFLOW_CLAUDE_BIN",
    probeArgs: ["--version"],
    defaultModel: "claude-haiku-4-5",
  },
  "codex-cli": {
    harness: "codex-cli",
    command: "codex",
    envVar: "PRISM_WORKFLOW_CODEX_BIN",
    probeArgs: ["--version"],
    defaultModel: "gpt-5.4-mini",
  },
  grok: {
    harness: "grok",
    command: "grok",
    envVar: "PRISM_WORKFLOW_GROK_BIN",
    probeArgs: ["--version"],
    defaultModel: "grok-build",
  },
  hermes: {
    harness: "hermes",
    command: "hermes",
    envVar: "PRISM_WORKFLOW_HERMES_BIN",
    probeArgs: ["--version"],
    defaultModel: "grok-composer-2.5-fast",
  },
  "kimi-code": {
    harness: "kimi-code",
    command: "kimi",
    envVar: "PRISM_WORKFLOW_KIMI_BIN",
    probeArgs: ["--version"],
    defaultModel: "kimi-code/kimi-for-coding",
  },
  opencode: {
    harness: "opencode",
    command: "opencode",
    envVar: "PRISM_WORKFLOW_OPENCODE_BIN",
    probeArgs: ["--version"],
    defaultModel: "synthetic/hf:moonshotai/Kimi-K2.6",
  },
} as const;

const workflowHarnessIdSet = new Set<string>(WORKFLOW_HARNESS_IDS);

export const isWorkflowHarnessId = (id: string): id is WorkflowHarnessId =>
  workflowHarnessIdSet.has(id);

/**
 * Cheap-fast-tier default model for a workflow harness, or `undefined` for an
 * id outside the registry. Single source of truth for `resolveWorkflowTaskModel`
 * (src/workflows.ts) — do not hand-maintain a second per-harness default list.
 */
export const workflowHarnessDefaultModel = (harness: string): string | undefined =>
  isWorkflowHarnessId(harness) ? WORKFLOW_HARNESS_DETECTION_SPECS[harness].defaultModel : undefined;

export const workflowHarnessIdsForHarnesses = (
  harnesses: ReadonlyArray<HarnessId>,
): WorkflowHarnessId[] =>
  harnesses.filter((harness): harness is WorkflowHarnessId => isWorkflowHarnessId(harness));

const defaultResolveExecutable = (command: string): string | undefined =>
  workflowBunRuntime("harness executable discovery").which(command) ?? undefined;

const defaultRunProbe = async (
  command: string,
  args: ReadonlyArray<string>,
  options: WorkflowHarnessProbeRunOptions,
): Promise<WorkflowHarnessProbeRunResult> => {
  const child = workflowBunRuntime("harness probe execution").spawn({
    cmd: [command, ...args],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);
  try {
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      stderr: stderr.trim(),
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const detection = (input: {
  readonly harness: WorkflowHarnessId;
  readonly available: boolean;
  readonly status: WorkflowHarnessDetectionStatus;
  readonly reason: WorkflowHarnessDetectionReason;
}): WorkflowHarnessDetection => ({
  schema: "prism.workflow-harness-detection.v1",
  ...input,
});

const commandForSpec = (
  spec: WorkflowHarnessDetectionSpec,
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const override = env[spec.envVar];
  return override && override.trim().length > 0 ? override : spec.command;
};

export const detectWorkflowHarness = async (
  harness: WorkflowHarnessId,
  options: WorkflowHarnessDetectionOptions = {},
): Promise<WorkflowHarnessDetection> => {
  if (!isWorkflowHarnessId(harness)) {
    throw new WorkflowUnsupportedHarnessError(String(harness), WORKFLOW_HARNESS_IDS);
  }
  const spec = WORKFLOW_HARNESS_DETECTION_SPECS[harness];
  const env = options.env ?? process.env;
  const command = commandForSpec(spec, env);
  const resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable;
  const executablePath = await resolveExecutable(command);

  if (executablePath === undefined) {
    return detection({
      harness,
      available: false,
      status: "missing",
      reason: {
        code: "executable-missing",
        command,
        message: `${spec.harness} workflow harness executable '${command}' was not found`,
      },
    });
  }

  if (options.verify !== true) {
    return detection({
      harness,
      available: true,
      status: "available",
      reason: {
        code: "executable-found",
        command,
        executablePath,
        message: `${spec.harness} workflow harness executable was found`,
      },
    });
  }

  const runProbe = options.runProbe ?? defaultRunProbe;
  try {
    const result = await runProbe(executablePath, spec.probeArgs, {
      timeoutMs: options.probeTimeoutMs ?? 2_000,
    });
    if (result.timedOut === true) {
      return detection({
        harness,
        available: false,
        status: "broken",
        reason: {
          code: "probe-timed-out",
          command,
          executablePath,
          exitCode: result.exitCode,
          ...(result.stderr ? { stderr: result.stderr } : {}),
          message: `${spec.harness} workflow harness probe timed out`,
        },
      });
    }
    if (result.exitCode !== 0) {
      return detection({
        harness,
        available: false,
        status: "broken",
        reason: {
          code: "probe-exited-nonzero",
          command,
          executablePath,
          exitCode: result.exitCode,
          ...(result.stderr ? { stderr: result.stderr } : {}),
          message: `${spec.harness} workflow harness probe exited with code ${String(result.exitCode)}`,
        },
      });
    }
    return detection({
      harness,
      available: true,
      status: "available",
      reason: {
        code: "probe-succeeded",
        command,
        executablePath,
        message: `${spec.harness} workflow harness probe succeeded`,
      },
    });
  } catch (error) {
    if (error instanceof WorkflowBunRuntimeUnavailableError) {
      throw error;
    }
    return detection({
      harness,
      available: false,
      status: "broken",
      reason: {
        code: "probe-failed",
        command,
        executablePath,
        message: `${spec.harness} workflow harness probe failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
  }
};

export const detectWorkflowHarnesses = async (
  options: WorkflowHarnessDetectionOptions & {
    readonly harnesses?: ReadonlyArray<WorkflowHarnessId>;
  } = {},
): Promise<ReadonlyArray<WorkflowHarnessDetection>> => {
  const harnesses = options.harnesses ?? WORKFLOW_HARNESS_IDS;
  return Promise.all(harnesses.map((harness) => detectWorkflowHarness(harness, options)));
};
