import type { HarnessId } from "./types.js";
import { WorkflowBunRuntimeUnavailableError } from "./workflow-errors.js";
import type { WorkflowWorkerId } from "./workflows.js";

export const WORKFLOW_HARNESS_IDS = [
  "amp-code",
  "antigravity-cli",
  "claude-code",
  "codex-cli",
  "grok",
  "hermes",
  "kimi-code",
  "opencode",
] as const satisfies ReadonlyArray<WorkflowWorkerId>;

export type WorkflowHarnessId = (typeof WORKFLOW_HARNESS_IDS)[number];

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
  },
  "antigravity-cli": {
    harness: "antigravity-cli",
    command: "agy",
    envVar: "PRISM_WORKFLOW_ANTIGRAVITY_BIN",
    probeArgs: ["--version"],
  },
  "claude-code": {
    harness: "claude-code",
    command: "claude",
    envVar: "PRISM_WORKFLOW_CLAUDE_BIN",
    probeArgs: ["--version"],
  },
  "codex-cli": {
    harness: "codex-cli",
    command: "codex",
    envVar: "PRISM_WORKFLOW_CODEX_BIN",
    probeArgs: ["--version"],
  },
  grok: {
    harness: "grok",
    command: "grok",
    envVar: "PRISM_WORKFLOW_GROK_BIN",
    probeArgs: ["--version"],
  },
  hermes: {
    harness: "hermes",
    command: "hermes",
    envVar: "PRISM_WORKFLOW_HERMES_BIN",
    probeArgs: ["--version"],
  },
  "kimi-code": {
    harness: "kimi-code",
    command: "kimi",
    envVar: "PRISM_WORKFLOW_KIMI_BIN",
    probeArgs: ["--version"],
  },
  opencode: {
    harness: "opencode",
    command: "opencode",
    envVar: "PRISM_WORKFLOW_OPENCODE_BIN",
    probeArgs: ["--version"],
  },
} as const;

const workflowHarnessIdSet = new Set<string>(WORKFLOW_HARNESS_IDS);

export const isWorkflowHarnessId = (id: string): id is WorkflowHarnessId =>
  workflowHarnessIdSet.has(id);

export const workflowHarnessIdsForHarnesses = (
  harnesses: ReadonlyArray<HarnessId>,
): WorkflowHarnessId[] =>
  harnesses.filter((harness): harness is WorkflowHarnessId => isWorkflowHarnessId(harness));

const defaultResolveExecutable = (command: string): string | undefined =>
  bunRuntime("harness executable discovery").which(command) ?? undefined;

const defaultRunProbe = async (
  command: string,
  args: ReadonlyArray<string>,
  options: WorkflowHarnessProbeRunOptions,
): Promise<WorkflowHarnessProbeRunResult> => {
  const child = bunRuntime("harness probe execution").spawn({
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

interface HarnessDetectionBunRuntime {
  which(name: string): string | null;
  spawn(options: {
    readonly cmd: ReadonlyArray<string>;
    readonly stdin: "ignore";
    readonly stdout: "ignore";
    readonly stderr: "pipe";
  }): {
    readonly stderr: ReadableStream<Uint8Array>;
    readonly exited: Promise<number | null>;
    kill(signal?: NodeJS.Signals | number): void;
  };
}

const bunRuntime = (capability: string): HarnessDetectionBunRuntime => {
  const bun = (globalThis as typeof globalThis & { readonly Bun?: Partial<HarnessDetectionBunRuntime> }).Bun;
  if (bun?.spawn === undefined || bun.which === undefined) {
    throw new WorkflowBunRuntimeUnavailableError(capability);
  }
  return bun as HarnessDetectionBunRuntime;
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
