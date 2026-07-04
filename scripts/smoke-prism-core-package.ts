#!/usr/bin/env bun

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = resolve(import.meta.dir, "..");
const packageDir = join(repoRoot, "packages", "prism-core");

const requiredDistFiles = [
  "compile-manifest.js",
  "compile-manifest.d.ts",
  "refs.js",
  "refs.d.ts",
  "snapshot.js",
  "snapshot.d.ts",
  "stable-json.js",
  "stable-json.d.ts",
] as const;

for (const file of requiredDistFiles) {
  const path = join(packageDir, "dist", file);
  if (!existsSync(path)) {
    throw new Error(`Missing built prism-core package file: ${path}`);
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), "prism-core-smoke-"));

try {
  const scopeDir = join(tempRoot, "node_modules", "@skastr0");
  await mkdir(scopeDir, { recursive: true });
  await symlink(packageDir, join(scopeDir, "prism-core"), "dir");

  const consumerPath = join(tempRoot, "consumer.mjs");
  await writeFile(
    consumerPath,
    `
import { decodeCompileManifest, emptyCompileManifest, encodeCompileManifest, verifyCompileManifestHash } from "@skastr0/prism-core/compile-manifest";
import { parseNamedRef, parseSpaceItemRef } from "@skastr0/prism-core/refs";
import { emptySnapshotManifest, encodeSnapshotManifest } from "@skastr0/prism-core/snapshot";
import { stableJsonHash, stableJsonStringify } from "@skastr0/prism-core/stable-json";

const manifest = emptyCompileManifest();
const encoded = encodeCompileManifest(manifest);
const decoded = decodeCompileManifest(encoded);

if (decoded._tag !== "Right") throw new Error("compile manifest did not decode");
if (!verifyCompileManifestHash(decoded.right)) throw new Error("compile manifest hash did not verify");
if (parseNamedRef("core:builder").pluginPrefix !== "core") throw new Error("named ref did not parse");
if (parseSpaceItemRef("models/builder", "/")?.space !== "models") throw new Error("space item ref did not parse");
if (!encodeSnapshotManifest(emptySnapshotManifest({ harness: "codex-cli", root: "/tmp" })).includes('"version": 1')) {
  throw new Error("snapshot manifest did not encode");
}
if (stableJsonStringify({ b: 1, a: 2 }) !== '{"a":2,"b":1}') throw new Error("stable JSON did not sort keys");
if (stableJsonHash({ a: 1 }).length !== 64) throw new Error("stable JSON hash did not hash");

const resolved = await import.meta.resolve("@skastr0/prism-core/compile-manifest");
if (!resolved.endsWith("/packages/prism-core/dist/compile-manifest.js")) {
  throw new Error(\`compile-manifest resolved outside dist: \${resolved}\`);
}
`,
  );

  const proc = Bun.spawn(["node", consumerPath], {
    cwd: tempRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`prism-core package smoke failed with exit code ${exitCode}`);
  }

  console.log("prism-core package exports smoke passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
