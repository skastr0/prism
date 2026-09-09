import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AnyWorkflowTask, WorkflowPermissionMode } from "./workflows.js";
import { parseWorkflowWorkerJsonOutput, workflowWorkerJsonInstruction } from "./workflow-worker-contract.js";
import { summarizeWorkflowWorkerStderr, workflowWorkerFailureMetadata } from "./workflow-worker-metadata.js";
import { parsePositiveInteger, runWorkflowWorkerProcess } from "./workflow-worker-process.js";
import { assertNeverWorkflowPermissionMode, WorkflowPermissionError } from "./workflow-permissions.js";
import type { WorkflowTaskExecution, WorkflowTaskProgressReporter, WorkflowTaskRepairLoopOption } from "./workflow-runner.js";
import { stableSessionIdFromJsonLines, stableSessionIdFromRegex } from "./workflow-session.js";

export const AMP_WORKFLOW_DIAL_MODES = ["low", "medium", "high", "ultra"] as const;
export type AmpWorkflowDialMode = (typeof AMP_WORKFLOW_DIAL_MODES)[number];
export const AMP_WORKFLOW_CATALOG_PIN_MODE = "prism-pin";
export const AMP_WORKFLOW_CATALOG_PIN_FILENAME = "prism-workflow-catalog-pin.ts";

const AMP_WORKFLOW_DIAL_MODE_SET = new Set<string>(AMP_WORKFLOW_DIAL_MODES);

export type AmpWorkflowWorkerOptions = {
  readonly cwd: string;
  readonly bin?: string;
  readonly model?: string;
  readonly catalogModel?: string;
  readonly effort?: string;
  readonly resolvedPermission: WorkflowPermissionMode;
  readonly abortSignal?: AbortSignal;
  readonly reportProgress?: WorkflowTaskProgressReporter;
} & WorkflowTaskRepairLoopOption<"amp-code">;

export class AmpWorkflowWorkerError extends Error {
  override readonly name = "AmpWorkflowWorkerError";
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message);
    if (metadata !== undefined) this.metadata = metadata;
  }
}

const assertAmpNonEmpty = (value: string | undefined, field: string): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AmpWorkflowWorkerError(`Amp workflow ${field} must be a non-empty string`);
  }
  return trimmed;
};

export const assertAmpWorkflowMode = (mode: string | undefined): string | undefined =>
  assertAmpNonEmpty(mode, "mode");

export const isAmpWorkflowDialMode = (mode: string | undefined): mode is AmpWorkflowDialMode =>
  mode !== undefined && AMP_WORKFLOW_DIAL_MODE_SET.has(mode);

export type AmpCatalogPinPlan =
  | { readonly kind: "mode"; readonly mode?: string }
  | {
    readonly kind: "pin";
    readonly mode: typeof AMP_WORKFLOW_CATALOG_PIN_MODE;
    readonly catalogModel?: string;
    readonly effort?: string;
    readonly extendsMode?: AmpWorkflowDialMode;
  };

export const resolveAmpCatalogPinPlan = (input: {
  readonly mode?: string;
  readonly catalogModel?: string;
  readonly effort?: string;
}): AmpCatalogPinPlan => {
  const mode = assertAmpWorkflowMode(input.mode);
  const catalogModel = assertAmpNonEmpty(input.catalogModel, "catalogModel");
  const effort = assertAmpNonEmpty(input.effort, "effort");
  if (catalogModel === undefined && effort === undefined) {
    return { kind: "mode", mode };
  }
  if (mode !== undefined && !isAmpWorkflowDialMode(mode)) {
    throw new AmpWorkflowWorkerError(
      `Amp catalogModel/effort cannot combine with plugin mode '${mode}'. Use a dial (low|medium|high|ultra) as worker.model to extend that mode, or omit worker.model.`,
    );
  }
  const extendsMode: AmpWorkflowDialMode | undefined = isAmpWorkflowDialMode(mode)
    ? mode
    : catalogModel === undefined
      ? "medium"
      : undefined;
  return {
    kind: "pin",
    mode: AMP_WORKFLOW_CATALOG_PIN_MODE,
    ...(catalogModel !== undefined ? { catalogModel } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(extendsMode !== undefined ? { extendsMode } : {}),
  };
};

export const ampCatalogPinPluginPath = (cwd: string): string =>
  join(cwd, ".amp", "plugins", AMP_WORKFLOW_CATALOG_PIN_FILENAME);

export const renderAmpCatalogPinPlugin = (input: {
  readonly catalogModel?: string;
  readonly effort?: string;
  readonly extendsMode?: AmpWorkflowDialMode;
}): string => {
  const catalogModel = assertAmpNonEmpty(input.catalogModel, "catalogModel");
  const effort = assertAmpNonEmpty(input.effort, "effort");
  const extendsMode = input.extendsMode;
  if (catalogModel === undefined && effort === undefined) {
    throw new AmpWorkflowWorkerError("Amp catalog pin requires catalogModel or effort");
  }
  const config: string[] = [];
  if (extendsMode !== undefined) {
    config.push(`    extends: ${JSON.stringify(extendsMode)},`);
  } else {
    config.push(`    name: ${JSON.stringify(AMP_WORKFLOW_CATALOG_PIN_MODE)},`);
    config.push("    instructions: \"You are Amp. Help the user complete software engineering tasks.\",");
    config.push("    tools: \"all\",");
  }
  if (catalogModel !== undefined) config.push(`    model: ${JSON.stringify(catalogModel)},`);
  if (effort !== undefined) config.push(`    reasoningEffort: ${JSON.stringify(effort)},`);
  return `// Generated by Prism for one workflow invoke. Do not edit.
// @amp-agent-mode ${JSON.stringify({ key: AMP_WORKFLOW_CATALOG_PIN_MODE, label: "Prism catalog pin" })}

import type { PluginAPI } from "@ampcode/plugin"

export default function (amp: PluginAPI) {
  const createAgent = amp.createAgent ?? amp.experimental?.createAgent
  const registerAgentMode = amp.registerAgentMode ?? amp.experimental?.registerAgentMode
  if (!createAgent || !registerAgentMode) {
    throw new Error("Amp catalog pin requires createAgent and registerAgentMode")
  }
  const agent = createAgent({
${config.join("\n")}
  })
  registerAgentMode({
    key: ${JSON.stringify(AMP_WORKFLOW_CATALOG_PIN_MODE)},
    label: "Prism catalog pin",
    description: "Prism workflow catalog-model pin",
    agent: agent.definition,
  })
}
`;
};

const prepareAmpCatalogPin = async (
  cwd: string,
  plan: AmpCatalogPinPlan,
): Promise<{ readonly cleanup: () => Promise<void> }> => {
  if (plan.kind !== "pin") return { cleanup: async () => undefined };
  const pluginPath = ampCatalogPinPluginPath(cwd);
  const pluginsDir = dirname(pluginPath);
  const ampDir = dirname(pluginsDir);
  const createdAmpDir = !existsSync(ampDir);
  const createdPluginsDir = !existsSync(pluginsDir);
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(pluginPath, renderAmpCatalogPinPlugin(plan));
  return {
    cleanup: async () => {
      await rm(pluginPath, { force: true });
      if (createdPluginsDir) await rm(pluginsDir, { recursive: true, force: true });
      if (createdAmpDir) await rm(ampDir, { recursive: true, force: true });
    },
  };
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
  readonly sessionId?: string;
  readonly permission?: WorkflowPermissionMode;
  /**
   * Required for permissive/full-access. runAmpWorkflowTask supplies a temp
   * settings file with amp.dangerouslyAllowAll enabled before invoking this.
   */
  readonly settingsFile?: string;
  /** Wait for the catalog-pin plugin to register before execute starts. */
  readonly pluginReadyTimeout?: boolean;
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
    ...(input.sessionId !== undefined ? ["threads", "continue", input.sessionId] : []),
    "--no-ide",
    "--no-notifications",
    "--no-color",
    "--no-archive-after-execute",
    ...(mode !== undefined ? ["--mode", mode] : []),
    ...(input.pluginReadyTimeout === true ? ["--plugin-ready-timeout"] : []),
    "--execute",
    input.prompt,
    "--stream-json",
  ];
};

const parseAmpStreamJsonResult = (stdout: string): string | undefined => {
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { readonly type?: unknown }).type === "result" &&
        typeof (parsed as { readonly result?: unknown }).result === "string"
      ) {
        return (parsed as { readonly result: string }).result;
      }
    } catch {
      // Ignore non-JSON progress output.
    }
  }
  return undefined;
};

export const parseAmpStreamJsonError = (stdout: string): string | undefined => {
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed !== "object" || parsed === null) continue;
      const rec = parsed as { readonly type?: unknown; readonly is_error?: unknown; readonly error?: unknown };
      if (rec.type !== "result" || rec.is_error !== true) continue;
      if (typeof rec.error === "string" && rec.error.length > 0) return rec.error;
    } catch {
      // Ignore non-JSON progress output.
    }
  }
  return undefined;
};

export const ampSessionId = (stdout: string, stderr: string): string | undefined =>
  stableSessionIdFromJsonLines(`${stdout}\n${stderr}`, ["session_id", "sessionId", "sessionID", "threadId", "thread_id"])
    ?? stableSessionIdFromRegex(`${stdout}\n${stderr}`, [
      /\bsession[_\s-]*id["':=\s]+([A-Za-z0-9._:-]+)/iu,
      /\bthread[_\s-]*id["':=\s]+([A-Za-z0-9._:-]+)/iu,
    ]);

export const runAmpWorkflowTask = async (
  task: AnyWorkflowTask,
  options: AmpWorkflowWorkerOptions,
): Promise<WorkflowTaskExecution> => {
  const command = options.bin ?? process.env.PRISM_WORKFLOW_AMP_BIN ?? "amp";
  const sessionId = options.repair?.mode === "native-continuation" ? options.repair.continuation.sessionId : undefined;
  const prompt = options.repair !== undefined
    ? `${options.repair.repairPrompt}\n\nReturn the corrected final response now.${workflowWorkerJsonInstruction(task)}`
    : `${task.prompt}${workflowWorkerJsonInstruction(task)}`;
  assertAmpPermission(options.resolvedPermission);
  const pin = resolveAmpCatalogPinPlan({
    mode: options.model,
    catalogModel: options.catalogModel,
    effort: options.effort,
  });
  const permissionSettings = await prepareAmpPermissionSettings(options.resolvedPermission);
  const catalogPin = await prepareAmpCatalogPin(options.cwd, pin);
  const args = buildAmpArgs({
    mode: pin.mode,
    prompt,
    sessionId,
    permission: options.resolvedPermission,
    settingsFile: permissionSettings.settingsFile,
    pluginReadyTimeout: pin.kind === "pin",
  });

  const { exitCode, stdout, stderr, durationMs, aborted } = await runWorkflowWorkerProcess({
    command,
    args,
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    onOutputActivity: (stream) => options.reportProgress?.(`worker-${stream}`),
  }).finally(async () => {
    await catalogPin.cleanup();
    await permissionSettings.cleanup();
  });
  if (aborted) {
    throw new AmpWorkflowWorkerError(
      "amp was aborted by Prism workflow stop",
      workflowWorkerFailureMetadata({ adapter: "amp-code", stderr, sessionId: ampSessionId(stdout, stderr) ?? sessionId }),
    );
  }
  const streamError = parseAmpStreamJsonError(stdout);
  if (exitCode !== 0 || streamError !== undefined) {
    throw new AmpWorkflowWorkerError(
      `amp exited with ${exitCode}: ${streamError ?? (stderr.trim() || stdout.trim())}`,
      workflowWorkerFailureMetadata({ adapter: "amp-code", stderr, sessionId: ampSessionId(stdout, stderr) ?? sessionId }),
    );
  }
  const outputText = parseAmpStreamJsonResult(stdout) ?? stdout;
  return {
    output: parseWorkflowWorkerJsonOutput(outputText),
    metadata: {
      adapter: "amp-code",
      model: pin.mode,
      ...(options.model !== undefined ? { ampMode: options.model } : {}),
      ...(pin.kind === "pin" && pin.catalogModel !== undefined ? { catalogModel: pin.catalogModel } : {}),
      ...(pin.kind === "pin" && pin.effort !== undefined ? { effort: pin.effort } : {}),
      durationMs,
      sessionId: ampSessionId(stdout, stderr) ?? sessionId,
      ...summarizeWorkflowWorkerStderr(stderr),
    },
  };
};
