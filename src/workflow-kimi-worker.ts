import { homedir } from "node:os";
import { join } from "node:path";
import type { AnyWorkflowTask } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess, workflowWorkerProcessExcerpt } from "./workflow-worker-process.js";
import type { WorkflowTaskExecution } from "./workflow-runner.js";

export interface KimiWorkflowWorkerOptions {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly kimiHome?: string;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

const defaultKimiCodeHome = (): string =>
  process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");

export class KimiWorkflowWorkerError extends Error {
  override readonly name = "KimiWorkflowWorkerError";
}

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

export const runKimiWorkflowTask = async (
  task: AnyWorkflowTask,
  options: KimiWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_KIMI_BIN ?? "kimi";
  const roleSkill = generatedRoleSkillName(task.agent.name);
  const prompt = `You are assigned the ${roleSkill} Prism role. ${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_KIMI_PROCESS_TIMEOUT_MS)
    ?? 360_000;
  const kimiHome = options.kimiHome ?? defaultKimiCodeHome();

  const args: string[] = [
    ...(options.model !== undefined ? ["--model", options.model] : []),
    "--output-format",
    "stream-json",
    "--prompt",
    prompt,
    "--skills-dir",
    join(kimiHome, "plugins", "managed", generatedKimiPluginId(task.agent.plugin), "skills"),
  ];

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
    env: { KIMI_CODE_HOME: kimiHome },
  });
  if (aborted) {
    throw new KimiWorkflowWorkerError(`kimi-code was aborted by Prism workflow stop${workflowWorkerProcessExcerpt(stdout, stderr)}`);
  }
  if (timedOut) {
    const excerpt = workflowWorkerProcessExcerpt(stdout, stderr);
    throw new KimiWorkflowWorkerError(`kimi-code exceeded Prism process timeout after ${processTimeoutMs}ms${excerpt}`);
  }
  if (exitCode !== 0) {
    throw new KimiWorkflowWorkerError(`kimi-code exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return {
    output: parseWorkflowWorkerJsonOutput(parseKimiStreamJsonOutput(stdout)),
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
      processTimeoutMs,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
