import { homedir } from "node:os";
import { join } from "node:path";
import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr, workflowWorkerFailureMetadata } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskProgressReporter, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";
import { stableSessionIdFromJsonLines } from "./workflow-session.js";

export type KimiWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly kimiHome?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
} & WorkflowTaskRepairLoopOption<"kimi-code">;

const defaultKimiCodeHome = (): string =>
  process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");

export class KimiWorkflowWorkerError extends Error {
  override readonly name = "KimiWorkflowWorkerError";
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    if (metadata !== undefined) this.metadata = metadata;
  }
}

const KIMI_AUTH_OUTPUT_PATTERN =
  /(^|\n)\s*(?:error:\s*)?(?:failed to run prompt:\s*)?auth\.login_required:[^{}\n]*requires login[^{}\n]*/iu;

const KIMI_AUTH_PROMPT_PATTERNS = [
  {
    name: "kimi-oauth-login-required",
    pattern: KIMI_AUTH_OUTPUT_PATTERN,
  },
] as const;

export const isKimiAuthOutput = (output: string): boolean =>
  KIMI_AUTH_OUTPUT_PATTERN.test(output);

const kimiAuthErrorMessage =
  "kimi-code requires OAuth login before workflow run; run `kimi login` or refresh Kimi Code credentials, then retry";

const generatedKimiPluginId = (sourcePluginName: string): string =>
  `prism-generated-${sourcePluginName}`;

const generatedRoleSkillName = (agentName: string): string =>
  `prism-agent-${agentName}`;

const parseKimiStreamJsonOutput = (stdout: string): string => {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "role" in parsed &&
        parsed.role === "assistant" &&
        "content" in parsed &&
        typeof parsed.content === "string"
      ) {
        return parsed.content;
      }
    } catch {
      // Ignore malformed JSON lines; the stream may contain non-JSON markers.
    }
  }
  throw new KimiWorkflowWorkerError("kimi-code stream-json output did not contain an assistant message");
};

export const kimiSessionIdFromStream = (stdout: string): string | undefined =>
  stableSessionIdFromJsonLines(stdout, ["session_id", "sessionId", "sessionID"]);

const assertKimiPermission = (mode: WorkflowPermissionMode): void => {
  switch (mode) {
    case "legacy":
    case "permissive":
    case "full-access":
      return;
    case "restricted":
      throw new WorkflowPermissionError(
        "kimi-code",
        mode,
        "Kimi Code has no CLI flag to restrict permissions per invocation. Choose 'legacy' or 'permissive' instead.",
      );
    case "interactive":
      throw new WorkflowPermissionError(
        "kimi-code",
        mode,
        "Kimi Code interactive mode is incompatible with Prism workflow execution. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-read-only":
      throw new WorkflowPermissionError(
        "kimi-code",
        mode,
        "Kimi Code has no read-only sandbox CLI flag. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-workspace-write":
      throw new WorkflowPermissionError(
        "kimi-code",
        mode,
        "Kimi Code has no workspace-write sandbox mode. Choose 'permissive' or 'legacy' instead.",
      );
  }
  return assertNeverWorkflowPermissionMode("kimi-code", mode);
};

export const buildKimiArgs = (input: {
  readonly model?: string;
  readonly prompt: string;
  readonly skillsDir: string;
  readonly sessionId?: string;
  readonly permission?: WorkflowPermissionMode;
}): ReadonlyArray<string> => {
  const mode = input.permission ?? "permissive";
  assertKimiPermission(mode);
  // Kimi prompt mode rejects `--prompt` combined with `--yolo`; workflow execution
  // must stay in prompt mode so permissive/full-access map to the strongest
  // compatible invocation rather than an invalid flag pair.
  return [
    ...(input.model !== undefined ? ["--model", input.model] : []),
    ...(input.sessionId !== undefined ? ["--session", input.sessionId] : []),
    "--output-format",
    "stream-json",
    "--prompt",
    input.prompt,
    "--skills-dir",
    input.skillsDir,
  ];
};

export const runKimiWorkflowTask = async (
  task: AnyWorkflowTask,
  options: KimiWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_KIMI_BIN ?? "kimi";
  const roleSkill = generatedRoleSkillName(task.agent.name);
  const sessionId = options.repair?.mode === "native-continuation" ? options.repair.continuation.sessionId : undefined;
  const prompt = options.repair !== undefined
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `You are assigned the ${roleSkill} Prism role. ${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const kimiHome = options.kimiHome ?? defaultKimiCodeHome();

  const args = buildKimiArgs({
    model: options.model,
    prompt,
    skillsDir: join(kimiHome, "plugins", "managed", generatedKimiPluginId(task.agent.plugin), "skills"),
    sessionId,
    permission: options.resolvedPermission,
  });

  const { exitCode, stdout, stderr, durationMs, aborted, earlyExit } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    onOutputActivity: (stream) => options.reportProgress?.(`worker-${stream}`),
    env: { KIMI_CODE_HOME: kimiHome },
    earlyExitPatterns: KIMI_AUTH_PROMPT_PATTERNS,
  });
  if (aborted) {
    throw new KimiWorkflowWorkerError(
      "kimi-code was aborted by Prism workflow stop",
      workflowWorkerFailureMetadata({ adapter: "kimi-code", stderr, sessionId: kimiSessionIdFromStream(stdout) ?? sessionId }),
    );
  }
  if (earlyExit === "kimi-oauth-login-required") {
    throw new KimiWorkflowWorkerError(
      kimiAuthErrorMessage,
      workflowWorkerFailureMetadata({ adapter: "kimi-code", stderr, sessionId: kimiSessionIdFromStream(stdout) ?? sessionId }),
    );
  }
  if (exitCode !== 0 && isKimiAuthOutput(`${stdout}\n${stderr}`)) {
    throw new KimiWorkflowWorkerError(
      kimiAuthErrorMessage,
      workflowWorkerFailureMetadata({ adapter: "kimi-code", stderr, sessionId: kimiSessionIdFromStream(stdout) ?? sessionId }),
    );
  }
  if (exitCode !== 0) {
    throw new KimiWorkflowWorkerError(
      `kimi-code exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      workflowWorkerFailureMetadata({ adapter: "kimi-code", stderr, sessionId: kimiSessionIdFromStream(stdout) ?? sessionId }),
    );
  }
  let kimiText: string;
  try {
    kimiText = parseKimiStreamJsonOutput(stdout);
  } catch (error) {
    if (error instanceof KimiWorkflowWorkerError) {
      throw new KimiWorkflowWorkerError(
        error.message,
        workflowWorkerFailureMetadata({ adapter: "kimi-code", stderr, sessionId: kimiSessionIdFromStream(stdout) ?? sessionId }),
      );
    }
    throw error;
  }
  return {
    output: parseWorkflowWorkerJsonOutput(kimiText),
    metadata: {
      adapter: "kimi-code",
      prompted: true,
      agentSelection: "prompted-contract",
      source: "prism-workflow",
      agent: {
        plugin: task.agent.plugin,
        name: task.agent.name,
        manifestHash: task.agent.manifestHash,
      },
      model: options.model,
      durationMs,
      sessionId: kimiSessionIdFromStream(stdout) ?? sessionId,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
