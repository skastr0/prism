import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile as writeFileNode } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLockfile, writeLockfile } from "./lockfile.js";
import { emptyRegistry } from "./registry.js";
import { CanonicalTool, Hook, Trait } from "./sources.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-lockfile-test-"));
  tempRoots.push(root);
  return root;
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFileNode(path, content);
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("lockfile hashes a tool-only plugin, and changing the tool source changes the lock hash", async () => {
  const pluginRoot = await createTempRoot();
  const toolPath = join(pluginRoot, "tools", "commit_work.tool.ts");
  await writeText(toolPath, "export default { name: 'commit_work' };\n");

  const registry = emptyRegistry(pluginRoot, "tool-only-plugin", "0.1.0");
  registry.tools.set(
    "commit_work",
    new CanonicalTool({
      name: "commit_work",
      sourcePath: toolPath,
      description: "Commit work",
      input: {},
      output: {},
      slots: {},
      async handle() {
        return {};
      },
    }),
  );

  await writeLockfile(pluginRoot, registry);
  const first = await readLockfile(pluginRoot);
  const firstEntry = first?.entries[0];
  expect(firstEntry?.sources.map((source) => source.path)).toEqual([
    "tools/commit_work.tool.ts",
  ]);
  const firstToolHash = firstEntry?.sources[0]?.contentHash;
  const firstEntryHash = firstEntry?.contentHash;

  await writeText(toolPath, "export default { name: 'commit_work', changed: true };\n");
  await writeLockfile(pluginRoot, registry);
  const second = await readLockfile(pluginRoot);
  const secondEntry = second?.entries[0];

  expect(secondEntry?.sources[0]?.contentHash).not.toBe(firstToolHash);
  expect(secondEntry?.contentHash).not.toBe(firstEntryHash);
});

test("lockfile hashes a hook-only plugin, and changing the hook source changes the lock hash", async () => {
  const pluginRoot = await createTempRoot();
  const hookPath = join(pluginRoot, "hooks", "session-start.hook.ts");
  await writeText(hookPath, "export default { name: 'session-start' };\n");

  const registry = emptyRegistry(pluginRoot, "hook-only-plugin", "0.1.0");
  registry.hooks.set(
    "session-start",
    new Hook({
      name: "session-start",
      sourcePath: hookPath,
      event: "session.start",
      targets: [],
      match: {},
      handle: () => {},
    }),
  );

  await writeLockfile(pluginRoot, registry);
  const first = await readLockfile(pluginRoot);
  const firstEntry = first?.entries[0];
  expect(firstEntry?.sources.map((source) => source.path)).toEqual([
    "hooks/session-start.hook.ts",
  ]);
  const firstHookHash = firstEntry?.sources[0]?.contentHash;
  const firstEntryHash = firstEntry?.contentHash;

  await writeText(hookPath, "export default { name: 'session-start', changed: true };\n");
  await writeLockfile(pluginRoot, registry);
  const second = await readLockfile(pluginRoot);
  const secondEntry = second?.entries[0];

  expect(secondEntry?.sources[0]?.contentHash).not.toBe(firstHookHash);
  expect(secondEntry?.contentHash).not.toBe(firstEntryHash);
});

test("lockfile hashes tools and hooks alongside a trait-generated tool contract, and is stable across a no-op round trip", async () => {
  const pluginRoot = await createTempRoot();
  const toolPath = join(pluginRoot, "tools", "submit_review.tool.ts");
  const hookPath = join(pluginRoot, "hooks", "session-start.hook.ts");
  const traitPath = join(pluginRoot, "traits", "reviewable.trait.ts");
  await writeText(toolPath, "export default { name: 'submit_review' };\n");
  await writeText(hookPath, "export default { name: 'session-start' };\n");
  await writeText(traitPath, "export default { name: 'reviewable' };\n");

  const registry = emptyRegistry(pluginRoot, "mixed-plugin", "0.1.0");
  registry.tools.set(
    "submit_review",
    new CanonicalTool({
      name: "submit_review",
      sourcePath: toolPath,
      description: "Submit review",
      input: {},
      output: {},
      slots: {},
      async handle() {
        return {};
      },
    }),
  );
  registry.hooks.set(
    "session-start",
    new Hook({
      name: "session-start",
      sourcePath: hookPath,
      event: "session.start",
      targets: [],
      match: {},
      handle: () => {},
    }),
  );
  // The trait attaches (materializes) a synthetic tool contract from
  // `submit_review` -- there is no separate generated-contract file on disk
  // to hash; the trait source and the wrapped canonical tool source (both
  // already collected) are what the lockfile represents this derived
  // artifact through.
  registry.traits.set(
    "reviewable",
    new Trait({
      name: "reviewable",
      sourcePath: traitPath,
      instructions: [],
      access: { tools: [], toolGroups: [], skills: [] },
      tools: {
        submit: { ref: "submit_review" },
      },
      inject: { skills: [] },
      require: { tools: [], skills: [] },
    }),
  );

  await writeLockfile(pluginRoot, registry);
  const first = await readLockfile(pluginRoot);
  const firstEntry = first?.entries[0];
  expect(firstEntry?.sources.map((source) => source.path).sort()).toEqual([
    "hooks/session-start.hook.ts",
    "tools/submit_review.tool.ts",
    "traits/reviewable.trait.ts",
  ]);

  // Round trip: re-writing over unchanged sources must not touch the lock
  // (same hash, same `generatedAt`) -- proves presence is stable, not an
  // artifact of always re-stamping.
  await writeLockfile(pluginRoot, registry);
  const second = await readLockfile(pluginRoot);
  expect(second).toEqual(first);

  // Changing only the trait's own source (not the tool it wraps) still
  // moves the lock hash, since traits are independently collected.
  await writeText(traitPath, "export default { name: 'reviewable', changed: true };\n");
  await writeLockfile(pluginRoot, registry);
  const third = await readLockfile(pluginRoot);
  const thirdEntry = third?.entries[0];
  expect(thirdEntry?.contentHash).not.toBe(firstEntry?.contentHash);
  expect(thirdEntry?.sources.map((source) => source.path).sort()).toEqual([
    "hooks/session-start.hook.ts",
    "tools/submit_review.tool.ts",
    "traits/reviewable.trait.ts",
  ]);
});
