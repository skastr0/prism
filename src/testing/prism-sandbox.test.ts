import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { createPrismSandbox, withPrismSandbox } from "./prism-sandbox.js";

test("createPrismSandbox creates a temp parent with prism-home and harness subdirectories", async () => {
  const sandbox = await createPrismSandbox();
  try {
    await access(sandbox.prismHome);
    const codexRoot = sandbox.rootFor("codex-cli");
    const opencodeRoot = sandbox.rootFor("opencode");
    await access(codexRoot);
    await access(opencodeRoot);

    expect(codexRoot.startsWith(sandbox.root)).toBe(true);
    expect(opencodeRoot.startsWith(sandbox.root)).toBe(true);
    expect(sandbox.roots.resolve("codex-cli")).toBe(codexRoot);
  } finally {
    await sandbox.cleanup();
  }
});

test("withPrismSandbox tears down the temp parent after the function returns", async () => {
  let capturedRoot: string;
  await withPrismSandbox(async (sandbox) => {
    capturedRoot = sandbox.root;
    await access(sandbox.root);
    return "ok";
  });

  await expect(access(capturedRoot!)).rejects.toThrow();
});

test("withPrismSandbox tears down even when the function throws", async () => {
  let capturedRoot: string;
  await expect(
    withPrismSandbox(async (sandbox) => {
      capturedRoot = sandbox.root;
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");

  await expect(access(capturedRoot!)).rejects.toThrow();
});
