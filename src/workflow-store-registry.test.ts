import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRegisteredWorkflowStores,
  registerWorkflowStore,
  workflowStoreRegistryPath,
} from "./workflow-store-registry.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prism-workflow-store-registry-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const readRegistryPaths = async (prismHome: string): Promise<string[]> => {
  const raw = JSON.parse(await readFile(workflowStoreRegistryPath(prismHome), "utf8")) as {
    readonly stores: ReadonlyArray<{ readonly path: string }>;
  };
  return raw.stores.map((entry) => entry.path);
};

test("registerWorkflowStore prunes dead paths on write, not just at read time (WFE-008)", async () => {
  const prismHome = await createTempRoot();
  const liveStorePath = join(prismHome, "live.sqlite");
  const deadStorePath = join(prismHome, "dead.sqlite");
  await writeFile(liveStorePath, "");
  // deadStorePath is registered but never created on disk — this is the
  // append-only defect: nothing ever removes it once the file is gone.
  registerWorkflowStore(prismHome, liveStorePath);
  registerWorkflowStore(prismHome, deadStorePath);
  await rm(deadStorePath, { force: true });

  const newStorePath = join(prismHome, "new.sqlite");
  await writeFile(newStorePath, "");
  registerWorkflowStore(prismHome, newStorePath);

  // The write path itself must have dropped the dead entry — not merely
  // filtered it out at the next read (listRegisteredWorkflowStores already
  // covered that half; this asserts the on-disk file no longer carries it).
  const paths = await readRegistryPaths(prismHome);
  expect(paths.sort()).toEqual([liveStorePath, newStorePath].sort());
});

test("registerWorkflowStore replaces a re-registered path's timestamp without duplicating it", async () => {
  const prismHome = await createTempRoot();
  const storePath = join(prismHome, "workflows.sqlite");
  await writeFile(storePath, "");

  registerWorkflowStore(prismHome, storePath);
  registerWorkflowStore(prismHome, storePath);

  const paths = await readRegistryPaths(prismHome);
  expect(paths).toEqual([storePath]);
});

test("listRegisteredWorkflowStores returns only live stores, most recently opened first", async () => {
  const prismHome = await createTempRoot();
  const firstStorePath = join(prismHome, "first.sqlite");
  const secondStorePath = join(prismHome, "second.sqlite");
  await writeFile(firstStorePath, "");
  await writeFile(secondStorePath, "");

  registerWorkflowStore(prismHome, firstStorePath);
  await new Promise((resolve) => setTimeout(resolve, 5));
  registerWorkflowStore(prismHome, secondStorePath);

  const entries = listRegisteredWorkflowStores(prismHome);
  expect(entries.map((entry) => entry.path)).toEqual([secondStorePath, firstStorePath]);
});
