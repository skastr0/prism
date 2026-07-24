/**
 * Project identity (toolchain & distribution §4).
 *
 * A project key is derived at the CLI edge:
 *   - the git repository root (worktree/origin root) when cwd is inside a git
 *     repo,
 *   - else realpath(cwd).
 *
 * The human-readable path is hashed (sha256) only to produce a filesystem-safe
 * directory name; the original path is recorded alongside for inspection.
 *
 * Prism-owned generated types live machine-global, project-keyed, never in the
 * project tree:
 *   ~/.prism/state/projects/<key>/compile-manifest.json
 *   ~/.prism/state/projects/<key>/generated/...
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * The resolved project path (git root or realpath(cwd)) plus its
 * filesystem-safe hash. Carry both: the hash names the directory, the path is
 * for human inspection.
 */
export interface ProjectKey {
  /** The resolved project root path (git toplevel, else realpath(cwd)). */
  readonly path: string;
  /** sha256(path) hex — the filesystem-safe directory name. */
  readonly key: string;
}

/**
 * Resolve the git repository root (worktree root) for a directory, or
 * undefined when the directory is not inside a git repo (or git is missing).
 * Synchronous: the workflow loader's `prism/refs` resolver and tsconfig path
 * derivation run on a sync path.
 */
export const gitRepositoryRoot = (cwd: string): string | undefined => {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
};

const realpathOrInput = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Derive the project key for a directory: git root if inside a git repo, else
 * realpath(cwd). The path is realpath-normalized either way so that distinct
 * spellings of the same location collapse to one key.
 */
export const deriveProjectKey = (cwd: string = process.cwd()): ProjectKey => {
  const gitRoot = gitRepositoryRoot(cwd);
  const path = realpathOrInput(gitRoot ?? cwd);
  const key = createHash("sha256").update(path).digest("hex");
  return { path, key };
};

// ---------------------------------------------------------------------------
// Machine-global, project-keyed storage paths.
// ---------------------------------------------------------------------------

/** ~/.prism/state/projects/<key> for a project key. */
export const projectStateDir = (prismHome: string, key: string): string =>
  join(prismHome, "state", "projects", key);

/** ~/.prism/state/projects/<key>/compile-manifest.json — per-project manifest. */
export const projectCompileManifestPath = (prismHome: string, key: string): string =>
  join(projectStateDir(prismHome, key), "compile-manifest.json");

/** ~/.prism/state/projects/<key>/generated — Prism-owned generated refs dir. */
export const projectGeneratedRefsDir = (prismHome: string, key: string): string =>
  join(projectStateDir(prismHome, key), "generated");

/** ~/.prism/state/projects/<key>/generated/agents.ts — the agents refs file. */
export const projectGeneratedAgentsPath = (prismHome: string, key: string): string =>
  join(projectGeneratedRefsDir(prismHome, key), "agents.ts");
