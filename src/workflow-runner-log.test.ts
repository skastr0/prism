import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRedactedWorkflowRunnerLog,
  redactWorkflowRunnerLogInPlace,
  removeWorkflowRunnerLog,
  secureWorkflowRunnerLog,
  workflowRunnerLogDir,
  workflowRunnerLogPath,
} from "./workflow-runner-log.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const testRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-runner-log-"));
  roots.push(root);
  return root;
};

describe("workflow runner log governance", () => {
  test("derives one run-scoped path beside the store", async () => {
    const root = await testRoot();
    const storePath = join(root, "workflows.sqlite");
    expect(workflowRunnerLogDir(storePath)).toBe(join(root, "runner-logs"));
    expect(workflowRunnerLogPath(storePath, "run-1")).toBe(join(root, "runner-logs", "run-1.log"));
  });

  test("rejects traversal before resolving or deleting a sidecar", async () => {
    const root = await testRoot();
    const storePath = join(root, "workflows.sqlite");
    const unrelated = join(root, "user.txt");
    await writeFile(unrelated, "keep");

    expect(() => workflowRunnerLogPath(storePath, "../user")).toThrow("cannot address a runner log path");
    expect(await removeWorkflowRunnerLog(storePath, "../user")).toEqual({ status: "skipped-unsafe-run-id" });
    expect(await readFile(unrelated, "utf8")).toBe("keep");
  });

  test("removes only the requested run sidecar and is idempotent", async () => {
    const root = await testRoot();
    const storePath = join(root, "workflows.sqlite");
    const logDir = workflowRunnerLogDir(storePath);
    await mkdir(logDir);
    const selected = workflowRunnerLogPath(storePath, "selected");
    const other = workflowRunnerLogPath(storePath, "other");
    const unrelated = join(root, "user.txt");
    await Promise.all([
      writeFile(selected, "selected"),
      writeFile(other, "other"),
      writeFile(unrelated, "user"),
    ]);

    expect((await removeWorkflowRunnerLog(storePath, "selected")).status).toBe("deleted");
    expect((await removeWorkflowRunnerLog(storePath, "selected")).status).toBe("missing");
    expect(await readFile(other, "utf8")).toBe("other");
    expect(await readFile(unrelated, "utf8")).toBe("user");
  });

  test("redacts sidecar content before export", async () => {
    const root = await testRoot();
    const storePath = join(root, "workflows.sqlite");
    await mkdir(workflowRunnerLogDir(storePath));
    const path = workflowRunnerLogPath(storePath, "run-1");
    await writeFile(path, "Authorization: Bearer abcdefghijklmnop\nordinary line");

    const exported = await readRedactedWorkflowRunnerLog(storePath, "run-1");
    expect(exported?.content).toContain("Bearer [REDACTED]");
    expect(exported?.content).not.toContain("abcdefghijklmnop");
    expect(await readFile(path, "utf8")).toContain("abcdefghijklmnop");
  });

  test("reconciles legacy sidecar content in place idempotently", async () => {
    const root = await testRoot();
    const storePath = join(root, "workflows.sqlite");
    await mkdir(workflowRunnerLogDir(storePath));
    const path = workflowRunnerLogPath(storePath, "legacy-run");
    await writeFile(path, "password=legacy-secret\nordinary line");

    expect((await redactWorkflowRunnerLogInPlace(storePath, "legacy-run")).status).toBe("redacted");
    expect(await readFile(path, "utf8")).toBe("password=[REDACTED]\nordinary line");
    expect((await redactWorkflowRunnerLogInPlace(storePath, "legacy-run")).status).toBe("unchanged");
  });

  test("forces existing sidecar permissions to owner read/write", async () => {
    const root = await testRoot();
    const path = join(root, "runner.log");
    await writeFile(path, "log");
    await chmod(path, 0o644);

    await secureWorkflowRunnerLog(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
