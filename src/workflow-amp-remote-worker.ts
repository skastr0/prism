/**
 * Remote Amp workflow workers: `amp-orb` (a hosted orb per task thread) and
 * `amp-runner` (Amp executing on an operator-declared `amp --no-tui` runner).
 *
 * Both dispatch through the local amp CLI with `--stream-json`, which stays
 * attached until the remote turn ends and emits the same JSONL the amp-code
 * worker parses; its `session_id` is the stable thread id. Killing the local
 * CLI cancels the remote turn, so Prism's process-tree abort is also the
 * remote cancel. Repair continues the same thread with
 * `amp threads continue <id> --orb-execute`, which runs on that thread's own
 * remote executor.
 */
import { isAbsolute, resolve } from "node:path";
import {
  AMP_ORB_SIZES,
  AMP_THREAD_VISIBILITIES,
  type AmpOrbSize,
  type AmpRemoteWorkflowWorkerId,
  type AmpThreadVisibility,
  type AnyWorkflowWorkerTask,
  type WorkflowPermissionMode,
} from "./workflows.js";
import {
  AmpWorkflowWorkerError,
  ampSessionId,
  ampWorkerPins,
  ampWorkflowHonestMetadata,
  findExistingAmpCatalogMode,
  parseAmpStreamJsonError,
  parseAmpStreamJsonResult,
  prepareAmpCatalogPin,
  resolveAmpCatalogPinPlan,
  type AmpCatalogPinPlan,
} from "./workflow-amp-worker.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskProgressReporter, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr, workflowWorkerFailureMetadata } from "./workflow-worker-metadata.js";
import { runWorkflowWorkerProcess } from "./workflow-worker-process.js";

export interface AmpOrbTarget {
  readonly worker: "amp-orb";
  readonly project: string;
  readonly size?: AmpOrbSize;
  readonly visibility?: AmpThreadVisibility;
  readonly labels?: ReadonlyArray<string>;
}

export interface AmpRunnerTarget {
  readonly worker: "amp-runner";
  readonly runnerId: string;
  readonly runnerDir?: string;
  readonly labels?: ReadonlyArray<string>;
}

export type AmpRemoteTarget = AmpOrbTarget | AmpRunnerTarget;

export type AmpRemoteWorkflowWorkerOptions<W extends AmpRemoteWorkflowWorkerId = AmpRemoteWorkflowWorkerId> = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
} & WorkflowTaskRepairLoopOption<W>;

const REMOTE_PERMISSION_REMEDIATION =
  "Orb/runner tool permissions are governed by the remote machine's Amp settings or ampcode.com project settings; Prism cannot override them per invocation. Configure them there and set worker.permission to 'legacy' (the default), or use worker 'amp-code' for local permission control.";

/** Remote executors accept only `legacy`: no per-invocation override reaches the remote amp process. */
export const assertAmpRemotePermission = (worker: AmpRemoteWorkflowWorkerId, mode: WorkflowPermissionMode): void => {
  switch (mode) {
    case "legacy":
      return;
    case "permissive":
    case "full-access":
    case "restricted":
    case "interactive":
    case "sandbox-read-only":
    case "sandbox-workspace-write":
      throw new WorkflowPermissionError(worker, mode, `${worker} cannot apply permission '${mode}'. ${REMOTE_PERMISSION_REMEDIATION}`);
  }
  return assertNeverWorkflowPermissionMode(worker, mode);
};

const fieldError = (taskId: string, worker: AmpRemoteWorkflowWorkerId, message: string): AmpWorkflowWorkerError =>
  new AmpWorkflowWorkerError(`workflow task '${taskId}' worker '${worker}': ${message}`);

const readNonBlank = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const readLabels = (taskId: string, worker: AmpRemoteWorkflowWorkerId, value: unknown): ReadonlyArray<string> | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((label) => readNonBlank(label) === undefined)) {
    throw fieldError(taskId, worker, "worker.labels must be an array of non-blank strings, e.g. labels: [\"prism\"].");
  }
  return value.map((label: string) => label.trim());
};

const readEnum = <T extends string>(
  taskId: string,
  worker: AmpRemoteWorkflowWorkerId,
  field: string,
  allowed: ReadonlyArray<T>,
  value: unknown,
): T | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)) return value as T;
  throw fieldError(taskId, worker, `worker.${field} ${JSON.stringify(value)} is not one of ${allowed.join(", ")}.`);
};

/**
 * Read the remote target from the task's own worker options. The DSL types make
 * these fields required; this check covers untyped workflow files and a
 * CLI-only `--worker amp-orb` fallback, which carries no target.
 */
export const ampRemoteTargetOf = (worker: AmpRemoteWorkflowWorkerId, task: AnyWorkflowWorkerTask): AmpRemoteTarget => {
  const options = (task.worker?.worker === worker ? task.worker : {}) as Record<string, unknown>;
  const labels = readLabels(task.id, worker, options.labels);
  if (worker === "amp-orb") {
    const project = readNonBlank(options.project);
    if (project === undefined) {
      throw fieldError(
        task.id,
        worker,
        "worker.project is required: the Amp project the orb checks out (namespace/name, owner/repo, or repository URL). Add worker: { worker: \"amp-orb\", project: \"<owner>/<repo>\" }.",
      );
    }
    const size = readEnum(task.id, worker, "size", AMP_ORB_SIZES, options.size);
    const visibility = readEnum(task.id, worker, "visibility", AMP_THREAD_VISIBILITIES, options.visibility);
    return {
      worker,
      project,
      ...(size !== undefined ? { size } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(labels !== undefined ? { labels } : {}),
    };
  }
  const runnerId = readNonBlank(options.runnerId);
  if (runnerId === undefined) {
    throw fieldError(
      task.id,
      worker,
      "worker.runnerId is required: the id a runner was started with (`amp --no-tui --runner-id <id>`). Add worker: { worker: \"amp-runner\", runnerId: \"<id>\" }.",
    );
  }
  let runnerDir: string | undefined;
  if (options.runnerDir !== undefined) {
    runnerDir = readNonBlank(options.runnerDir);
    if (runnerDir === undefined || !isAbsolute(runnerDir)) {
      throw fieldError(task.id, worker, `worker.runnerDir ${JSON.stringify(options.runnerDir)} must be an absolute directory the runner serves.`);
    }
  }
  return {
    worker,
    runnerId,
    ...(runnerDir !== undefined ? { runnerDir } : {}),
    ...(labels !== undefined ? { labels } : {}),
  };
};

const PIN_REMEDIATION =
  "Commit a plugin mode binding the catalog slug to the repository's .amp/plugins and set worker.model to its key, or use a dial (low|medium|high|ultra).";

/**
 * The Prism catalog-pin plugin is written under the local cwd. It exists for
 * the remote executor only when a runner serves exactly that directory.
 */
export const resolveAmpRemotePinPlan = (input: {
  readonly target: AmpRemoteTarget;
  readonly cwd: string;
  readonly mode?: string;
  readonly catalogModel?: string;
  readonly effort?: string;
}): AmpCatalogPinPlan => {
  const plan = resolveAmpCatalogPinPlan(input);
  if (plan.kind === "mode") return plan;
  if (input.target.worker === "amp-orb") {
    throw new AmpWorkflowWorkerError(`amp-orb cannot use worker.catalogModel/effort: the pin plugin Prism writes is local and the orb runs its own checkout. ${PIN_REMEDIATION}`);
  }
  const { runnerDir } = input.target;
  if (runnerDir === undefined || resolve(runnerDir) !== resolve(input.cwd)) {
    throw new AmpWorkflowWorkerError(
      `amp-runner worker.catalogModel/effort needs worker.runnerDir set to the workflow's working directory (${input.cwd}), where Prism writes the pin plugin; runnerDir is ${runnerDir === undefined ? "unset (the runner's own start directory)" : JSON.stringify(runnerDir)}. Set runnerDir: ${JSON.stringify(input.cwd)}, or: ${PIN_REMEDIATION}`,
    );
  }
  return plan;
};

const STREAM_FLAGS = ["--stream-json", "--no-ide", "--no-notifications", "--no-color", "--no-archive-after-execute"] as const;

const commonTail = (input: {
  readonly title?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly mode?: string;
  readonly pluginReadyTimeout?: boolean;
}): string[] => [
  ...(input.title !== undefined ? ["--title", input.title] : []),
  ...(input.labels ?? []).flatMap((label) => ["--label", label]),
  ...(input.mode !== undefined ? ["--mode", input.mode] : []),
  ...(input.pluginReadyTimeout === true ? ["--plugin-ready-timeout"] : []),
];

/** New orb thread, attached until the turn ends. */
export const buildAmpOrbArgs = (input: {
  readonly target: AmpOrbTarget;
  readonly prompt: string;
  readonly title?: string;
  readonly mode?: string;
}): ReadonlyArray<string> => [
  "--orb-execute",
  "--execute",
  input.prompt,
  ...STREAM_FLAGS,
  "--project",
  input.target.project,
  ...(input.target.size !== undefined ? ["--orb-size", input.target.size] : []),
  ...(input.target.visibility !== undefined ? ["--visibility", input.target.visibility] : []),
  ...commonTail({ title: input.title, labels: input.target.labels, mode: input.mode }),
];

/** New runner thread, attached until the turn ends. */
export const buildAmpRunnerArgs = (input: {
  readonly target: AmpRunnerTarget;
  readonly prompt: string;
  readonly title?: string;
  readonly mode?: string;
  readonly pluginReadyTimeout?: boolean;
}): ReadonlyArray<string> => [
  "--execute",
  input.prompt,
  ...STREAM_FLAGS,
  "--executor",
  `runner:${input.target.runnerId}`,
  ...(input.target.runnerDir !== undefined ? ["--runner-dir", input.target.runnerDir] : []),
  ...commonTail({
    title: input.title,
    labels: input.target.labels,
    mode: input.mode,
    pluginReadyTimeout: input.pluginReadyTimeout,
  }),
];

/**
 * Same-thread repair. `--orb-execute` sends the message to the thread's own
 * remote executor (orb or runner); `--executor`/`--runner-dir` do not apply.
 */
export const buildAmpRemoteContinueArgs = (input: {
  readonly sessionId: string;
  readonly prompt: string;
}): ReadonlyArray<string> => [
  "threads",
  "continue",
  input.sessionId,
  "--orb-execute",
  "--execute",
  input.prompt,
  "--stream-json",
  "--no-color",
];

const targetMetadata = (target: AmpRemoteTarget): Record<string, unknown> =>
  target.worker === "amp-orb"
    ? { ampProject: target.project, ...(target.size !== undefined ? { orbSize: target.size } : {}) }
    : { ampRunner: target.runnerId, ...(target.runnerDir !== undefined ? { ampRunnerDir: target.runnerDir } : {}) };

const runAmpRemoteWorkflowTask = async <W extends AmpRemoteWorkflowWorkerId>(
  worker: W,
  task: AnyWorkflowWorkerTask,
  options: AmpRemoteWorkflowWorkerOptions<W>,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_AMP_BIN ?? "amp";
  assertAmpRemotePermission(worker, options.resolvedPermission);
  const target = ampRemoteTargetOf(worker, task);
  const pins = ampWorkerPins(task);
  let pin = resolveAmpRemotePinPlan({ target, cwd: options.cwd, mode: options.model, ...pins });
  if (pin.kind === "pin") {
    const existing = await findExistingAmpCatalogMode(options.cwd, pins);
    if (existing !== undefined) pin = { kind: "mode", mode: existing };
  }
  const sessionId = options.repair?.mode === "native-continuation" ? options.repair.continuation.sessionId : undefined;
  const prompt = options.repair !== undefined
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const title = `prism ${task.id}`;
  const args = sessionId !== undefined
    ? buildAmpRemoteContinueArgs({ sessionId, prompt })
    : target.worker === "amp-orb"
      ? buildAmpOrbArgs({ target, prompt, title, mode: pin.mode })
      : buildAmpRunnerArgs({ target, prompt, title, mode: pin.mode, pluginReadyTimeout: pin.kind === "pin" });

  const catalogPin = await prepareAmpCatalogPin(options.cwd, pin);
  const { exitCode, stdout, stderr, durationMs, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    onOutputActivity: (stream) => options.reportProgress?.(`worker-${stream}`),
  }).finally(() => catalogPin.cleanup());
  const threadId = ampSessionId(stdout, stderr) ?? sessionId;
  const failureMetadata = (): Record<string, unknown> => ({
    ...workflowWorkerFailureMetadata({ adapter: worker, stderr, sessionId: threadId }),
    ...targetMetadata(target),
    ...(threadId !== undefined ? { ampThread: threadId } : {}),
  });
  if (aborted) {
    throw new AmpWorkflowWorkerError(`amp ${worker} was aborted by Prism workflow stop; the attached remote turn is cancelled with it`, failureMetadata());
  }
  const streamError = parseAmpStreamJsonError(stdout);
  if (exitCode !== 0 || streamError !== undefined) {
    throw new AmpWorkflowWorkerError(
      `amp ${worker} exited with ${exitCode}: ${streamError ?? (stderr.trim() || stdout.trim())}`,
      failureMetadata(),
    );
  }
  const outputText = parseAmpStreamJsonResult(stdout) ?? stdout;
  return {
    output: parseWorkflowWorkerJsonOutput(outputText),
    metadata: {
      adapter: worker,
      ...ampWorkflowHonestMetadata({ pin, authoredModel: options.model, ...pins }),
      ...targetMetadata(target),
      durationMs,
      ...(threadId !== undefined ? { sessionId: threadId, ampThread: threadId } : {}),
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};

export const runAmpOrbWorkflowTask = (
  task: AnyWorkflowWorkerTask,
  options: AmpRemoteWorkflowWorkerOptions<"amp-orb">,
): Promise<WorkflowTaskExecution> => runAmpRemoteWorkflowTask("amp-orb", task, options);

export const runAmpRunnerWorkflowTask = (
  task: AnyWorkflowWorkerTask,
  options: AmpRemoteWorkflowWorkerOptions<"amp-runner">,
): Promise<WorkflowTaskExecution> => runAmpRemoteWorkflowTask("amp-runner", task, options);
