import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generatedPluginIdForOwner } from "./compile/generated-plugin.js";
import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, WorkflowOutputParseError, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskProgressReporter, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";
import { stableSessionIdFromRecordKeys } from "./workflow-session.js";

export type GrokWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly maxAgentBytes?: number;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
} & WorkflowTaskRepairLoopOption<"grok">;

export class WorkflowWorkerError extends Error {
  override readonly name = "WorkflowWorkerError";
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    if (metadata !== undefined) this.metadata = metadata;
  }
}

interface GrokWorkflowRuntime {
  readonly agent: string;
  readonly env: Record<string, string>;
  readonly temporaryRoot?: string;
  readonly agentSourceBytes?: number;
}
const DEFAULT_GROK_MAX_AGENT_BYTES = 256 * 1024;


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
const grokHome = (): string => join(process.env.HOME ?? homedir(), ".grok");

// Grok non-interactive sessions preload every frontmatter skill body into fixed
// context. Remove only that top-level key; body text and unrelated YAML stay
// byte-identical. Grok 0.2.102 supports `tools:` on Grok-4 profiles, so workflow
// execution preserves the allowlist exactly as the lowerer emitted it.
const stripAgentFrontmatterKey = (source: string, key: "skills"): string => {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(newline);
  if (lines[0] !== "---") return source;
  const closing = lines.indexOf("---", 1);
  if (closing < 0) return source;
  const start = lines.findIndex((line, index) => index > 0 && index < closing && line.startsWith(`${key}:`));
  if (start < 0) return source;
  let end = start + 1;
  while (end < closing && (/^[ \t]/u.test(lines[end] ?? "") || (lines[end] ?? "").length === 0)) {
    end += 1;
  }
  lines.splice(start, end - start);
  return lines.join(newline);
};

export const stripAgentSkillsFrontmatter = (source: string): string =>
  stripAgentFrontmatterKey(source, "skills");

export const sanitizeGrokWorkflowAgentSource = (source: string): string =>
  stripAgentSkillsFrontmatter(source);

const prepareGrokWorkflowRuntime = async (
  task: AnyWorkflowTask,
  maxAgentBytes: number,
): Promise<GrokWorkflowRuntime> => {
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
  if (!(await pathExists(sourceAgentPath))) return { agent: task.agent.name, env };
  const source = await readFile(sourceAgentPath, "utf8");
  const sanitized = sanitizeGrokWorkflowAgentSource(source);
  const agentSourceBytes = new TextEncoder().encode(sanitized).byteLength;
  if (agentSourceBytes > maxAgentBytes) {
    throw new WorkflowWorkerError(
      `Grok workflow agent ${task.agent.plugin}.${task.agent.name} is ${agentSourceBytes} bytes after preload sanitization; maximum is ${maxAgentBytes}. Reduce the compiled agent body or set PRISM_WORKFLOW_GROK_MAX_AGENT_BYTES to an explicit larger positive integer.`,
      {
        adapter: "grok-cli",
        stage: "agent-preload",
        agentSourceBytes,
        maxAgentBytes,
      },
    );
  }
  if (sanitized === source) return { agent: sourceAgentPath, env, agentSourceBytes };
  const temporaryRoot = await mkdtemp(join(tmpdir(), "prism-grok-agent-"));
  const sanitizedPath = join(temporaryRoot, "agent.md");
  try {
    await writeFile(sanitizedPath, sanitized);
    return { agent: sanitizedPath, env, temporaryRoot, agentSourceBytes };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    // Keep in sync with WORKFLOW_HARNESS_DETECTION_SPECS.grok.defaultModel
    // (workflow-harness-detection.ts). This fallback only fires when
    // buildGrokArgs is called directly without going through model resolution.
    input.model ?? "grok-4.5",
    "--agent",
    input.agent,
    "--cwd",
    input.cwd,
    ...(input.sessionId !== undefined ? ["-r", input.sessionId] : []),
    "--no-alt-screen",
    "--allow",
    "MCPTool",
    "--output-format",
    "json",
    "--no-wait-for-background",
    ...(input.effort ? ["--effort", input.effort] : []),
    ...permissionArgs,
    "--single",
    input.prompt,
  ];
};

interface GrokJsonRunOutput {
  readonly sessionId?: string;
  readonly text: string;
}

const parseJsonCandidate = (candidate: string): unknown | undefined => {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
};

const parseGrokJsonEnvelope = (stdout: string): unknown => {
  const trimmed = stdout.trim();
  const parsed = parseJsonCandidate(trimmed);
  if (parsed !== undefined) return parsed;

  for (const line of trimmed.split(/\r?\n/u).reverse()) {
    const candidate = line.trim();
    if (candidate.length === 0 || (!candidate.startsWith("{") && !candidate.startsWith("["))) continue;
    const lineParsed = parseJsonCandidate(candidate);
    if (lineParsed !== undefined) return lineParsed;
  }

  throw new WorkflowWorkerError("grok JSON output did not contain a parseable JSON envelope");
};

const stringField = (
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
};

const grokAssistantText = (envelope: unknown): string => {
  if (typeof envelope === "string") return envelope;
  if (isRecord(envelope)) {
    const direct = stringField(envelope, ["text", "result", "output", "content", "message", "response"]);
    if (direct !== undefined) return direct;

    for (const key of ["result", "output", "content", "message", "response"] as const) {
      const nested: unknown = envelope[key];
      if (nested !== undefined && nested !== null && nested !== envelope) {
        return grokAssistantText(nested);
      }
    }
  }
  return JSON.stringify(envelope);
};

export const parseGrokJsonRunOutput = (stdout: string): GrokJsonRunOutput => {
  const envelope = parseGrokJsonEnvelope(stdout);
  const sessionId = stableSessionIdFromRecordKeys(envelope, ["sessionId", "sessionID", "session_id"]);
  return sessionId !== undefined
    ? { sessionId, text: grokAssistantText(envelope) }
    : { text: grokAssistantText(envelope) };
};

export const runGrokWorkflowTask = async (
  task: AnyWorkflowTask,
  options: GrokWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const sessionId = options.repair?.mode === "native-continuation" ? options.repair.continuation.sessionId : undefined;
  const prompt = options.repair !== undefined
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  const command = options.bin ?? process.env.PRISM_WORKFLOW_GROK_BIN ?? "grok";
  const maxAgentBytes = options.maxAgentBytes
    ?? parsePositiveInteger(process.env.PRISM_WORKFLOW_GROK_MAX_AGENT_BYTES)
    ?? DEFAULT_GROK_MAX_AGENT_BYTES;
  const startedAt = Date.now();
  const runtime = await prepareGrokWorkflowRuntime(task, maxAgentBytes);
  try {
  const args = buildGrokArgs({
    cwd: options.cwd,
    agent: runtime.agent,
    model: options.model,
    effort: options.effort,
    prompt,
    sessionId,
    permission: options.resolvedPermission,
  });

  const { exitCode, stdout, stderr, durationMs, aborted, earlyExit } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    onOutputActivity: (stream) => options.reportProgress?.(`worker-${stream}`),
    env: runtime.env,
    earlyExitPatterns: GROK_AUTH_PROMPT_PATTERNS,
  });
  const processMetadata = {
    adapter: "grok-cli",
    nativeAgent: task.agent.name,
    model: options.model ?? "grok-4.5",
    durationMs,
    sessionId,
    agentSourceBytes: runtime.agentSourceBytes,
    maxAgentBytes,
    exitCode,
    aborted,
    ...(earlyExit !== undefined ? { earlyExit } : {}),
    ...summarizeWorkflowWorkerStderr(stderr),
  };
  const processFailure = (message: string): WorkflowWorkerError =>
    new WorkflowWorkerError(message, {
      ...processMetadata,
      stage: "process",
      ...(stdout.trim().length > 0 ? { outputExcerpt: stdout.trim().slice(-512) } : {}),
    });
  if (aborted) {
    throw processFailure("grok was aborted by Prism workflow stop");
  }
  if (earlyExit === "xai-oauth-device-login") {
    throw processFailure("grok requires xAI OAuth login before workflow run; run `grok login` or refresh Grok credentials, then retry");
  }
  if (exitCode !== 0 && isGrokAuthOutput(`${stdout}\n${stderr}`)) {
    throw processFailure("grok requires xAI OAuth login before workflow run; run `grok login` or refresh Grok credentials, then retry");
  }
  if (exitCode !== 0) {
    throw processFailure(`grok exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  let runOutput: GrokJsonRunOutput;
  try {
    runOutput = parseGrokJsonRunOutput(stdout);
  } catch (error) {
    if (error instanceof WorkflowWorkerError) {
      throw new WorkflowWorkerError(error.message, {
        ...processMetadata,
        stage: "output-envelope",
        ...(stdout.trim().length > 0 ? { outputExcerpt: stdout.trim().slice(-512) } : {}),
      });
    }
    throw error;
  }
  const metadata = {
    ...processMetadata,
    sessionId: sessionId ?? runOutput.sessionId,
  };
  let output: unknown;
  try {
    output = parseWorkflowWorkerJsonOutput(runOutput.text);
  } catch (error) {
    if (error instanceof WorkflowOutputParseError) {
      throw new WorkflowOutputParseError(error.message, error.rawText, metadata);
    }
    throw error;
  }
  return {
    output,
    metadata,
  };
  } catch (error) {
    if (error instanceof WorkflowOutputParseError) throw error;
    if (error instanceof WorkflowWorkerError && error.metadata !== undefined) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowWorkerError(message, {
      adapter: "grok-cli",
      nativeAgent: task.agent.name,
      model: options.model ?? "grok-4.5",
      durationMs: Date.now() - startedAt,
      sessionId,
      agentSourceBytes: runtime.agentSourceBytes,
      maxAgentBytes,
      stage: "process-setup",
    });
  } finally {
    if (runtime.temporaryRoot !== undefined) {
      await rm(runtime.temporaryRoot, { recursive: true, force: true });
    }
  }
};

export { parseWorkflowWorkerJsonOutput, WorkflowOutputParseError } from "./workflow-worker-contract.js";
