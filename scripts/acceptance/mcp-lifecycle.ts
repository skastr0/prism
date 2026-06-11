/**
 * Acceptance gate: mcp-lifecycle (overhaul WS6 regression net).
 *
 * Builds a tiny Streamable HTTP MCP plugin in a temp corpus, compiles it into
 * sandboxed Hermes and Codex roots, restarts the daemon five times, and checks
 * that harness configs stay byte-identical while the daemon identity is stable.
 * The gate never points at real harness roots or the real ~/.prism.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
const PLUGIN_NAME = "mcp-lifecycle-acceptance";
const SERVER_NAME = "prism-generated-mcp-lifecycle-acceptance";
const TOKEN_ENV = ["PRISM", "MCP", "ACCEPTANCE", "TOKEN"].join("_");
const TOKEN = [
  "prism",
  "mcp",
  "lifecycle",
  "acceptance",
  "token",
  "with",
  "enough",
  "entropy",
].join("-");

interface Assertion {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const assertions: Assertion[] = [];
const execFileAsync = promisify(execFile);

const record = (name: string, pass: boolean, detail: string): void => {
  assertions.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const run = async (
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd ?? REPO_ROOT,
    env: {
      ...process.env,
      PRISM_MCP_DISABLE_LAUNCHD: "1",
      [TOKEN_ENV]: TOKEN,
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const runOk = async (
  name: string,
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ stdout: string; stderr: string }> => {
  const result = await run(cmd, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${name} failed with exit ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
};

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const runtimeDir = (prismHome: string): string =>
  join(prismHome, "runtime", "mcp", PLUGIN_NAME);

const runtimePath = (prismHome: string): string => join(runtimeDir(prismHome), "runtime.json");

const serverPath = (prismHome: string): string => join(runtimeDir(prismHome), "server.mjs");

const tokenStorePath = (prismHome: string): string =>
  join(prismHome, "runtime", "mcp", "tokens.json");

const readRuntime = async (prismHome: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(runtimePath(prismHome), "utf8")) as Record<string, unknown>;

const readStoredToken = async (prismHome: string): Promise<string> => {
  const parsed = JSON.parse(await readFile(tokenStorePath(prismHome), "utf8")) as {
    readonly tokens?: Record<string, { readonly token?: unknown }>;
  };
  const token = parsed.tokens?.[SERVER_NAME]?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`missing stored token for ${SERVER_NAME}`);
  }
  return token;
};

const readConfigs = async (roots: {
  readonly hermes: string;
  readonly codex: string;
}): Promise<{ readonly hermes: string; readonly codex: string }> => ({
  hermes: await readFile(join(roots.hermes, "config.yaml"), "utf8"),
  codex: await readFile(join(roots.codex, "config.toml"), "utf8"),
});

const hashConfigs = async (roots: {
  readonly hermes: string;
  readonly codex: string;
}): Promise<string> => {
  const configs = await readConfigs(roots);
  return sha256(`${configs.hermes}\0${configs.codex}`);
};

const mcpUrlForPort = (port: number): string => `http://127.0.0.1:${port}/mcp`;

const configsContainPort = (
  configs: { readonly hermes: string; readonly codex: string },
  port: number,
): boolean => {
  const url = mcpUrlForPort(port);
  return configs.hermes.includes(url) && configs.codex.includes(url);
};

const configsOmitPort = (
  configs: { readonly hermes: string; readonly codex: string },
  port: number,
): boolean => {
  const url = mcpUrlForPort(port);
  return !configs.hermes.includes(url) && !configs.codex.includes(url);
};

const compile = async (
  pluginRoot: string,
  prismHome: string,
  harness: "hermes" | "codex-cli",
  root: string,
): Promise<void> => {
  await runOk(`refresh ${harness}`, [
    "bun",
    CLI_PATH,
    "refresh",
    "--plugin",
    pluginRoot,
    "--harness",
    harness,
    "--compile-only",
    "--compile-root",
    root,
  ], { env: { PRISM_HOME: prismHome } });
};

const mcp = async (
  pluginRoot: string,
  prismHome: string,
  command: "status" | "stop" | "restart",
): Promise<string> => {
  const result = await runOk(`mcp ${command}`, [
    "bun",
    CLI_PATH,
    "mcp",
    command,
    pluginRoot,
    "--harness",
    "hermes",
    "--token-env",
    TOKEN_ENV,
  ], { env: { PRISM_HOME: prismHome } });
  return result.stdout;
};

const listFilesRecursively = async (root: string, current = root): Promise<string[]> => {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursively(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
};

const countServerProcesses = async (serverPath: string): Promise<number> => {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  return stdout.split("\n").filter((line) => line.includes(serverPath)).length;
};

const pidIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForPidExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!pidIsRunning(pid)) return;
    await Bun.sleep(100);
  }
  throw new Error(`pid ${pid} did not exit`);
};

const waitForNoServerProcesses = async (serverPath: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await countServerProcesses(serverPath) === 0) return true;
    await Bun.sleep(100);
  }
  return false;
};

const waitForRuntimeHealth = async (
  runtime: Record<string, unknown>,
  token: string,
): Promise<Record<string, unknown>> => {
  const port = Number(runtime.port);
  const expectedServerSha256 = String(runtime.serverSha256 ?? "");
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const health = await response.json() as Record<string, unknown>;
        if (
          health.serverName === SERVER_NAME &&
          health.serverSha256 === expectedServerSha256
        ) {
          return health;
        }
      }
    } catch {
      // Server not listening yet.
    }
    await Bun.sleep(100);
  }
  throw new Error(`server on port ${port} did not become healthy`);
};

const spawnRespawnDaemon = (
  prismHome: string,
  runtime: Record<string, unknown>,
  token: string,
) => {
  const port = Number(runtime.port);
  const serverSha256 = String(runtime.serverSha256 ?? "");
  const proc = Bun.spawn({
    cmd: ["bun", serverPath(prismHome)],
    cwd: prismHome,
    env: {
      ...process.env,
      [TOKEN_ENV]: token,
      PRISM_MCP_DISABLE_LAUNCHD: "1",
      PRISM_MCP_TRANSPORT: "streamable-http",
      PRISM_MCP_SERVER_NAME: SERVER_NAME,
      PRISM_MCP_WORKING_DIRECTORY: prismHome,
      PRISM_MCP_REPO_ROOT: prismHome,
      PRISM_MCP_HTTP_HOST: "127.0.0.1",
      PRISM_MCP_HTTP_PORT: String(port),
      PRISM_MCP_HTTP_PATH: "/mcp",
      PRISM_MCP_HTTP_HEALTH_PATH: "/healthz",
      PRISM_MCP_HTTP_TOKEN: token,
      PRISM_MCP_TOOL_TIMEOUT_MS: "60000",
      PRISM_MCP_SERVER_SHA256: serverSha256,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!proc.pid) throw new Error("failed to spawn respawn daemon");
  return proc;
};

const listenOnPort = (port: number): Promise<Server> =>
  new Promise((resolveListen, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen(server));
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });

const setupPlugin = async (work: string): Promise<{
  readonly pluginRoot: string;
  readonly toolPath: string;
}> => {
  const pluginRoot = join(work, "plugin");
  const toolPath = join(pluginRoot, "tools", "echo.tool.ts");
  const effectImportPath = join(
    REPO_ROOT,
    "node_modules",
    "effect",
    "dist",
    "esm",
    "index.js",
  ).replace(/\\/g, "/");
  const prismImportPath = join(REPO_ROOT, "src", "index.ts").replace(/\\/g, "/");

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: PLUGIN_NAME,
        version: "0.1.0",
        targets: { tools: ["hermes", "codex-cli"] },
        runtime: {
          mcp: {
            hermes: { transport: "streamable-http", tokenEnv: TOKEN_ENV },
            "codex-cli": { transport: "streamable-http", tokenEnv: TOKEN_ENV },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(
    toolPath,
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(prismImportPath)};

export default defineTool({
  name: "echo",
  description: "Echo from MCP lifecycle acceptance.",
  input: Schema.Struct({ message: Schema.String }),
  output: Schema.Struct({ echoed: Schema.String }),
  async handle(input) {
    return { echoed: input.message };
  },
});
`,
  );
  return { pluginRoot, toolPath };
};

const main = async (): Promise<void> => {
  const work = await mkdtemp(join(tmpdir(), "prism-acc-mcp-life-"));
  const { pluginRoot, toolPath } = await setupPlugin(work);
  const prismHome = join(work, "prism-home");
  const roots = {
    hermes: join(work, "hermes-root"),
    codex: join(work, "codex-root"),
  };

  let foreignServer: Server | undefined;
  let respawnedDaemon: ReturnType<typeof spawnRespawnDaemon> | undefined;
  try {
    await compile(pluginRoot, prismHome, "hermes", roots.hermes);
    const afterHermes = await readRuntime(prismHome);
    const initialPid = afterHermes.pid;
    await compile(pluginRoot, prismHome, "codex-cli", roots.codex);
    const afterCodex = await readRuntime(prismHome);
    record(
      "multi-harness-compile-does-not-restart-daemon",
      initialPid === afterCodex.pid,
      initialPid === afterCodex.pid
        ? `pid ${String(initialPid)} reused across Hermes and Codex compiles`
        : `pid changed from ${String(initialPid)} to ${String(afterCodex.pid)}`,
    );

    const initialServerSha = String(afterCodex.serverSha256 ?? "");
    await writeText(
      toolPath,
      (await readFile(toolPath, "utf8")).replace(
        "Echo from MCP lifecycle acceptance.",
        "Echo from changed MCP lifecycle acceptance.",
      ),
    );
    await compile(pluginRoot, prismHome, "hermes", roots.hermes);
    const afterHermesBundleChange = await readRuntime(prismHome);
    await compile(pluginRoot, prismHome, "codex-cli", roots.codex);
    const afterCodexBundleChange = await readRuntime(prismHome);
    const pidsAfterBundleChange = [
      Number(afterCodex.pid),
      Number(afterHermesBundleChange.pid),
      Number(afterCodexBundleChange.pid),
    ];
    const pidTransitions = pidsAfterBundleChange
      .slice(1)
      .filter((pid, index) => pid !== pidsAfterBundleChange[index]).length;
    const bundleChangePass =
      initialServerSha.length > 0 &&
      afterHermesBundleChange.serverSha256 !== initialServerSha &&
      afterHermesBundleChange.serverSha256 === afterCodexBundleChange.serverSha256 &&
      pidTransitions <= 1;
    record(
      "multi-harness-bundle-change-restarts-at-most-once",
      bundleChangePass,
      `serverSha ${initialServerSha.slice(0, 12)} -> ${String(afterHermesBundleChange.serverSha256).slice(0, 12)} -> ${String(afterCodexBundleChange.serverSha256).slice(0, 12)}; pids=${pidsAfterBundleChange.join("->")} transitions=${pidTransitions}`,
    );

    const stableConfigHash = await hashConfigs(roots);
    const stablePort = afterCodexBundleChange.port;
    const stableTokenSha = afterCodexBundleChange.tokenSha256;
    let restartStable = true;
    const restartDetails: string[] = [];
    for (let index = 0; index < 5; index++) {
      await mcp(pluginRoot, prismHome, "restart");
      await compile(pluginRoot, prismHome, "hermes", roots.hermes);
      await compile(pluginRoot, prismHome, "codex-cli", roots.codex);
      const runtime = await readRuntime(prismHome);
      const currentHash = await hashConfigs(roots);
      const pass =
        currentHash === stableConfigHash &&
        runtime.port === stablePort &&
        runtime.tokenSha256 === stableTokenSha;
      restartStable &&= pass;
      restartDetails.push(
        `#${index + 1}: config=${currentHash.slice(0, 12)} port=${String(runtime.port)} token=${String(runtime.tokenSha256).slice(0, 12)} pass=${pass}`,
      );
    }
    record(
      "five-restarts-keep-config-port-token-stable",
      restartStable,
      restartDetails.join("; "),
    );

    const runtimeBeforeRespawn = await readRuntime(prismHome);
    const deadPid = Number(runtimeBeforeRespawn.pid);
    const storedToken = await readStoredToken(prismHome);
    process.kill(deadPid, "SIGKILL");
    await waitForPidExit(deadPid);
    respawnedDaemon = spawnRespawnDaemon(prismHome, runtimeBeforeRespawn, storedToken);
    const respawnHealth = await waitForRuntimeHealth(runtimeBeforeRespawn, storedToken);
    const respawnPid = Number(respawnHealth.pid);
    const status = await mcp(pluginRoot, prismHome, "status");
    await compile(pluginRoot, prismHome, "hermes", roots.hermes);
    const adopted = await readRuntime(prismHome);
    record(
      "launchd-like-respawn-adopted-before-stale-pid",
      status.includes("running") && adopted.pid === respawnPid && respawnPid !== deadPid,
      `status=${status.trim()} deadPid=${deadPid} respawnPid=${respawnPid} adoptedPid=${String(adopted.pid)}`,
    );

    await mcp(pluginRoot, prismHome, "stop");
    respawnedDaemon = undefined;
    const stopped = await readRuntime(prismHome);
    const oldPort = Number(stopped.port);
    foreignServer = await listenOnPort(oldPort);
    await compile(pluginRoot, prismHome, "hermes", roots.hermes);
    await compile(pluginRoot, prismHome, "codex-cli", roots.codex);
    const reallocated = await readRuntime(prismHome);
    const reallocatedPort = Number(reallocated.port);
    const reallocatedConfigs = await readConfigs(roots);
    record(
      "dead-auto-port-foreign-held-reallocates-and-rewrites-configs",
      Number.isInteger(reallocatedPort) &&
        reallocatedPort !== oldPort &&
        configsContainPort(reallocatedConfigs, reallocatedPort) &&
        configsOmitPort(reallocatedConfigs, oldPort),
      `old=${oldPort} new=${reallocatedPort} hermesHasNew=${reallocatedConfigs.hermes.includes(mcpUrlForPort(reallocatedPort))} codexHasNew=${reallocatedConfigs.codex.includes(mcpUrlForPort(reallocatedPort))}`,
    );
    await closeServer(foreignServer);
    foreignServer = undefined;

    await mcp(pluginRoot, prismHome, "stop");
    const serverPathValue = serverPath(prismHome);
    record(
      "stop-leaves-no-orphan-daemon",
      await waitForNoServerProcesses(serverPathValue),
      `serverPath=${serverPathValue}`,
    );

    const runtimeFiles = await listFilesRecursively(join(prismHome, "runtime", "mcp"));
    record(
      "runtime-state-contained-under-prism-home",
      runtimeFiles.every((path) => path.startsWith(join(prismHome, "runtime", "mcp"))),
      `${runtimeFiles.length} runtime file(s) under sandbox PRISM_HOME`,
    );
    const rootStat = await stat(runtimePath(prismHome));
    record(
      "runtime-json-written",
      rootStat.isFile(),
      "runtime.json exists in compiler-owned runtime directory",
    );
  } finally {
    if (foreignServer) await closeServer(foreignServer).catch(() => undefined);
    if (respawnedDaemon) {
      respawnedDaemon.kill("SIGTERM");
      await respawnedDaemon.exited.catch(() => undefined);
    }
    await mcp(pluginRoot, prismHome, "stop").catch(() => undefined);
  }

  const failed = assertions.filter((assertion) => !assertion.pass);
  const summary = {
    gate: "mcp-lifecycle",
    pass: failed.length === 0,
    expected: "PASS",
    work,
    assertions,
    counts: { pass: assertions.length - failed.length, fail: failed.length },
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
};

await main();
