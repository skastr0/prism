import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectInstalledHarnessIds } from "./harness-install-detection.js";

const previousHome = process.env.HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

describe("detectInstalledHarnessIds", () => {
  test("detects OpenCode from its registered config root", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-opencode-detect-"));
    try {
      await mkdir(join(root, ".config", "opencode"), { recursive: true });
      process.env.HOME = root;

      const detected = detectInstalledHarnessIds();
      expect(detected).toContain("opencode");
      expect(detected).not.toContain("amp-orb");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not detect harnesses without a global config root", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-no-harnesses-"));
    try {
      process.env.HOME = root;
      expect(detectInstalledHarnessIds()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
