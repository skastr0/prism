import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-node-compat-"));
  tempRoots.push(root);
  return root;
};

const runNodeBundle = async (
  source: string,
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> => {
  const root = await createTempRoot();
  const entry = join(root, "entry.ts");
  const outdir = join(root, "dist");
  await writeFile(entry, source);

  const build = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "node",
    format: "esm",
  });
  if (!build.success) {
    throw new Error(build.logs.map((log) => log.message).join("\n"));
  }

  const child = Bun.spawn(["node", join(outdir, "entry.js")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workflow Node compatibility", () => {
  test("public SDK imports under Node without loading Bun-only workflow runtime modules", async () => {
    const result = await runNodeBundle(`
import * as sdk from ${JSON.stringify(join(repoRoot, "src/index.ts"))};

if (typeof sdk.defineWorkflow !== "function") throw new Error("defineWorkflow export missing");
if (typeof sdk.defineTask !== "function") throw new Error("defineTask export missing");
if (typeof sdk.runWorkflow !== "function") throw new Error("runWorkflow export missing");
if (typeof sdk.WorkflowBunRuntimeUnavailableError !== "function") {
  throw new Error("WorkflowBunRuntimeUnavailableError export missing");
}
if ("WorkflowStore" in sdk) throw new Error("public SDK imported WorkflowStore");
if ("openWorkflowDatabase" in sdk) throw new Error("public SDK imported openWorkflowDatabase");

console.log("public-sdk-ok");
`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("public-sdk-ok");
    expect(result.stderr).toBe("");
  });

  test("public default harness detection fails closed outside Bun", async () => {
    const result = await runNodeBundle(`
import { detectWorkflowHarness, WorkflowBunRuntimeUnavailableError } from ${JSON.stringify(join(repoRoot, "src/index.ts"))};

try {
  await detectWorkflowHarness("opencode");
  throw new Error("expected Bun runtime error");
} catch (error) {
  if (!(error instanceof WorkflowBunRuntimeUnavailableError)) throw error;
  if (!error.message.includes("harness executable discovery")) throw error;
  console.log(error.name);
}
`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("WorkflowBunRuntimeUnavailableError");
    expect(result.stderr).toBe("");
  });

  test("internal workflow runtime helpers fail closed outside Bun", async () => {
    const result = await runNodeBundle(`
import { findWorkflowExecutable } from ${JSON.stringify(join(repoRoot, "src/workflow-runtime.ts"))};
import { WorkflowBunRuntimeUnavailableError } from ${JSON.stringify(join(repoRoot, "src/workflow-errors.ts"))};

try {
  findWorkflowExecutable("node");
  throw new Error("expected Bun runtime error");
} catch (error) {
  if (!(error instanceof WorkflowBunRuntimeUnavailableError)) throw error;
  if (!error.message.includes("executable discovery")) throw error;
  console.log(error.name);
}
`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("WorkflowBunRuntimeUnavailableError");
    expect(result.stderr).toBe("");
  });
});
