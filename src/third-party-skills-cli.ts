import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { readManifest } from "./manifest.js";
import { listDirRecursive } from "./fs.js";
import {
  cachedSkillDirectory,
  decodeSkillPointer,
  hashSkillDirectory,
  listSkillPointers,
  normalizeSkillSource,
  readSkillLock,
  resolveLatestCommit,
  SkillPointerError,
  writeSkillLock,
  type SkillLockEntry,
  type SkillPointer,
} from "./third-party-skills.js";

const NpxEntry = Schema.Struct({
  source: Schema.String,
  sourceType: Schema.String,
  sourceUrl: Schema.String,
  ref: Schema.optional(Schema.String),
  skillPath: Schema.optional(Schema.String),
});
const NpxLock = Schema.Struct({
  version: Schema.Number,
  skills: Schema.Record(Schema.String, NpxEntry),
});

export interface SkillPinChange {
  readonly name: string;
  readonly oldCommit?: string;
  readonly newCommit: string;
  readonly oldHash?: string;
  readonly newHash: string;
  readonly diff?: string;
}

const diffSkillDirs = async (before: string, after: string): Promise<string> => {
  const hashFiles = async (dir: string): Promise<Map<string, string>> => {
    const rows = new Map<string, string>();
    for (const path of await listDirRecursive(dir)) {
      rows.set(path, createHash("sha256").update(await readFile(join(dir, path))).digest("hex"));
    }
    return rows;
  };
  const [oldFiles, newFiles] = await Promise.all([hashFiles(before), hashFiles(after)]);
  let added = 0, changed = 0, removed = 0;
  for (const [path, hash] of newFiles) {
    if (!oldFiles.has(path)) added++;
    else if (oldFiles.get(path) !== hash) changed++;
  }
  for (const path of oldFiles.keys()) if (!newFiles.has(path)) removed++;
  return `${added} added, ${changed} changed, ${removed} removed`;
};

const writePointer = async (pluginPath: string, pointer: SkillPointer): Promise<void> => {
  const dir = join(pluginPath, "skill-refs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${pointer.name}.skill-ref.json`), `${JSON.stringify(pointer, null, 2)}\n`);
};

export async function importNpxSkills(options: {
  readonly pluginPath: string;
  readonly prismHome: string;
  readonly dryRun: boolean;
  readonly lockPath?: string;
}): Promise<SkillPinChange[]> {
  const manifest = await readManifest(options.pluginPath);
  if (!manifest.targets.skills?.length) throw new SkillPointerError(`${options.pluginPath}/plugin.json: add targets.skills before import; the plugin decides harness permissions.`);
  const lockPath = options.lockPath ?? join(homedir(), ".agents", ".skill-lock.json");
  let input: Schema.Schema.Type<typeof NpxLock>;
  try { input = Schema.decodeUnknownSync(NpxLock)(JSON.parse(await readFile(lockPath, "utf8"))); }
  catch (error) { throw new SkillPointerError(`${lockPath}: invalid npx skills lock (${String(error)}); supply a version-3 .skill-lock.json.`); }
  if (input.version !== 3) throw new SkillPointerError(`${lockPath}: expected npx skills lock version 3; upgrade the lock before import.`);
  const existing = new Map((await listSkillPointers(options.pluginPath)).map((pointer) => [pointer.name, pointer]));
  const lock = await readSkillLock(options.pluginPath);
  const prepared: Array<{ pointer: SkillPointer; entry: SkillLockEntry; change: SkillPinChange }> = [];
  for (const [name, row] of Object.entries(input.skills).sort(([a], [b]) => a.localeCompare(b))) {
    if (row.sourceType !== "github" && row.sourceType !== "git" && row.sourceType !== "gitlab") {
      throw new SkillPointerError(`${lockPath}: '${name}' sourceType '${row.sourceType}' cannot be pinned to git; provide its git URL manually.`);
    }
    if (!row.skillPath) throw new SkillPointerError(`${lockPath}: '${name}' has no skillPath; add its in-repo SKILL.md path before import.`);
    const source = normalizeSkillSource(row.sourceUrl).gitUrl;
    const commit = row.ref && /^[0-9a-f]{40}$/i.test(row.ref) ? row.ref.toLowerCase() : await resolveLatestCommit(row.sourceUrl);
    const pointer = { name, source, commit, skillPath: row.skillPath };
    decodeSkillPointer(pointer, join(options.pluginPath, "skill-refs", `${name}.skill-ref.json`));
    try {
      await stat(join(options.pluginPath, "skills", name));
      throw new SkillPointerError(`Plugin '${manifest.name}' already owns first-party skill '${name}'; remove that skill or omit it from the npx import.`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const previous = existing.get(name);
    if (previous && (previous.source !== pointer.source || previous.skillPath !== pointer.skillPath || previous.commit !== pointer.commit)) {
      throw new SkillPointerError(`skill-refs/${name}.skill-ref.json already exists with a different pin; run 'prism skills update ${name} --plugin ${options.pluginPath}' or remove the old pointer before import.`);
    }
    if (options.dryRun) {
      prepared.push({ pointer, entry: { source, commit, skillPath: pointer.skillPath, contentHash: lock[name]?.contentHash ?? "" }, change: { name, oldCommit: previous?.commit, newCommit: commit, oldHash: lock[name]?.contentHash, newHash: "(dry-run: not fetched)" } });
      continue;
    }
    const dir = await cachedSkillDirectory(pointer, options.prismHome);
    const contentHash = await hashSkillDirectory(dir);
    prepared.push({ pointer, entry: { source, commit, skillPath: pointer.skillPath, contentHash }, change: { name, oldCommit: previous?.commit, newCommit: commit, oldHash: lock[name]?.contentHash, newHash: contentHash } });
  }
  if (!options.dryRun) {
    for (const item of prepared) { await writePointer(options.pluginPath, item.pointer); lock[item.pointer.name] = item.entry; }
    await writeSkillLock(options.pluginPath, lock);
  }
  return prepared.map((item) => item.change);
}

export async function updateSkillPins(options: {
  readonly pluginPath: string;
  readonly prismHome: string;
  readonly name?: string;
}): Promise<SkillPinChange[]> {
  await readManifest(options.pluginPath);
  const pointers = await listSkillPointers(options.pluginPath);
  const selected = options.name ? pointers.filter((pointer) => pointer.name === options.name) : pointers;
  if (selected.length === 0) throw new SkillPointerError(`No skill pointer '${options.name ?? "*"}' in ${options.pluginPath}/skill-refs; add a .skill-ref.json pointer first.`);
  const lock = await readSkillLock(options.pluginPath);
  const prepared: Array<{ pointer: SkillPointer; entry: SkillLockEntry; change: SkillPinChange }> = [];
  for (const pointer of selected) {
    const commit = await resolveLatestCommit(pointer.source);
    const next = { ...pointer, commit };
    const dir = await cachedSkillDirectory(next, options.prismHome);
    const contentHash = await hashSkillDirectory(dir);
    const diff = commit === pointer.commit ? "0 added, 0 changed, 0 removed" : await diffSkillDirs(await cachedSkillDirectory(pointer, options.prismHome), dir);
    prepared.push({ pointer: next, entry: { source: normalizeSkillSource(next.source).gitUrl, commit, skillPath: next.skillPath, contentHash }, change: { name: next.name, oldCommit: pointer.commit, newCommit: commit, oldHash: lock[next.name]?.contentHash, newHash: contentHash, diff } });
  }
  for (const item of prepared) { await writePointer(options.pluginPath, item.pointer); lock[item.pointer.name] = item.entry; }
  await writeSkillLock(options.pluginPath, lock);
  return prepared.map((item) => item.change);
}
