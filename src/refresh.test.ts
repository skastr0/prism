import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { refreshPlugin } from "./refresh.js";

let root: string;
let originalHome: string | undefined;
let originalPrismHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prism-refresh-"));
  originalHome = process.env.HOME;
  originalPrismHome = process.env.PRISM_HOME;
  process.env.HOME = join(root, "home");
  process.env.PRISM_HOME = join(root, "prism-home");
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PRISM_HOME = originalPrismHome;
  await rm(root, { recursive: true, force: true });
});

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const createPlugin = async (
  name: string,
  manifest: Record<string, unknown>,
): Promise<string> => {
  const pluginRoot = join(root, name);
  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify({ name, version: "0.1.0", ...manifest }, null, 2)}\n`,
  );
  return pluginRoot;
};

test("refresh writes Markdown rules as sync marker regions with closed comments", async () => {
  const pluginRoot = await createPlugin("rules-demo", {
    targets: { rules: ["codex-cli"] },
  });
  await writeText(join(pluginRoot, "rules", "global", "style.md"), "# Style\n\nUse short names.\n");

  const result = await refreshPlugin({
    pluginPath: pluginRoot,
    harnesses: ["codex-cli"],
    prismHome: process.env.PRISM_HOME!,
    overwrite: false,
    dryRun: false,
  });

  expect(result.success).toBe(true);
  expect(result.reports.flatMap((report) => report.ops.map((op) => op.kind))).toContain(
    "patch-regions",
  );
  const agents = await readFile(join(process.env.HOME!, ".codex", "AGENTS.md"), "utf8");
  expect(agents).toContain("<!-- --- prism:file-router.rules.rules-demo.codex-cli.global.global/style.md begin --- -->");
  expect(agents).toContain("# Style");
  expect(agents).toContain("<!-- --- prism:file-router.rules.rules-demo.codex-cli.global.global/style.md end --- -->");
});

test("refresh prunes stale direct files through snapshot membership", async () => {
  const pluginRoot = await createPlugin("command-demo", {
    targets: { commands: ["codex-cli"] },
  });
  const source = join(pluginRoot, "commands", "review.md");
  await writeText(source, "# Review\n\nReview this.\n");

  const first = await refreshPlugin({
    pluginPath: pluginRoot,
    harnesses: ["codex-cli"],
    prismHome: process.env.PRISM_HOME!,
    overwrite: false,
    dryRun: false,
  });
  expect(first.success).toBe(true);
  const target = join(process.env.HOME!, ".codex", "prompts", "review.md");
  expect(await readFile(target, "utf8")).toContain("# Review");

  await unlink(source);
  const second = await refreshPlugin({
    pluginPath: pluginRoot,
    harnesses: ["codex-cli"],
    prismHome: process.env.PRISM_HOME!,
    overwrite: false,
    dryRun: false,
  });
  expect(second.reports.flatMap((report) => report.ops.map((op) => op.kind))).toContain("prune");
  await expect(readFile(target, "utf8")).rejects.toThrow();
});

test("refresh skips direct skills when compile owns targeted plugin skills", async () => {
  const pluginRoot = await createPlugin("compiled-skills", {
    targets: {
      skills: ["codex-cli", "openclaw"],
      tools: ["codex-cli"],
    },
  });
  await writeText(
    join(pluginRoot, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n\nUse this skill.\n",
  );

  const result = await refreshPlugin({
    pluginPath: pluginRoot,
    harnesses: ["codex-cli", "openclaw"],
    prismHome: process.env.PRISM_HOME!,
    overwrite: false,
    dryRun: true,
  });
  const paths = result.reports.flatMap((report) =>
    report.ops.map((op) => "targetPath" in op ? op.targetPath : ""),
  );

  expect(paths.some((path) => path.includes(join(".openclaw", "skills", "demo")))).toBe(true);
  expect(paths.some((path) => path.includes(join(".codex", "skills", "demo")))).toBe(false);
});

test("refresh lowers Cursor markdown commands into a local command plugin", async () => {
  const pluginRoot = await createPlugin("cursor-commands", {
    targets: { commands: ["cursor"] },
  });
  await writeText(join(pluginRoot, "commands", "review.md"), "# Review\n\nReview this.\n");

  const result = await refreshPlugin({
    pluginPath: pluginRoot,
    harnesses: ["cursor"],
    prismHome: process.env.PRISM_HOME!,
    overwrite: false,
    dryRun: true,
  });

  const targets = result.reports.flatMap((report) =>
    report.ops.map((op) => "targetPath" in op ? op.targetPath : ""),
  );
  expect(targets).toContain(
    join(
      process.env.HOME!,
      ".cursor",
      "plugins",
      "local",
      "prism-generated-cursor-commands",
      ".cursor-plugin",
      "plugin.json",
    ),
  );
  expect(targets).toContain(
    join(
      process.env.HOME!,
      ".cursor",
      "plugins",
      "local",
      "prism-generated-cursor-commands",
      "commands",
      "review.md",
    ),
  );
});
