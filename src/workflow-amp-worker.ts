import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface AmpWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

export class AmpWorkflowWorkerError extends Error {
  override readonly name = "AmpWorkflowWorkerError";
}

export type AmpWorkflowMode = "deep" | "rush";

export const assertAmpWorkflowMode = (mode: string | undefined): AmpWorkflowMode | undefined => {
  if (mode === undefined) return undefined;
  if (mode === "deep" || mode === "rush") return mode;
  throw new AmpWorkflowWorkerError(`unsupported Amp workflow mode '${mode}'. Supported modes: deep, rush`);
};

const assertAmpPermission = (mode: WorkflowPermissionMode): void => {
  switch (mode) {
    case "legacy":
    case "permissive":
    case "full-access":
      return;
    case "restricted":
      throw new WorkflowPermissionError(
        "amp-code",
        mode,
        "Amp Code has no CLI flag to restrict permissions per invocation. Choose 'legacy' or 'permissive' instead.",
      );
    case "interactive":
      throw new WorkflowPermissionError(
        "amp-code",
        mode,
        "Amp Code interactive mode is incompatible with Prism workflow execution. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-read-only":
      throw new WorkflowPermissionError(
        "amp-code",
        mode,
        "Amp Code has no read-only sandbox CLI flag. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-workspace-write":
      throw new WorkflowPermissionError(
        "amp-code",
        mode,
        "Amp Code has no workspace-write sandbox mode. Choose 'permissive' or 'legacy' instead.",
      );
  }
  return assertNeverWorkflowPermissionMode("amp-code", mode);
};

const defaultAmpSettingsPath = (): string =>
  process.env.AMP_SETTINGS_FILE ?? join(homedir(), ".config", "amp", "settings.json");

const readAmpSettings = async (settingsPath: string): Promise<Record<string, unknown>> => {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return {};
    throw new AmpWorkflowWorkerError(`Amp settings file '${settingsPath}' is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
};

const prepareAmpPermissionSettings = async (
  mode: WorkflowPermissionMode,
): Promise<{ readonly settingsFile?: string; readonly cleanup: () => Promise<void> }> => {
  if (mode !== "permissive" && mode !== "full-access") {
    return { cleanup: async () => undefined };
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "prism-workflow-amp-settings-"));
  const settingsFile = join(tempRoot, "settings.json");
  const settings = await readAmpSettings(defaultAmpSettingsPath());
  await writeFile(settingsFile, JSON.stringify({ ...settings, "amp.dangerouslyAllowAll": true }, null, 2));
  return {
    settingsFile,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
};

export const buildAmpArgs = (input: {
  readonly mode?: string;
  readonly prompt: string;
  readonly permission?: WorkflowPermissionMode;
  readonly settingsFile?: string;
}): ReadonlyArray<string> => {
  const mode = assertAmpWorkflowMode(input.mode);
  const resolvedPermission = input.permission ?? "permissive";
  assertAmpPermission(resolvedPermission);
  if ((resolvedPermission === "permissive" || resolvedPermission === "full-access") && input.settingsFile === undefined) {
    throw new AmpWorkflowWorkerError(
      `Amp ${resolvedPermission} workflow permission requires a generated settings file with amp.dangerouslyAllowAll enabled`,
    );
  }
  return [
    ...(input.settingsFile !== undefined ? ["--settings-file", input.settingsFile] : []),
    "--no-ide",
    "--no-notifications",
    "--no-color",
    "--no-archive-after-execute",
    ...(mode !== undefined ? ["--mode", mode] : []),
    "--execute",
    input.prompt,
  ];
};

export const runAmpWorkflowTask = async (
  task: AnyWorkflowTask,
  options: AmpWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_AMP_BIN ?? "amp";
  const prompt = `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_AMP_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  assertAmpPermission(options.resolvedPermission);
  const permissionSettings = await prepareAmpPermissionSettings(options.resolvedPermission);
  const args = buildAmpArgs({
    mode: options.model,
    prompt,
    permission: options.resolvedPermission,
    settingsFile: permissionSettings.settingsFile,
  });

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
  }).finally(() => permissionSettings.cleanup());
  if (aborted) {
    throw new AmpWorkflowWorkerError("amp was aborted by Prism workflow stop");
  }
  if (timedOut) {
    throw new AmpWorkflowWorkerError(`amp exceeded Prism process timeout after ${processTimeoutMs}ms`);
  }
  if (exitCode !== 0) {
    throw new AmpWorkflowWorkerError(`amp exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return {
    output: parseWorkflowWorkerJsonOutput(stdout),
    metadata: {
      adapter: "amp-code",
      model: options.model,
      durationMs,
      processTimeoutMs,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
