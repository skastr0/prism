import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectInstalledHarnessIds } from "./harness-install-detection.js";

describe("detectInstalledHarnessIds", () => {
  test("detects opencode2 from the binary, not the shared OpenCode config root", () => {
    const detected = detectInstalledHarnessIds({
      env: { PATH: "/missing", HOME: "/tmp/prism-no-homes" },
      resolveExecutable: (command) => command === "opencode2" ? "/bin/opencode2" : undefined,
    });
    expect(detected).toContain("opencode2");
    expect(detected).not.toContain("opencode");
  });

  test("does not treat a shared OpenCode home as opencode2", () => {
    const detected = detectInstalledHarnessIds({
      env: { PATH: "/missing" },
      resolveExecutable: () => undefined,
    });
    expect(detected).not.toContain("opencode2");
  });

  test("honors PRISM_WORKFLOW_OPENCODE2_BIN", () => {
    const detected = detectInstalledHarnessIds({
      env: { PRISM_WORKFLOW_OPENCODE2_BIN: "/custom/opencode2" },
      resolveExecutable: (command) => command === "/custom/opencode2" ? command : undefined,
    });
    expect(detected).toContain("opencode2");
    expect(detected).not.toContain("opencode");
  });

  test("drops opencode when opencode2 is present even if the shared config root exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-oc2-detect-"));
    const previousHome = process.env.HOME;
    try {
      await mkdir(join(root, ".config", "opencode"), { recursive: true });
      process.env.HOME = root;

      const withoutV2 = detectInstalledHarnessIds({
        env: { PATH: "/missing", HOME: root },
        resolveExecutable: () => undefined,
      });
      expect(withoutV2).toContain("opencode");
      expect(withoutV2).not.toContain("opencode2");

      const withV2 = detectInstalledHarnessIds({
        env: { PATH: "/missing", HOME: root },
        resolveExecutable: (command) => command === "opencode2" ? "/bin/opencode2" : undefined,
      });
      expect(withV2).toContain("opencode2");
      expect(withV2).not.toContain("opencode");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
