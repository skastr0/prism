import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanonicalCompileFixture } from "./compile/test-fixtures.js";

const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "agentpkg-cli-"));
  tempRoots.push(root);
  return root;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const mergeEnv = (overrides: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );

const runCli = async (
  args: string[],
  envOverrides: Record<string, string>
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const processHandle = Bun.spawn({
    cmd: [process.execPath, "run", join(process.cwd(), "src", "cli.ts"), ...args],
    cwd: process.cwd(),
    env: mergeEnv(envOverrides),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const createInstallAllFixture = async (): Promise<{
  monorepoRoot: string;
  projectRoot: string;
  homeRoot: string;
}> => {
  const root = await createTempRoot();
  const monorepoRoot = join(root, "monorepo");
  const projectRoot = join(root, "project-root");
  const homeRoot = join(root, "home");
  const compilePluginRoot = join(monorepoRoot, "trait-lifecycle-contracts");

  await mkdir(monorepoRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(homeRoot, { recursive: true });

  await createCanonicalCompileFixture({
    pluginRoot: compilePluginRoot,
    projectRoot,
  });

  return { monorepoRoot, projectRoot, homeRoot };
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test("install-all requires --project when project scope is requested", async () => {
  const { monorepoRoot, homeRoot } = await createInstallAllFixture();

  const result = await runCli(
    ["install-all", monorepoRoot, "--harness", "opencode", "--scope", "project"],
    { HOME: homeRoot }
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Project-local scope requires --project <path>");
});

test("install-all compiles discovered child plugins with project scope", async () => {
  const { monorepoRoot, projectRoot, homeRoot } = await createInstallAllFixture();

  const result = await runCli(
    [
      "install-all",
      monorepoRoot,
      "--harness",
      "opencode,claude-code",
      "--scope",
      "project",
      "--project",
      projectRoot,
      "--no-backup",
    ],
    { HOME: homeRoot }
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    "Manifest targets: agents=[opencode, claude-code]; lifecycles=[opencode, claude-code]; tools=[opencode, claude-code]; toolspaces=[opencode, claude-code]; modelspaces=[opencode, claude-code]"
  );
  expect(result.stdout).toContain("Matching requested harnesses: opencode, claude-code");
  expect(result.stdout).toContain("Compile output scope: project");
  expect(result.stdout).toContain("Compile (opencode, project)");
  expect(result.stdout).toContain("Compile (claude-code, project)");
  expect(result.stdout).toContain("All plugin refreshes completed successfully");

  expect(
    await pathExists(join(projectRoot, ".opencode", "agents", "builder.md"))
  ).toBe(true);
  expect(
    await pathExists(join(projectRoot, ".opencode", "skills", "delivery-contract", "SKILL.md"))
  ).toBe(true);
  expect(
    await pathExists(join(projectRoot, ".claude", "agents", "builder.md"))
  ).toBe(true);
  expect(
    await pathExists(join(projectRoot, ".claude", "skills", "delivery-contract", "SKILL.md"))
  ).toBe(true);
  expect(
    await pathExists(join(homeRoot, ".config", "opencode", "agents", "builder.md"))
  ).toBe(false);
  expect(await pathExists(join(homeRoot, ".claude", "agents", "builder.md"))).toBe(false);
});
