import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

const toRelative = (path: string): string => relative(repoRoot, path).replace(/\\/g, "/");

const resolveLocalSpecifier = (fromFile: string, specifier: string): string | null => {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const ext = extname(base);
  const candidates = ext.length > 0
    ? [
      base.replace(/\.(?:js|mjs|cjs)$/u, ".ts"),
      base.replace(/\.(?:js|mjs|cjs)$/u, ".tsx"),
      base,
    ]
    : [
      `${base}.ts`,
      `${base}.tsx`,
      resolve(base, "index.ts"),
    ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`could not resolve ${specifier} from ${toRelative(fromFile)}`);
};

const runtimeImportSpecifiers = (source: string): readonly string[] => {
  const specifiers: string[] = [];
  const patterns = [
    /^\s*import\s+(?!type\b)(?!\()[^;\n]*\sfrom\s+["']([^"']+)["']/gmu,
    /^\s*export\s+(?!type\b)(?:\*|\{)[^;\n]*\sfrom\s+["']([^"']+)["']/gmu,
    /^\s*import\s+["']([^"']+)["']/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
};

const collectRuntimeGraph = async (entry: string): Promise<{
  readonly localFiles: ReadonlySet<string>;
  readonly externalSpecifiers: ReadonlySet<string>;
}> => {
  const seen = new Set<string>();
  const external = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const specifier of runtimeImportSpecifiers(source)) {
      const local = resolveLocalSpecifier(file, specifier);
      if (local === null) {
        external.add(specifier);
      } else {
        pending.push(local);
      }
    }
  }

  return { localFiles: seen, externalSpecifiers: external };
};

describe("workflow SDK graph", () => {
  test("public in-memory workflow exports do not pull the file loader toolchain", async () => {
    const graph = await collectRuntimeGraph(resolve(repoRoot, "src", "index.ts"));
    const localFiles = [...graph.localFiles].map(toRelative).sort();

    expect(localFiles).not.toContain("src/workflow-loader.ts");
    expect(localFiles).not.toContain("src/workflow-tsconfig.ts");
    expect(localFiles).not.toContain("src/prism-home.ts");
    expect(localFiles).not.toContain("src/project-key.ts");
    expect(localFiles.filter((file) => file.startsWith("src/compile/"))).toEqual([]);
    expect([...graph.externalSpecifiers].sort()).not.toContain("typescript");
  });
});
