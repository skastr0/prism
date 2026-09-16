/**
 * Effect version guard for Prism-owned code.
 *
 * Prism Workflows make Effect part of the runtime spine, so every Prism-owned
 * package must resolve to one exact Effect release. A major-only pin is not
 * enough while Effect ships pre-1.0 prereleases: `4.0.0-rc.115`,
 * `4.0.0-rc.112`, and `4.0.0-beta.66` all satisfy "major 4" and are not
 * interchangeable. Prism-owned code therefore declares the expected version
 * verbatim, with no range, tag, or union.
 *
 * Third-party package managers may install their own nested/private Effect
 * copies; those are allowed only when listed here with the exact version
 * observed in the lockfile, so a dependency bump cannot silently change
 * Prism's public runtime surface.
 *
 * Every failure names the file and the exact edit that fixes it.
 *
 * Usage:
 *   bun scripts/effect-version-guard.ts
 *   bun scripts/effect-version-guard.ts --self-test
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The one Effect release Prism-owned packages declare and resolve to. */
const EXPECTED_PRISM_EFFECT_VERSION = "4.0.0-rc.115";

/**
 * Nested Effect copies Prism does not own. Each entry pins the exact version so
 * an upstream bump surfaces here for review instead of passing as "major 4".
 */
const allowedNestedEffectCopies: ReadonlyArray<{
  readonly packageKey: string;
  readonly version: string;
  readonly reason: string;
}> = [
  {
    packageKey: "@opencode-ai/plugin/effect",
    version: "4.0.0-beta.66",
    reason:
      "@opencode-ai/plugin carries a private Effect 4 beta dependency; Prism code must not import it.",
  },
];

/**
 * Manifests that declare Prism's own Effect dependency. Checked in addition to
 * the lockfile so a package.json edit that was never installed still fails.
 */
const PRISM_OWNED_MANIFESTS: ReadonlyArray<string> = [
  "package.json",
  "packages/prism-sdk/package.json",
  "packages/prism-packager/package.json",
  "packages/npm/prism-darwin-arm64/package.json",
  "packages/npm/prism-darwin-x64/package.json",
  "packages/npm/prism-linux-arm64/package.json",
  "packages/npm/prism-linux-x64/package.json",
];

const EFFECT_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

interface WorkspaceLockEntry {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
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

const remediation = (file: string): string =>
  `edit ${file} so it declares "effect": "${EXPECTED_PRISM_EFFECT_VERSION}" (no range, tag, or union) and re-run bun install.`;

const isEffectPackageKey = (packageKey: string): boolean =>
  packageKey === "effect" || packageKey.endsWith("/effect");

const stripBunLockTrailingCommas = (text: string): string =>
  text.replace(/,\s*([}\]])/g, "$1");

const checkLock = (lock: BunLockLike): GuardResult => {
  const errors: string[] = [];
  const notes: string[] = [];

  for (const [workspaceKey, workspace] of Object.entries(lock.workspaces ?? {})) {
    for (const field of EFFECT_DEPENDENCY_FIELDS) {
      const range = workspace[field]?.effect;
      if (range === undefined) continue;
      if (range !== EXPECTED_PRISM_EFFECT_VERSION) {
        errors.push(
          `workspace ${workspace.name ?? workspaceKey} declares ${field}.effect=${range}; expected the exact version ${EXPECTED_PRISM_EFFECT_VERSION}. ${remediation("its package.json")}`,
        );
      }
    }
  }

  const effectPackage = lock.packages?.effect;
  if (effectPackage === undefined) {
    errors.push(
      `bun.lock has no root "effect" package entry; expected effect@${EXPECTED_PRISM_EFFECT_VERSION}. Run bun install.`,
    );
  } else if (effectPackage[0] !== `effect@${EXPECTED_PRISM_EFFECT_VERSION}`) {
    errors.push(
      `root Effect package resolved to ${effectPackage[0]}; expected effect@${EXPECTED_PRISM_EFFECT_VERSION}. Run bun install after fixing the declaring manifest.`,
    );
  }

  for (const [packageKey, tuple] of Object.entries(lock.packages ?? {})) {
    if (!isEffectPackageKey(packageKey) || packageKey === "effect") continue;
    const version = tuple[0];
    const allowed = allowedNestedEffectCopies.find((entry) => entry.packageKey === packageKey);
    if (allowed === undefined) {
      errors.push(
        `unexpected nested Effect package ${packageKey}@${version}; add an explicit allowlist entry in scripts/effect-version-guard.ts or remove the dependency path.`,
      );
      continue;
    }
    if (version !== `effect@${allowed.version}`) {
      errors.push(
        `allowed nested ${packageKey} resolved to ${version}; the allowlist pins effect@${allowed.version}. Review the upstream bump, then update the allowlist entry.`,
      );
      continue;
    }
    notes.push(`allowed nested ${packageKey} (${version}): ${allowed.reason}`);
  }

  return { errors, notes };
};

const checkManifests = (readManifest: (relativePath: string) => string): GuardResult => {
  const errors: string[] = [];
  for (const relativePath of PRISM_OWNED_MANIFESTS) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readManifest(relativePath)) as Record<string, unknown>;
    } catch (error) {
      errors.push(`could not read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    let declared = false;
    for (const field of EFFECT_DEPENDENCY_FIELDS) {
      const map = parsed[field];
      if (map === undefined || typeof map !== "object" || map === null) continue;
      const range = (map as Record<string, unknown>).effect;
      if (range === undefined) continue;
      declared = true;
      if (range !== EXPECTED_PRISM_EFFECT_VERSION) {
        errors.push(
          `${relativePath} declares ${field}.effect=${String(range)}; expected the exact version ${EXPECTED_PRISM_EFFECT_VERSION}. ${remediation(relativePath)}`,
        );
      }
    }
    if (!declared) {
      errors.push(
        `${relativePath} declares no effect dependency; expected dependencies.effect=${EXPECTED_PRISM_EFFECT_VERSION}.`,
      );
    }
  }
  return { errors, notes: [] };
};

const loadLock = (): BunLockLike => {
  const lockText = readFileSync(join(REPO_ROOT, "bun.lock"), "utf8");
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
      `effect-version-guard: PASS — Prism-owned Effect surface is pinned to ${EXPECTED_PRISM_EFFECT_VERSION}.`,
    );
    return;
  }
  console.error("effect-version-guard: FAIL — Effect version skew reached Prism-owned surface:");
  for (const error of result.errors) console.error(`  - ${error}`);
};

// ---------------------------------------------------------------------------
// Self-test: the guard's own fixtures, so a loosened check fails loudly here.
// ---------------------------------------------------------------------------

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

const pinnedLock = (declared: string): BunLockLike => ({
  workspaces: { "": { name: "prism", dependencies: { effect: declared } } },
  packages: {
    effect: [`effect@${EXPECTED_PRISM_EFFECT_VERSION}`],
    "@opencode-ai/plugin/effect": ["effect@4.0.0-beta.66"],
  },
});

const runSelfTest = (): void => {
  expectPass("exact pin plus allowed private beta", pinnedLock(EXPECTED_PRISM_EFFECT_VERSION));

  expectFail(
    "Prism workspace still declaring Effect 3",
    pinnedLock("^3.21.1"),
    "dependencies.effect=^3.21.1",
  );

  expectFail(
    "Prism workspace declaring a different v4 prerelease",
    pinnedLock("4.0.0-rc.112"),
    "dependencies.effect=4.0.0-rc.112",
  );

  expectFail(
    "Prism workspace declaring a caret range",
    pinnedLock(`^${EXPECTED_PRISM_EFFECT_VERSION}`),
    `dependencies.effect=^${EXPECTED_PRISM_EFFECT_VERSION}`,
  );

  expectFail(
    "Prism workspace declaring a dist-tag",
    pinnedLock("rc"),
    "dependencies.effect=rc",
  );

  expectFail(
    "Prism workspace declaring a multi-version range",
    pinnedLock(`^${EXPECTED_PRISM_EFFECT_VERSION} || ^3.21.1`),
    `dependencies.effect=^${EXPECTED_PRISM_EFFECT_VERSION} || ^3.21.1`,
  );

  expectFail(
    "root Effect resolving to a different prerelease",
    {
      workspaces: { "": { name: "prism", dependencies: { effect: EXPECTED_PRISM_EFFECT_VERSION } } },
      packages: { effect: ["effect@4.0.0-rc.112"] },
    },
    "root Effect package resolved to effect@4.0.0-rc.112",
  );

  expectFail(
    "missing root Effect package entry",
    {
      workspaces: { "": { name: "prism", dependencies: { effect: EXPECTED_PRISM_EFFECT_VERSION } } },
      packages: {},
    },
    'bun.lock has no root "effect" package entry',
  );

  expectFail(
    "unexpected nested Effect package",
    {
      workspaces: { "": { name: "prism", dependencies: { effect: EXPECTED_PRISM_EFFECT_VERSION } } },
      packages: {
        effect: [`effect@${EXPECTED_PRISM_EFFECT_VERSION}`],
        "some-runtime/effect": ["effect@4.0.0-rc.115"],
      },
    },
    "unexpected nested Effect package",
  );

  expectFail(
    "allowlisted nested copy moved off its pinned version",
    {
      workspaces: { "": { name: "prism", dependencies: { effect: EXPECTED_PRISM_EFFECT_VERSION } } },
      packages: {
        effect: [`effect@${EXPECTED_PRISM_EFFECT_VERSION}`],
        "@opencode-ai/plugin/effect": ["effect@4.0.0-beta.90"],
      },
    },
    "allowed nested @opencode-ai/plugin/effect resolved to effect@4.0.0-beta.90",
  );

  const manifestPass = checkManifests(() => JSON.stringify({ dependencies: { effect: EXPECTED_PRISM_EFFECT_VERSION } }));
  if (manifestPass.errors.length > 0) {
    throw new Error(`manifest fixture should pass, got: ${manifestPass.errors.join(" | ")}`);
  }
  const manifestFail = checkManifests(() => JSON.stringify({ dependencies: { effect: "^3.21.1" } }));
  if (!manifestFail.errors.some((error) => error.includes("dependencies.effect=^3.21.1"))) {
    throw new Error(`manifest fixture should fail, got: ${manifestFail.errors.join(" | ")}`);
  }

  console.log("effect-version-guard: self-test PASS");
};

const main = (): void => {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }
  const lock = checkLock(loadLock());
  const manifests = checkManifests((relativePath) => readFileSync(join(REPO_ROOT, relativePath), "utf8"));
  const result: GuardResult = {
    errors: [...lock.errors, ...manifests.errors],
    notes: lock.notes,
  };
  printResult(result);
  if (result.errors.length > 0) process.exitCode = 1;
};

main();
