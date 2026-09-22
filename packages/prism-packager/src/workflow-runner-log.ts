import { existsSync } from "node:fs";
import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { expandPath } from "./fs.js";
import { redactWorkflowText } from "./workflow-data-policy.js";

export const WORKFLOW_RUNNER_LOG_FILE_MODE = 0o600;
export const WORKFLOW_RUNNER_LOG_DIRECTORY_MODE = 0o700;

export type WorkflowRunnerLogRemoval =
  | { readonly status: "deleted"; readonly path: string }
  | { readonly status: "missing"; readonly path: string }
  | { readonly status: "skipped-unsafe-run-id" };

export type WorkflowRunnerLogRedaction =
  | { readonly status: "redacted" | "unchanged"; readonly path: string }
  | { readonly status: "missing"; readonly path: string }
  | { readonly status: "skipped-unsafe-run-id" | "skipped-non-file" };

export const workflowRunnerLogDir = (storePath: string): string =>
  join(dirname(expandPath(storePath)), "runner-logs");

const safeWorkflowRunId = (runId: string): boolean =>
  runId.length > 0
  && runId !== "."
  && runId !== ".."
  && !runId.includes("/")
  && !runId.includes("\\")
  && !runId.includes("\0");

export const workflowRunnerLogPath = (storePath: string, runId: string): string => {
  if (!safeWorkflowRunId(runId)) {
    throw new Error(`Workflow run id cannot address a runner log path: ${JSON.stringify(runId)}`);
  }
  const directory = resolve(workflowRunnerLogDir(storePath));
  const path = resolve(directory, `${runId}.log`);
  const relation = relative(directory, path);
  if (relation.startsWith("..") || relation === "" || relation.includes("/../")) {
    throw new Error(`Workflow runner log path escaped its directory for run ${JSON.stringify(runId)}`);
  }
  return path;
};

export const workflowRunnerLogPathIfPresent = (
  storePath: string,
  run: { readonly runId: string; readonly runnerPid?: number },
): string | undefined => {
  if (run.runnerPid === undefined) return undefined;
  const path = workflowRunnerLogPath(storePath, run.runId);
  return existsSync(path) ? path : undefined;
};

export const secureWorkflowRunnerLog = async (path: string): Promise<void> => {
  await chmod(path, WORKFLOW_RUNNER_LOG_FILE_MODE);
};

export const readRedactedWorkflowRunnerLog = async (
  storePath: string,
  runId: string,
): Promise<{ readonly path: string; readonly bytes: number; readonly content: string } | null> => {
  const path = workflowRunnerLogPath(storePath, runId);
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) return null;
    const content = await readFile(path, "utf8");
    return { path, bytes: file.size, content: redactWorkflowText(content) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
};

export const redactWorkflowRunnerLogInPlace = async (
  storePath: string,
  runId: string,
): Promise<WorkflowRunnerLogRedaction> => {
  if (!safeWorkflowRunId(runId)) return { status: "skipped-unsafe-run-id" };
  const path = workflowRunnerLogPath(storePath, runId);
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) return { status: "skipped-non-file" };
    const current = await readFile(path, "utf8");
    const redacted = redactWorkflowText(current);
    if (redacted !== current) {
      await writeFile(path, redacted, { encoding: "utf8", mode: WORKFLOW_RUNNER_LOG_FILE_MODE });
    }
    await secureWorkflowRunnerLog(path);
    return { status: redacted === current ? "unchanged" : "redacted", path };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "missing", path };
    }
    throw error;
  }
};

export const removeWorkflowRunnerLog = async (
  storePath: string,
  runId: string,
): Promise<WorkflowRunnerLogRemoval> => {
  if (!safeWorkflowRunId(runId)) return { status: "skipped-unsafe-run-id" };
  const path = workflowRunnerLogPath(storePath, runId);
  try {
    await rm(path, { force: false });
    return { status: "deleted", path };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "missing", path };
    }
    throw error;
  }
};
