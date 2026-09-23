import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { validateSkill } from "./manifest.js";

const SHA = /^[0-9a-f]{40}$/i;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const PointerSchema = Schema.Struct({
  name: Schema.String,
  source: Schema.String,
  commit: Schema.String,
  skillPath: Schema.String,
});
const LockEntrySchema = Schema.Struct({
  source: Schema.String,
  commit: Schema.String,
  skillPath: Schema.String,
  contentHash: Schema.String,
});
const LockEntriesSchema = Schema.Record(Schema.String, LockEntrySchema);

export interface SkillPointer {
  readonly name: string;
  readonly source: string;
  readonly commit: string;
  readonly skillPath: string;
}

export interface NormalizedSkillSource {
  readonly gitUrl: string;
  readonly ref?: string;
  readonly subpath?: string;
}

export interface SkillLockEntry {
  readonly source: string;
  readonly commit: string;
  readonly skillPath: string;
  readonly contentHash: string;
}

export class SkillPointerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillPointerError";
  }
}

const pathInside = (path: string): boolean =>
  path !== "" && !path.startsWith("/") && !path.includes("\\") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** Git-backed subset of Vercel skills sources. Non-git well-known/local inputs fail explicitly. */
export function normalizeSkillSource(source: string): NormalizedSkillSource {
  const value = source.trim();
  if (!value || value.startsWith(".") || value.startsWith("/") || value.startsWith("~")) {
    throw new SkillPointerError(`source '${source}' is not a git repository. Use a GitHub/GitLab shorthand or git URL in source.`);
  }
  const [withoutFragment, fragment] = value.split("#", 2);
  const ref = fragment || undefined;
  let gitUrl: string;
  let path: string | undefined;
  let treeRef: string | undefined;
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:@([\w.-]+)|\/(.+))?$/.exec(withoutFragment!);
  if (shorthand) {
    gitUrl = `https://github.com/${shorthand[1]}/${shorthand[2]!.replace(/\.git$/, "")}.git`;
    path = shorthand[4];
  } else if (/^git@[^:]+:[\w./-]+(?:\.git)?$/.test(withoutFragment!)) {
    gitUrl = withoutFragment!;
  } else {
    let url: URL;
    try { url = new URL(withoutFragment!); } catch {
      throw new SkillPointerError(`source '${source}' cannot be normalized to a git URL. Use owner/repo or a git URL.`);
    }
    if (!["https:", "http:", "ssh:", "file:"].includes(url.protocol)) {
      throw new SkillPointerError(`source '${source}' must be a git URL. Use owner/repo or an HTTPS/SSH git URL.`);
    }
    const match = /^\/(.+?)\/(?:-\/)?tree\/([^/]+)(?:\/(.+))?$/.exec(url.pathname);
    if (match) {
      const repoPath = match[1]!;
      if (!repoPath.includes("/")) throw new SkillPointerError(`source '${source}' has no owner/repo path.`);
      gitUrl = `${url.protocol}//${url.host}/${repoPath.replace(/\.git$/, "")}.git`;
      treeRef = match[2];
      path = match[3];
    } else if (url.hostname === "github.com" || url.hostname === "gitlab.com" || url.pathname.endsWith(".git") || url.pathname.includes("/_git/")) {
      if (url.pathname.split("/").filter(Boolean).length < 2) throw new SkillPointerError(`source '${source}' has no repository path.`);
      gitUrl = `${url.protocol}//${url.host}${url.pathname.endsWith(".git") || url.pathname.includes("/_git/") ? url.pathname : `${url.pathname.replace(/\/$/, "")}.git`}`;
    } else {
      throw new SkillPointerError(`source '${source}' is a well-known or download URL, not a git repository. Use its upstream git URL in source.`);
    }
  }
  if (path && !pathInside(path)) throw new SkillPointerError(`source '${source}' has an unsafe in-repo path. Remove '..' segments.`);
  return { gitUrl, ...(ref || treeRef ? { ref: ref ?? treeRef } : {}), ...(path ? { subpath: path } : {}) };
}

export function decodeSkillPointer(value: unknown, file: string): SkillPointer {
  let decoded: SkillPointer;
  try { decoded = Schema.decodeUnknownSync(PointerSchema, { onExcessProperty: "error" })(value); }
  catch (error) { throw new SkillPointerError(`${file}: invalid skill pointer (${String(error)}). Set name, source, commit, skillPath as strings.`); }
  if (!NAME.test(decoded.name)) throw new SkillPointerError(`${file}: name must match ${NAME}; edit name to a lowercase skill directory name.`);
  if (!SHA.test(decoded.commit)) throw new SkillPointerError(`${file}: commit must be a 40-character git SHA; run 'prism skills update ${decoded.name} --plugin ${dirname(dirname(file))}'.`);
  if (!pathInside(decoded.skillPath) || (decoded.skillPath !== "SKILL.md" && !decoded.skillPath.endsWith("/SKILL.md"))) {
    throw new SkillPointerError(`${file}: skillPath must be a safe in-repo path ending in SKILL.md; edit skillPath.`);
  }
  const normalized = normalizeSkillSource(decoded.source);
  if (normalized.subpath && !decoded.skillPath.startsWith(`${normalized.subpath}/`)) {
    throw new SkillPointerError(`${file}: skillPath must lie under source subpath '${normalized.subpath}'; edit skillPath.`);
  }
  return decoded;
}

export async function listSkillPointers(pluginPath: string): Promise<SkillPointer[]> {
  const root = join(pluginPath, "skill-refs");
  try {
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new SkillPointerError(`${root}: skill-refs must be a real directory inside the plugin; replace the symlink or file.`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  let names: string[];
  names = await readdir(root);
  const pointers: SkillPointer[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".skill-ref.json")) throw new SkillPointerError(`${root}/${name}: expected <name>.skill-ref.json; rename or remove this file.`);
    const file = join(root, name);
    if (!(await lstat(file)).isFile()) throw new SkillPointerError(`${file}: pointer must be a regular JSON file inside the plugin; replace the symlink or directory.`);
    let value: unknown;
    try { value = JSON.parse(await readFile(file, "utf8")); }
    catch { throw new SkillPointerError(`${file}: invalid JSON; fix the pointer file.`); }
    const pointer = decodeSkillPointer(value, file);
    if (name !== `${pointer.name}.skill-ref.json`) throw new SkillPointerError(`${file}: rename to ${pointer.name}.skill-ref.json.`);
    pointers.push(pointer);
  }
  const firstPartyRoot = join(pluginPath, "skills");
  for (const pointer of pointers) {
    try {
      await stat(join(firstPartyRoot, pointer.name));
      throw new SkillPointerError(`Skill '${pointer.name}' is declared by plugin '${basename(pluginPath)}' as both first-party and pointer; remove one of skills/${pointer.name} or skill-refs/${pointer.name}.skill-ref.json.`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return pointers;
}

const hashKey = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function hashSkillDirectory(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (root: string): Promise<void> => {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(root, entry.name);
      if (entry.name === ".git" && entry.isDirectory()) continue;
      if (entry.isSymbolicLink()) throw new SkillPointerError(`${path}: symlinks are not allowed in pinned skill directories; replace it with a regular file.`);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) throw new SkillPointerError(`${path}: only regular files are allowed in pinned skills.`);
      hash.update(relative(dir, path).split(sep).join("/"));
      hash.update("\0");
      hash.update(await readFile(path));
      hash.update("\0");
    }
  };
  await walk(dir);
  return hash.digest("hex");
}

async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { ...(cwd ? { cwd } : {}), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) throw new SkillPointerError(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}. Check the source URL, commit, and credentials.`);
  return stdout.trim();
}

export async function resolveLatestCommit(source: string): Promise<string> {
  const normalized = normalizeSkillSource(source);
  const target = normalized.ref ? `refs/heads/${normalized.ref}` : "HEAD";
  const result = await git(["ls-remote", normalized.gitUrl, target]);
  const commit = result.split(/\s+/)[0];
  if (!commit || !SHA.test(commit)) throw new SkillPointerError(`No commit found for ${source} (${target}); correct source or branch.`);
  return commit.toLowerCase();
}

/** Cache contains only the selected skill directory, never the source checkout. */
export async function cachedSkillDirectory(pointer: SkillPointer, prismHome: string): Promise<string> {
  const source = normalizeSkillSource(pointer.source);
  const skillDir = dirname(pointer.skillPath);
  const cache = join(prismHome, "cache", "third-party-skills", hashKey(`${source.gitUrl}\0${pointer.commit}\0${skillDir}`));
  const ready = join(cache, "SKILL.md");
  try { if ((await stat(ready)).isFile()) return cache; } catch { /* cache miss */ }
  const scratch = await mkdtemp(join(tmpdir(), "prism-skill-"));
  try {
    await git(["init", "-q"], scratch);
    await git(["fetch", "--depth=1", source.gitUrl, pointer.commit], scratch);
    await git(["checkout", "-q", "FETCH_HEAD"], scratch);
    const actualCommit = await git(["rev-parse", "HEAD"], scratch);
    if (actualCommit.toLowerCase() !== pointer.commit.toLowerCase()) throw new SkillPointerError(`Fetched ${actualCommit}, expected ${pointer.commit}; correct the pin in skill-refs/${pointer.name}.skill-ref.json.`);
    const sourceDir = join(scratch, skillDir);
    if (!(await stat(join(sourceDir, "SKILL.md"))).isFile()) throw new SkillPointerError(`${pointer.skillPath} missing at ${pointer.commit}; correct skillPath.`);
    await hashSkillDirectory(sourceDir);
    await mkdir(dirname(cache), { recursive: true });
    const staging = `${cache}.${process.pid}.tmp`;
    await cp(sourceDir, staging, { recursive: true, force: false, filter: (path) => basename(path) !== ".git" });
    try { await rename(staging, cache); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; await rm(staging, { recursive: true, force: true }); }
    return cache;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function verifyCachedSkill(pointer: SkillPointer, prismHome: string, expectedHash: string): Promise<string> {
  const dir = await cachedSkillDirectory(pointer, prismHome);
  const actual = await hashSkillDirectory(dir);
  if (actual !== expectedHash) throw new SkillPointerError(`Skill '${pointer.name}' hash mismatch: prism.lock has ${expectedHash}, fetched ${actual}. Run 'prism skills update ${pointer.name} --plugin <plugin-path>' to review and repin.`);
  const validation = await validateSkill(dir, pointer.name);
  if (!validation.valid) throw new SkillPointerError(`Skill '${pointer.name}' at ${pointer.commit} failed SKILL.md validation: ${validation.errors.join("; ")}. Correct skillPath or update the source.`);
  if (validation.skillName !== pointer.name) throw new SkillPointerError(`Skill '${pointer.name}' SKILL.md declares name '${validation.skillName}'; edit skill-refs/${pointer.name}.skill-ref.json to match the upstream skill name.`);
  return dir;
}

export async function readSkillLock(pluginPath: string): Promise<Record<string, SkillLockEntry>> {
  const path = join(pluginPath, "prism.lock");
  try { if ((await lstat(path)).isSymbolicLink()) throw new SkillPointerError(`${path}: prism.lock must be a regular file inside the plugin; replace the symlink.`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new SkillPointerError(`${path}: invalid JSON; repair prism.lock.`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SkillPointerError(`${path}: expected a JSON object; repair prism.lock.`);
  const entries = (value as { thirdPartySkills?: unknown }).thirdPartySkills;
  if (entries === undefined) return {};
  try { return Schema.decodeUnknownSync(LockEntriesSchema, { onExcessProperty: "error" })(entries); }
  catch (error) { throw new SkillPointerError(`${path}: invalid thirdPartySkills (${String(error)}); remove the malformed thirdPartySkills block, then run 'prism skills update --plugin ${pluginPath}'.`); }
}

export async function writeSkillLock(pluginPath: string, entries: Record<string, SkillLockEntry>): Promise<void> {
  const path = join(pluginPath, "prism.lock");
  try { if ((await lstat(path)).isSymbolicLink()) throw new SkillPointerError(`${path}: prism.lock must be a regular file inside the plugin; replace the symlink.`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let existing: Record<string, unknown> = { version: 1 };
  try { existing = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(path, `${JSON.stringify({ ...existing, thirdPartySkills: entries }, null, 2)}\n`);
}

export function assertSkillLock(pointer: SkillPointer, entry: SkillLockEntry | undefined, pluginPath: string): string {
  const file = `skill-refs/${pointer.name}.skill-ref.json`;
  if (!entry) throw new SkillPointerError(`${pluginPath}/prism.lock lacks '${pointer.name}'; run 'prism skills update ${pointer.name} --plugin ${pluginPath}' to pin its content hash.`);
  if (entry.source !== normalizeSkillSource(pointer.source).gitUrl || entry.commit !== pointer.commit || entry.skillPath !== pointer.skillPath || !/^[0-9a-f]{64}$/i.test(entry.contentHash)) {
    throw new SkillPointerError(`${pluginPath}/prism.lock disagrees with ${file}; run 'prism skills update ${pointer.name} --plugin ${pluginPath}' to repin it.`);
  }
  return entry.contentHash;
}
