#!/usr/bin/env bun
/**
 * Derives the release-train version, in-repo, with zero external
 * dependencies — replaces `svu` (and the Go toolchain it required in CI).
 *
 * Subcommands:
 *   current           print the latest semver git tag (highest vMAJOR.MINOR.PATCH),
 *                      or v0.0.0 if the repo has no semver tag yet.
 *   next [--v0]        print the next version derived from conventional commits
 *                      since the latest tag. If no releasable commit exists in
 *                      that range (only docs/chore/style/refactor/test/ci/build),
 *                      prints the CURRENT version unchanged so the caller's
 *                      current == next guard can skip the release.
 *   --self-test         run an internal fixture table (commit list -> expected
 *                      bump) and exit nonzero on any mismatch.
 *
 * Bump rules (conventional commits):
 *   - a "BREAKING CHANGE:" / "BREAKING-CHANGE:" footer, or a `!` before the
 *     `:` in the header (e.g. `feat!:`, `fix(api)!:`) -> major, EXCEPT under
 *     --v0 or when the current major version is already 0, where it bumps
 *     minor instead (mirrors svu's `--v0` behavior: never auto-cut a 1.0.0
 *     from a stray breaking-change commit during 0.x stabilization).
 *   - feat -> minor
 *   - fix | perf -> patch
 *   - anything else (docs, chore, style, refactor, test, ci, build, merge, ...)
 *     -> no bump on its own.
 *   The highest-ranked bump across all commits in range wins.
 *
 * Usage:
 *   bun scripts/derive-version.ts current
 *   bun scripts/derive-version.ts next --v0
 *   bun scripts/derive-version.ts --self-test
 */

type Version = { readonly major: number; readonly minor: number; readonly patch: number };
type Bump = "major" | "minor" | "patch" | "none";
type CommitInput = { readonly subject: string; readonly body: string };

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const HEADER_RE = /^(\w+)(?:\([^)]*\))?(!)?:\s*/;
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;
const BUMPING_TYPES: Record<string, "minor" | "patch"> = {
  feat: "minor",
  fix: "patch",
  perf: "patch",
};
const BUMP_RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

export const parseTag = (tag: string): Version | null => {
  const match = TAG_RE.exec(tag.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

export const formatVersion = (v: Version): string => `v${v.major}.${v.minor}.${v.patch}`;

/** Highest vMAJOR.MINOR.PATCH tag among the given tag strings, or null. */
export const highestTag = (tags: readonly string[]): Version | null => {
  let best: Version | null = null;
  for (const tag of tags) {
    const parsed = parseTag(tag);
    if (!parsed) continue;
    if (
      best === null ||
      parsed.major > best.major ||
      (parsed.major === best.major && parsed.minor > best.minor) ||
      (parsed.major === best.major &&
        parsed.minor === best.minor &&
        parsed.patch > best.patch)
    ) {
      best = parsed;
    }
  }
  return best;
};

const isBreaking = (commit: CommitInput): boolean => {
  const header = HEADER_RE.exec(commit.subject);
  if (header && header[2] === "!") return true;
  return BREAKING_FOOTER_RE.test(commit.body);
};

const commitBump = (commit: CommitInput): Bump => {
  if (isBreaking(commit)) return "major";
  const header = HEADER_RE.exec(commit.subject);
  const type = header?.[1]?.toLowerCase();
  if (type !== undefined && type in BUMPING_TYPES) return BUMPING_TYPES[type];
  return "none";
};

/** The highest-ranked bump implied by any commit in the range. */
export const computeBump = (commits: readonly CommitInput[]): Bump => {
  let winner: Bump = "none";
  for (const commit of commits) {
    const bump = commitBump(commit);
    if (BUMP_RANK[bump] > BUMP_RANK[winner]) winner = bump;
  }
  return winner;
};

/** Pure version-arithmetic: apply a bump decision to a current version. */
export const applyBump = (
  current: Version,
  bump: Bump,
  opts: { readonly v0: boolean },
): Version => {
  const effectiveBump: Bump =
    bump === "major" && (opts.v0 || current.major === 0) ? "minor" : bump;
  switch (effectiveBump) {
    case "major":
      return { major: current.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: current.major, minor: current.minor + 1, patch: 0 };
    case "patch":
      return { major: current.major, minor: current.minor, patch: current.patch + 1 };
    case "none":
      return current;
  }
};

// --- git plumbing -----------------------------------------------------

const runGit = async (args: readonly string[]): Promise<string> => {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout;
};

const listTags = async (): Promise<string[]> => {
  const out = await runGit(["tag", "-l", "v*"]);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
};

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

const listCommitsSince = async (tag: string | null): Promise<CommitInput[]> => {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  let out: string;
  try {
    out = await runGit(["log", range, `--format=%s${FIELD_SEP}%b${RECORD_SEP}`]);
  } catch {
    // No commits reachable (e.g. a brand-new repo) -> empty history.
    return [];
  }
  return out
    .split(RECORD_SEP)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [subject = "", body = ""] = record.split(FIELD_SEP);
      return { subject: subject.trim(), body };
    });
};

const printCurrent = async (): Promise<void> => {
  const highest = highestTag(await listTags());
  console.log(formatVersion(highest ?? { major: 0, minor: 0, patch: 0 }));
};

const printNext = async (opts: { readonly v0: boolean }): Promise<void> => {
  const highest = highestTag(await listTags());
  const current = highest ?? { major: 0, minor: 0, patch: 0 };
  const commits = await listCommitsSince(highest ? formatVersion(highest) : null);
  const bump = computeBump(commits);
  console.log(formatVersion(applyBump(current, bump, opts)));
};

// --- self-test ----------------------------------------------------------

type Fixture = {
  readonly name: string;
  readonly current: Version;
  readonly v0: boolean;
  readonly commits: readonly CommitInput[];
  readonly expected: string;
};

const FIXTURES: readonly Fixture[] = [
  {
    name: "feat -> minor",
    current: { major: 1, minor: 2, patch: 3 },
    v0: false,
    commits: [{ subject: "feat(cli): add foo", body: "" }],
    expected: "v1.3.0",
  },
  {
    name: "fix -> patch",
    current: { major: 1, minor: 2, patch: 3 },
    v0: false,
    commits: [{ subject: "fix(cli): correct bar", body: "" }],
    expected: "v1.2.4",
  },
  {
    name: "perf -> patch",
    current: { major: 1, minor: 2, patch: 3 },
    v0: false,
    commits: [{ subject: "perf(cli): speed up baz", body: "" }],
    expected: "v1.2.4",
  },
  {
    name: "breaking bang under v0 -> minor",
    current: { major: 0, minor: 5, patch: 1 },
    v0: true,
    commits: [{ subject: "feat(cli)!: drop legacy flag", body: "" }],
    expected: "v0.6.0",
  },
  {
    name: "breaking footer above v0 -> major",
    current: { major: 1, minor: 5, patch: 1 },
    v0: false,
    commits: [
      { subject: "feat(cli): drop legacy flag", body: "BREAKING CHANGE: removes --old" },
    ],
    expected: "v2.0.0",
  },
  {
    name: "breaking on major 0 without --v0 flag still bumps minor",
    current: { major: 0, minor: 5, patch: 1 },
    v0: false,
    commits: [{ subject: "feat(cli)!: drop legacy flag", body: "" }],
    expected: "v0.6.0",
  },
  {
    name: "mixed feat+fix -> minor (highest wins)",
    current: { major: 1, minor: 0, patch: 0 },
    v0: false,
    commits: [
      { subject: "fix(cli): correct bar", body: "" },
      { subject: "feat(cli): add foo", body: "" },
    ],
    expected: "v1.1.0",
  },
  {
    name: "docs/chore/style/refactor/test/ci/build only -> no bump",
    current: { major: 1, minor: 2, patch: 3 },
    v0: false,
    commits: [
      { subject: "chore: bump deps", body: "" },
      { subject: "docs: fix typo", body: "" },
      { subject: "ci: tweak workflow", body: "" },
      { subject: "style: reformat", body: "" },
      { subject: "refactor: rename var", body: "" },
      { subject: "test: add case", body: "" },
      { subject: "build: bump esbuild", body: "" },
    ],
    expected: "v1.2.3",
  },
  {
    name: "no tag -> derive from v0.0.0",
    current: { major: 0, minor: 0, patch: 0 },
    v0: false,
    commits: [{ subject: "feat: first feature", body: "" }],
    expected: "v0.1.0",
  },
];

const runSelfTest = (): void => {
  let failures = 0;
  for (const fixture of FIXTURES) {
    const bump = computeBump(fixture.commits);
    const next = applyBump(fixture.current, bump, { v0: fixture.v0 });
    const actual = formatVersion(next);
    if (actual !== fixture.expected) {
      failures += 1;
      console.error(`FAIL ${fixture.name}: expected ${fixture.expected}, got ${actual}`);
    } else {
      console.log(`ok ${fixture.name}`);
    }
  }
  if (failures > 0) {
    console.error(`derive-version self-test: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("derive-version: self-test PASS");
};

// --- entrypoint -----------------------------------------------------------

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand === "current") {
    await printCurrent();
    return;
  }
  if (subcommand === "next") {
    await printNext({ v0: rest.includes("--v0") });
    return;
  }
  console.error("Usage: bun scripts/derive-version.ts current | next [--v0] | --self-test");
  process.exitCode = 1;
};

if (import.meta.main) {
  await main();
}
