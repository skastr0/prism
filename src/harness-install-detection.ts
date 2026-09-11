import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { getAllHarnessIds, getHarness, resolveHarnessRoot } from "./harnesses.js";
import type { HarnessId } from "./types.js";

export interface HarnessInstallDetectionOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly resolveExecutable?: (command: string) => string | undefined;
}

const commandOnPath = (
  command: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : undefined;
  }
  const pathEnv = env.PATH ?? env.Path ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const resolveOverrideOrCommand = (
  command: string,
  envVar: string,
  env: Readonly<Record<string, string | undefined>>,
  resolveExecutable: (command: string) => string | undefined,
): string | undefined => {
  const override = env[envVar]?.trim();
  if (override !== undefined && override.length > 0) {
    return resolveExecutable(override);
  }
  return resolveExecutable(command);
};

/**
 * OpenCode 2 shares ~/.config/opencode/ with OpenCode 1.x. Presence is the
 * `opencode2` binary (or PRISM_WORKFLOW_OPENCODE2_BIN), not that shared root.
 */
export const isOpenCode2BinaryPresent = (
  options: HarnessInstallDetectionOptions = {},
): boolean => {
  const env = options.env ?? process.env;
  const resolveExecutable = options.resolveExecutable ?? ((command) => commandOnPath(command, env));
  return resolveOverrideOrCommand("opencode2", "PRISM_WORKFLOW_OPENCODE2_BIN", env, resolveExecutable) !== undefined;
};

/**
 * A harness counts as installed iff its global config root exists — except
 * `opencode2`, which is detected by binary because it shares OpenCode 1.x's
 * home. When OpenCode 2 is present, auto-detect drops `opencode` so refresh
 * does not dual-own the shared files. `--harness opencode` still targets V1.
 */
export const detectInstalledHarnessIds = (
  options: HarnessInstallDetectionOptions = {},
): HarnessId[] => {
  const env = options.env ?? process.env;
  const resolveExecutable = options.resolveExecutable ?? ((command) => commandOnPath(command, env));
  const openCode2Present = isOpenCode2BinaryPresent({ env, resolveExecutable });

  const detected = getAllHarnessIds().filter((id) => {
    if (id === "opencode2") return openCode2Present;
    if (id === "opencode" && openCode2Present) return false;
    const root = resolveHarnessRoot(getHarness(id), "global");
    return root !== null && existsSync(root);
  });

  return detected;
};
