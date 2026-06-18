import { expect, test } from "bun:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { refreshPlugin } from "./refresh.js";
import { withPrismSandbox } from "./testing/prism-sandbox.js";

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const createPlugin = async (
  root: string,
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
  await withPrismSandbox(async ({ prismHome, roots, rootFor }) => {
    const pluginRoot = await createPlugin(prismHome, "rules-demo", {
      targets: { rules: ["codex-cli"] },
    });
    await writeText(join(pluginRoot, "rules", "global", "style.md"), "# Style\n\nUse short names.\n");

    const result = await refreshPlugin({
      pluginPath: pluginRoot,
      harnesses: ["codex-cli"],
      prismHome,
      overwrite: false,
      dryRun: false,
      roots,
    });

    expect(result.success).toBe(true);
    expect(result.reports.flatMap((report) => report.ops.map((op) => op.kind))).toContain(
      "patch-regions",
    );
    const agents = await readFile(join(rootFor("codex-cli"), "AGENTS.md"), "utf8");
    expect(agents).toContain(
      "<!-- --- prism:file-router.rules.rules-demo.codex-cli.global.global/style.md begin --- -->",
    );
    expect(agents).toContain("# Style");
    expect(agents).toContain(
      "<!-- --- prism:file-router.rules.rules-demo.codex-cli.global.global/style.md end --- -->",
    );
  });
});

test("refresh prunes stale direct files through snapshot membership", async () => {
  await withPrismSandbox(async ({ prismHome, roots, rootFor }) => {
    const pluginRoot = await createPlugin(prismHome, "command-demo", {
      targets: { commands: ["codex-cli"] },
    });
    const source = join(pluginRoot, "commands", "review.md");
    await writeText(source, "# Review\n\nReview this.\n");

    const first = await refreshPlugin({
      pluginPath: pluginRoot,
      harnesses: ["codex-cli"],
      prismHome,
      overwrite: false,
      dryRun: false,
      roots,
    });
    expect(first.success).toBe(true);
    const target = join(rootFor("codex-cli"), "prompts", "review.md");
    expect(await readFile(target, "utf8")).toContain("# Review");

    await unlink(source);
    const second = await refreshPlugin({
      pluginPath: pluginRoot,
      harnesses: ["codex-cli"],
      prismHome,
      overwrite: false,
      dryRun: false,
      roots,
    });
    expect(second.reports.flatMap((report) => report.ops.map((op) => op.kind))).toContain("prune");
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });
});

test("refresh skips direct skills when compile owns targeted plugin skills", async () => {
  await withPrismSandbox(async ({ prismHome, roots, rootFor }) => {
    const pluginRoot = await createPlugin(prismHome, "compiled-skills", {
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
      prismHome,
      overwrite: false,
      dryRun: true,
      roots,
    });
    const paths = result.reports.flatMap((report) =>
      report.ops.map((op) => ("targetPath" in op ? op.targetPath : "")),
    );

    expect(paths.some((path) => path.includes(join(rootFor("openclaw"), "skills", "demo")))).toBe(
      true,
    );
    expect(
      paths.some((path) => path.includes(join(rootFor("codex-cli"), "skills", "demo"))),
    ).toBe(false);
  });
});

test("refresh lowers Cursor markdown commands into a local command plugin", async () => {
  await withPrismSandbox(async ({ prismHome, roots, rootFor }) => {
    const pluginRoot = await createPlugin(prismHome, "cursor-commands", {
      targets: { commands: ["cursor"] },
    });
    await writeText(join(pluginRoot, "commands", "review.md"), "# Review\n\nReview this.\n");

    const result = await refreshPlugin({
      pluginPath: pluginRoot,
      harnesses: ["cursor"],
      prismHome,
      overwrite: false,
      dryRun: true,
      roots,
    });

    const targets = result.reports.flatMap((report) =>
      report.ops.map((op) => ("targetPath" in op ? op.targetPath : "")),
    );
    expect(targets).toContain(
      join(
        rootFor("cursor"),
        "plugins",
        "local",
        "prism-generated-cursor-commands",
        ".cursor-plugin",
        "plugin.json",
      ),
    );
    expect(targets).toContain(
      join(
        rootFor("cursor"),
        "plugins",
        "local",
        "prism-generated-cursor-commands",
        "commands",
        "review.md",
      ),
    );
  });
});

