import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const srcRoot = resolve(repoRoot, "src");
const entry = resolve(srcRoot, "packager.ts");

const resolveImport = (fromFile: string, spec: string): string | null => {
  if (!spec.startsWith(".")) return null;
  const raw = resolve(dirname(fromFile), spec);
  const candidates = [
    raw,
    `${raw}.ts`,
    `${raw}.tsx`,
    raw.replace(/\.js$/, ".ts"),
    raw.replace(/\.js$/, ".tsx"),
    join(raw, "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
};

const collectSourceGraph = (start: string): string[] => {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file) || !file.startsWith(srcRoot)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
      const resolved = resolveImport(file, match[1] ?? "");
      if (resolved) queue.push(resolved);
    }
  }
  return [...seen];
};

test("packager import graph excludes CLI and TUI surfaces", () => {
  const files = collectSourceGraph(entry).map((file) => relative(srcRoot, file));
  const forbidden = files.filter(
    (rel) =>
      rel === "cli.ts" ||
      rel.startsWith("plugins-tui/") ||
      rel.startsWith("configure/") ||
      rel === "workflow-tui.tsx" ||
      rel.startsWith("workflow-tui."),
  );
  expect(forbidden).toEqual([]);
  expect(files).toContain("packager.ts");
  expect(files.some((rel) => rel.startsWith("compile/"))).toBe(true);
});

test("published packager package.json has no workspace:* dependencies", async () => {
  const pkgPath = join(repoRoot, "packages", "prism-packager", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const field of ["dependencies", "devDependencies"] as const) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      expect(range.startsWith("workspace:"), `${field}.${name}=${range}`).toBe(false);
    }
  }
});
