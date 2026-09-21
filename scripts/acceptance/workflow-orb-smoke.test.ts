import { expect, test } from "bun:test";
import { join } from "node:path";

const run = async (args: readonly string[]) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "workflow-orb-smoke.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

test("orb smoke rehearses pure Jev and both mixed pipelines without credentials or worker binaries", async () => {
  const result = await run([]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([
    "PASS jev: mock typed output, routing, ledger, credential-free cache replay",
    "PASS amp-code: mock typed output, routing, ledger, credential-free cache replay",
    "PASS claude-code: mock typed output, routing, ledger, credential-free cache replay",
  ]);
}, 60_000);

test("orb smoke rejects misspelled live flags and invalid workers before executing", async () => {
  for (const args of [["--lve"], ["--worker"], ["--live", "--worker", "unknown"]]) {
    const result = await run(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
  }
});
