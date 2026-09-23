import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withPrismSandbox } from "./testing/prism-sandbox.js";
import { refreshPlugin } from "./refresh.js";
import { importNpxSkills, updateSkillPins } from "./third-party-skills-cli.js";
import {
  cachedSkillDirectory,
  decodeSkillPointer,
  hashSkillDirectory,
  normalizeSkillSource,
  writeSkillLock,
  type SkillPointer,
} from "./third-party-skills.js";

const write = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const git = async (repo: string, ...args: string[]): Promise<string> => {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err);
  return out.trim();
};

const fixture = async (root: string, name = "third-party"): Promise<{ plugin: string; pointer: SkillPointer; repo: string }> => {
  const repo = join(root, "source.git");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q");
  await write(join(repo, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo imported skill\n---\n# Demo\n\nFirst revision.\n");
  await write(join(repo, "skills", "demo", "references", "guide.md"), "Guide one.\n");
  await writeFile(join(repo, "skills", "demo", "icon.png"), new Uint8Array([0, 255, 42, 10]));
  await git(repo, "add", "skills");
  await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
  const commit = await git(repo, "rev-parse", "HEAD");
  const plugin = join(root, name);
  await write(join(plugin, "plugin.json"), JSON.stringify({ name, version: "0.1.0", targets: { skills: ["opencode"] } }));
  const pointer = { name: "demo", source: `file://${repo}`, commit, skillPath: "skills/demo/SKILL.md" };
  await write(join(plugin, "skill-refs", "demo.skill-ref.json"), JSON.stringify(pointer));
  return { plugin, pointer, repo };
};

test("source normalization and Effect Schema pointer decode fail closed", () => {
  expect(normalizeSkillSource("owner/repo/skills/demo")).toEqual({ gitUrl: "https://github.com/owner/repo.git", subpath: "skills/demo" });
  expect(normalizeSkillSource("https://github.com/owner/repo/tree/main/skills/demo")).toEqual({ gitUrl: "https://github.com/owner/repo.git", ref: "main", subpath: "skills/demo" });
  expect(() => normalizeSkillSource("https://skills.sh/owner/repo/demo")).toThrow("well-known");
  expect(() => decodeSkillPointer({ name: "demo", source: "owner/repo", commit: "main", skillPath: "../SKILL.md" }, "/p/skill-refs/demo.skill-ref.json")).toThrow("commit must be");
});

test("pinned pointer refresh uses desired-state ownership, verifies hash, and works offline from cache", async () => {
  await withPrismSandbox(async ({ prismHome, roots, rootFor }) => {
    const { plugin, pointer, repo } = await fixture(prismHome);
    const dir = await cachedSkillDirectory(pointer, prismHome);
    const hash = await hashSkillDirectory(dir);
    await writeSkillLock(plugin, { demo: { source: pointer.source, commit: pointer.commit, skillPath: pointer.skillPath, contentHash: hash } });
    const options = { pluginPath: plugin, harnesses: ["opencode"] as const, prismHome, overwrite: false, dryRun: false, roots };
    const first = await refreshPlugin(options);
    expect(first.success).toBe(true);
    expect(await readFile(join(rootFor("opencode"), "skills", "demo", "references", "guide.md"), "utf8")).toContain("Guide one.");
    expect([...await readFile(join(rootFor("opencode"), "skills", "demo", "icon.png"))]).toEqual([0, 255, 42, 10]);
    await rm(repo, { recursive: true, force: true });
    const offline = await refreshPlugin(options);
    expect(offline.success).toBe(true);
    await writeSkillLock(plugin, { demo: { source: pointer.source, commit: pointer.commit, skillPath: pointer.skillPath, contentHash: "0".repeat(64) } });
    await expect(refreshPlugin(options)).rejects.toThrow("hash mismatch");
  });
});

test("skill pointer crashes on first-party and cross-plugin name collisions", async () => {
  await withPrismSandbox(async ({ prismHome, roots }) => {
    const { plugin, pointer } = await fixture(prismHome, "first");
    const hash = await hashSkillDirectory(await cachedSkillDirectory(pointer, prismHome));
    await writeSkillLock(plugin, { demo: { source: pointer.source, commit: pointer.commit, skillPath: pointer.skillPath, contentHash: hash } });
    await write(join(plugin, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Local skill\n---\n# Demo\n");
    await expect(refreshPlugin({ pluginPath: plugin, harnesses: ["opencode"], prismHome, roots, overwrite: false, dryRun: true })).rejects.toThrow("both first-party and pointer");
    await rm(join(plugin, "skills"), { recursive: true });
    await refreshPlugin({ pluginPath: plugin, harnesses: ["opencode"], prismHome, roots, overwrite: false, dryRun: false });
    const second = join(prismHome, "second");
    await write(join(second, "plugin.json"), JSON.stringify({ name: "second", version: "0.1.0", targets: { skills: ["opencode"] } }));
    await write(join(second, "skill-refs", "demo.skill-ref.json"), JSON.stringify(pointer));
    await writeSkillLock(second, { demo: { source: pointer.source, commit: pointer.commit, skillPath: pointer.skillPath, contentHash: hash } });
    await expect(refreshPlugin({ pluginPath: second, harnesses: ["opencode"], prismHome, roots, overwrite: false, dryRun: true })).rejects.toThrow("first#file-router");
  });
});

test("import-npx reads fixture lock, pins pointers, and dry run leaves plugin untouched", async () => {
  await withPrismSandbox(async ({ prismHome }) => {
    const { plugin, pointer } = await fixture(prismHome);
    await rm(join(plugin, "skill-refs"), { recursive: true });
    const lockPath = join(prismHome, "npx-lock.json");
    await write(lockPath, JSON.stringify({ version: 3, skills: { demo: { source: "fixture/source", sourceType: "git", sourceUrl: pointer.source, ref: pointer.commit, skillPath: pointer.skillPath } } }));
    const planned = await importNpxSkills({ pluginPath: plugin, prismHome, lockPath, dryRun: true });
    expect(planned[0]?.newCommit).toBe(pointer.commit);
    await expect(readFile(join(plugin, "skill-refs", "demo.skill-ref.json"))).rejects.toThrow();
    await importNpxSkills({ pluginPath: plugin, prismHome, lockPath, dryRun: false });
    expect(JSON.parse(await readFile(join(plugin, "skill-refs", "demo.skill-ref.json"), "utf8"))).toEqual(pointer);
    expect(JSON.parse(await readFile(join(plugin, "prism.lock"), "utf8")).thirdPartySkills.demo.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

test("skills update advances the commit and reports changed files", async () => {
  await withPrismSandbox(async ({ prismHome }) => {
    const { plugin, pointer, repo } = await fixture(prismHome);
    const oldHash = await hashSkillDirectory(await cachedSkillDirectory(pointer, prismHome));
    await writeSkillLock(plugin, { demo: { source: pointer.source, commit: pointer.commit, skillPath: pointer.skillPath, contentHash: oldHash } });
    await write(join(repo, "skills", "demo", "references", "guide.md"), "Guide two.\n");
    await git(repo, "add", "skills");
    await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "second");
    const changes = await updateSkillPins({ pluginPath: plugin, prismHome, name: "demo" });
    expect(changes[0]?.oldCommit).toBe(pointer.commit);
    expect(changes[0]?.newCommit).toBe(await git(repo, "rev-parse", "HEAD"));
    expect(changes[0]?.diff).toBe("0 added, 1 changed, 0 removed");
    expect(JSON.parse(await readFile(join(plugin, "prism.lock"), "utf8")).thirdPartySkills.demo.contentHash).not.toBe(oldHash);
  });
});
