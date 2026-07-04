#!/usr/bin/env bun

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = resolve(import.meta.dir, "..");
const packageDir = join(repoRoot, "packages", "prism-core");

const run = async (
  label: string,
  command: readonly string[],
  options?: { readonly cwd?: string; readonly capture?: boolean },
): Promise<string> => {
  console.log(`\n${label}`);
  const proc = Bun.spawn(command, {
    cwd: options?.cwd ?? repoRoot,
    stdout: options?.capture ? "pipe" : "inherit",
    stderr: "pipe",
  });
  const stdout = options?.capture ? await new Response(proc.stdout).text() : "";
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (stderr.length > 0) {
    process.stderr.write(stderr);
  }

  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`);
  }

  return stdout;
};

const packPackage = async (tarballDir: string): Promise<string> => {
  const stdout = await run(
    "Packing prism-core",
    ["npm", "pack", "--json", "--pack-destination", tarballDir],
    { cwd: packageDir, capture: true },
  );
  const parsed = JSON.parse(stdout) as Array<{ readonly filename: string }>;
  const filename = parsed[0]?.filename;
  if (!filename) {
    throw new Error("npm pack did not return a prism-core tarball");
  }
  return join(tarballDir, filename);
};

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
  const tarballDir = join(tempRoot, "tarballs");
  const appRoot = join(tempRoot, "app");
  await mkdir(tarballDir, { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await writeFile(join(appRoot, "package.json"), `{"private":true,"type":"module"}\n`);

  const tarball = await packPackage(tarballDir);
  await run(
    "Installing packed prism-core into clean project",
    ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: appRoot },
  );

  const consumerPath = join(appRoot, "consumer.mjs");
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
if (!resolved.endsWith("/node_modules/@skastr0/prism-core/dist/compile-manifest.js")) {
  throw new Error(\`compile-manifest resolved outside the packed install: \${resolved}\`);
}
`,
  );

  await run("Importing prism-core public subpaths from packed install", ["node", consumerPath], { cwd: appRoot });

  console.log("prism-core package exports smoke passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
