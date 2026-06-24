import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatedPluginIdForOwner } from "./compile/generated-plugin.js";
import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";
import { stableSessionIdFromJsonLines, stableSessionIdFromRegex } from "./workflow-session.js";

export type GrokWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly processTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
} & WorkflowTaskRepairLoopOption<"grok">;

export class WorkflowWorkerError extends Error {
  override readonly name = "WorkflowWorkerError";
}

interface GrokWorkflowRuntime {
  readonly agent: string;
  readonly env: Record<string, string>;
}

const GROK_AUTH_OUTPUT_PATTERN = /(^|\n)\s*(?:To sign in, open this URL in your browser:|Waiting for authorization\.{3}|You are not authenticated\.?|(?:error:\s*)?[^{}\n]*requires login[^{}\n]*)/iu;
const GROK_AUTH_PROMPT_PATTERNS = [
  {
    name: "xai-oauth-device-login",
    pattern: GROK_AUTH_OUTPUT_PATTERN,
  },
] as const;

export const isGrokAuthOutput = (output: string): boolean =>
  GROK_AUTH_OUTPUT_PATTERN.test(output);

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// Grok keeps config, installed plugins, and the resumable session store under one home.
// Hardcode it to ~/.grok: the home grok itself defaults to and where `prism sync` installs
// the generated plugin, so the session written on the first attempt still exists when a
// repair resumes it with `grok -r <sessionId>`. (Tests redirect by setting HOME.)
const grokHome = (): string => join(homedir(), ".grok");

const prepareGrokWorkflowRuntime = async (task: AnyWorkflowTask): Promise<GrokWorkflowRuntime> => {
  const home = grokHome();
  const pluginId = generatedPluginIdForOwner(task.agent.plugin);
  const sourceAgentPath = join(home, "plugins", pluginId, "agents", `${task.agent.name}.md`);
  // Pin GROK_HOME to the hardcoded home so grok cannot drift to an ambient one, and suppress
  // grok's Cursor/Claude MCP auto-import so a workflow run does not inherit host MCP servers.
  const env: Record<string, string> = {
    GROK_HOME: home,
    GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CLAUDE_MCPS_ENABLED: "false",
  };
  const agent = (await pathExists(sourceAgentPath)) ? sourceAgentPath : task.agent.name;
  return { agent, env };
};

const assertGrokPermission = (mode: WorkflowPermissionMode): void => {
  switch (mode) {
    case "legacy":
    case "permissive":
    case "full-access":
      return;
    case "restricted":
      throw new WorkflowPermissionError(
        "grok",
        mode,
        "Grok has no CLI flag to restrict permissions per invocation. Choose 'legacy' or 'permissive' instead.",
      );
    case "interactive":
      throw new WorkflowPermissionError(
        "grok",
        mode,
        "Grok interactive mode is incompatible with Prism workflow execution. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-read-only":
      throw new WorkflowPermissionError(
        "grok",
        mode,
        "Grok has no read-only sandbox CLI flag. Choose 'permissive' or 'legacy' instead.",
      );
    case "sandbox-workspace-write":
      throw new WorkflowPermissionError(
        "grok",
        mode,
        "Grok has no workspace-write sandbox mode. Choose 'permissive' or 'legacy' instead.",
      );
  }
  return assertNeverWorkflowPermissionMode("grok", mode);
};

export const buildGrokArgs = (input: {
  readonly cwd: string;
  readonly agent: string;
  readonly model?: string;
  readonly effort?: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly permission?: WorkflowPermissionMode;
}): ReadonlyArray<string> => {
  const mode = input.permission ?? "permissive";
  assertGrokPermission(mode);
  const permissionArgs: string[] = mode === "permissive" || mode === "full-access"
    ? ["--always-approve", "--permission-mode", "bypassPermissions"]
    : [];
  return [
    "--model",
    input.model ?? "grok-build",
    "--agent",
    input.agent,
    "--cwd",
    input.cwd,
    ...(input.sessionId !== undefined ? ["-r", input.sessionId] : []),
    "--no-alt-screen",
    "--allow",
    "MCPTool",
    "--output-format",
    "plain",
    "--no-wait-for-background",
    ...(input.effort ? ["--effort", input.effort] : []),
    ...permissionArgs,
    "--single",
    input.prompt,
  ];
};

export const grokSessionId = (stdout: string, stderr: string): string | undefined =>
  stableSessionIdFromJsonLines(`${stdout}\n${stderr}`, ["sessionId", "sessionID", "session_id"])
    ?? stableSessionIdFromRegex(`${stdout}\n${stderr}`, [
      /\bsessionId["':=\s]+([A-Za-z0-9._:-]+)/u,
      /\bsession[_\s-]*id["':=\s]+([A-Za-z0-9._:-]+)/iu,
    ]);

export const runGrokWorkflowTask = async (
  task: AnyWorkflowTask,
  options: GrokWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const sessionId = options.repair?.mode === "native-continuation" ? options.repair.continuation.sessionId : undefined;
  const prompt = options.repair !== undefined
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const command = options.bin ?? process.env.PRISM_WORKFLOW_GROK_BIN ?? "grok";
  const processTimeoutMs = options.processTimeoutMs
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_GROK_PROCESS_TIMEOUT_MS)
    ?? 120_000;
  const runtime = await prepareGrokWorkflowRuntime(task);
  const args = buildGrokArgs({
    cwd: options.cwd,
    agent: runtime.agent,
    model: options.model,
    effort: options.effort,
    prompt,
    sessionId,
    permission: options.resolvedPermission,
  });

  const { exitCode, stdout, stderr, durationMs, timedOut, aborted, earlyExit } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    processTimeoutMs,
    abortSignal: options.abortSignal,
    env: runtime.env,
    earlyExitPatterns: GROK_AUTH_PROMPT_PATTERNS,
  });
  if (aborted) {
    throw new WorkflowWorkerError("grok was aborted by Prism workflow stop");
  }
  if (earlyExit === "xai-oauth-device-login") {
    throw new WorkflowWorkerError("grok requires xAI OAuth login before workflow run; run `grok login` or refresh Grok credentials, then retry");
  }
  if (timedOut) {
    throw new WorkflowWorkerError(`grok exceeded Prism process timeout after ${processTimeoutMs}ms`);
  }
  if (exitCode !== 0 && isGrokAuthOutput(`${stdout}\n${stderr}`)) {
    throw new WorkflowWorkerError("grok requires xAI OAuth login before workflow run; run `grok login` or refresh Grok credentials, then retry");
  }
  if (exitCode !== 0) {
    throw new WorkflowWorkerError(`grok exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return {
    output: parseWorkflowWorkerJsonOutput(stdout),
    metadata: {
      adapter: "grok-cli",
      nativeAgent: task.agent.name,
      model: options.model ?? "grok-build",
      durationMs,
      processTimeoutMs,
      sessionId: grokSessionId(stdout, stderr) ?? sessionId,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};

export { parseWorkflowWorkerJsonOutput, WorkflowOutputParseError } from "./workflow-worker-contract.js";
