/**
 * Effect version guard for Prism-owned code.
 *
 * Prism Workflows will make Effect part of the runtime spine, so Prism-owned
 * packages must stay on one Effect major. Third-party package managers may
 * install their own nested/private Effect copies; those are allowed only when
 * listed here explicitly so they do not accidentally become Prism's public
 * runtime surface.
 *
 * Usage:
 *   bun scripts/effect-version-guard.ts
 *   bun scripts/effect-version-guard.ts --self-test
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXPECTED_PRISM_EFFECT_MAJOR = 3;

const allowedNestedEffectCopies: ReadonlyArray<{
  readonly packageKey: string;
  readonly reason: string;
}> = [
  {
    packageKey: "@opencode-ai/plugin/effect",
    reason:
      "@opencode-ai/plugin carries a private Effect 4 beta dependency; Prism code must not import it.",
  },
];

interface WorkspaceLockEntry {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

interface BunLockPackageTuple extends ReadonlyArray<unknown> {
  readonly 0: string;
}

interface BunLockLike {
  readonly workspaces?: Record<string, WorkspaceLockEntry>;
  readonly packages?: Record<string, BunLockPackageTuple>;
}

interface GuardResult {
  readonly errors: string[];
  readonly notes: string[];
}

const parseMajor = (version: string): number | null => {
  const normalized = version
    .replace(/^npm:/, "")
    .replace(/^effect@/, "")
    .trim();
  if (!/^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) return null;
  const match = /^[~^]?\s*(\d+)\./.exec(normalized);
  return match ? Number(match[1]) : null;
};

const dependencyMaps = (
  workspace: WorkspaceLockEntry,
): ReadonlyArray<readonly [string, Record<string, string> | undefined]> => [
  ["dependencies", workspace.dependencies],
  ["optionalDependencies", workspace.optionalDependencies],
  ["devDependencies", workspace.devDependencies],
];

const isAllowedNestedEffectCopy = (packageKey: string): string | null => {
  const allow = allowedNestedEffectCopies.find((entry) =>
    packageKey === entry.packageKey,
  );
  return allow?.reason ?? null;
};

const isEffectPackageKey = (packageKey: string): boolean =>
  packageKey === "effect" || packageKey.endsWith("/effect");

const stripBunLockTrailingCommas = (text: string): string =>
  text.replace(/,\s*([}\]])/g, "$1");

const checkLock = (lock: BunLockLike): GuardResult => {
  const errors: string[] = [];
  const notes: string[] = [];

  for (const [workspaceKey, workspace] of Object.entries(lock.workspaces ?? {})) {
    for (const [field, deps] of dependencyMaps(workspace)) {
      const range = deps?.effect;
      if (!range) continue;
      const major = parseMajor(range);
      if (major !== EXPECTED_PRISM_EFFECT_MAJOR) {
        errors.push(
          `workspace ${workspace.name ?? workspaceKey} declares ${field}.effect=${range}; expected major ${EXPECTED_PRISM_EFFECT_MAJOR}.`,
        );
      }
    }
  }

  for (const [packageKey, tuple] of Object.entries(lock.packages ?? {})) {
    if (!isEffectPackageKey(packageKey)) continue;
    const version = tuple[0];
    const major = parseMajor(version);
    const allowedNestedReason = isAllowedNestedEffectCopy(packageKey);
    if (allowedNestedReason) {
      notes.push(`allowed nested ${packageKey}@${version}: ${allowedNestedReason}`);
      continue;
    }
    if (packageKey !== "effect") {
      errors.push(
        `unexpected nested Effect package ${packageKey}@${version}; add an explicit allowlist entry or remove the dependency path.`,
      );
      continue;
    }
    if (major !== EXPECTED_PRISM_EFFECT_MAJOR) {
      errors.push(
        `root Effect package resolved to ${version}; expected major ${EXPECTED_PRISM_EFFECT_MAJOR}.`,
      );
    }
  }

  return { errors, notes };
};

const loadLock = async (): Promise<BunLockLike> => {
  const lockText = await readFile(join(REPO_ROOT, "bun.lock"), "utf8");
  const parsed = JSON.parse(stripBunLockTrailingCommas(lockText)) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("bun.lock did not parse to an object");
  }
  return parsed as BunLockLike;
};

const printResult = (result: GuardResult): void => {
  for (const note of result.notes) console.log(`effect-version-guard: note: ${note}`);
  if (result.errors.length === 0) {
    console.log(
      `effect-version-guard: PASS — Prism-owned Effect surface is pinned to major ${EXPECTED_PRISM_EFFECT_MAJOR}.`,
    );
    return;
  }
  console.error("effect-version-guard: FAIL — Effect version skew reached Prism-owned surface:");
  for (const error of result.errors) console.error(`  - ${error}`);
};

const expectPass = (name: string, lock: BunLockLike): void => {
  const result = checkLock(lock);
  if (result.errors.length > 0) {
    throw new Error(`${name} should pass, got: ${result.errors.join(" | ")}`);
  }
};

const expectFail = (name: string, lock: BunLockLike, contains: string): void => {
  const result = checkLock(lock);
  if (!result.errors.some((error) => error.includes(contains))) {
    throw new Error(`${name} should fail with ${contains}, got: ${result.errors.join(" | ")}`);
  }
};

const runSelfTest = (): void => {
  expectPass("root Effect 3 plus allowed opencode private Effect 4", {
    workspaces: {
      "": { name: "prism", dependencies: { effect: "^3.21.1" } },
    },
    packages: {
      effect: ["effect@3.21.1"],
      "@opencode-ai/plugin/effect": ["effect@4.0.0-beta.66"],
    },
  });

  expectFail(
    "Prism workspace declaring Effect 4",
    {
      workspaces: {
        "": { name: "prism", dependencies: { effect: "^4.0.0" } },
      },
      packages: { effect: ["effect@4.0.0"] },
    },
    "dependencies.effect=^4.0.0",
  );

  expectFail(
    "Prism workspace declaring broad Effect range",
    {
      workspaces: {
        "": { name: "prism", dependencies: { effect: ">=3.0.0" } },
      },
      packages: { effect: ["effect@3.21.1"] },
    },
    "dependencies.effect=>=3.0.0",
  );

  expectFail(
    "Prism workspace declaring multi-major Effect range",
    {
      workspaces: {
        "": { name: "prism", dependencies: { effect: "^3.21.1 || ^4.0.0" } },
      },
      packages: { effect: ["effect@3.21.1"] },
    },
    "dependencies.effect=^3.21.1 || ^4.0.0",
  );

  expectFail(
    "Prism workspace declaring hyphen Effect range",
    {
      workspaces: {
        "": { name: "prism", dependencies: { effect: "3.21.1 - 4.0.0" } },
      },
      packages: { effect: ["effect@3.21.1"] },
    },
    "dependencies.effect=3.21.1 - 4.0.0",
  );

  expectFail(
    "unexpected nested Effect package",
    {
      workspaces: {
        "": { name: "prism", dependencies: { effect: "^3.21.1" } },
      },
      packages: {
        effect: ["effect@3.21.1"],
        "some-runtime/effect": ["effect@4.0.0"],
      },
    },
    "unexpected nested Effect package",
  );

  console.log("effect-version-guard: self-test PASS");
};

const main = async (): Promise<void> => {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }
  const result = checkLock(await loadLock());
  printResult(result);
  if (result.errors.length > 0) process.exitCode = 1;
};

await main();
