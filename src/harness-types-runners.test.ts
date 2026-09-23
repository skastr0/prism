import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAmpRunners,
  previousAmpRunners,
  refreshHarnessTypes,
  renderHarnessTypesRefreshHuman,
} from "./harness-types-discover.js";
import { parseAmpRunnersStreamJson } from "./amp-runners.js";
import { writeHarnessTypesSnapshot } from "./harness-types.js";

/** A stream-json transcript whose code_exec tool_result carries the raw list_runners JSON. */
const transcript = (resultContent: string): string =>
  [
    JSON.stringify({ type: "system", subtype: "init", session_id: "T-live", cwd: "/x" }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "TU-1", content: resultContent }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "T-live" }),
  ].join("\n") + "\n";

const runnerRow = (runnerId: string, dirs: readonly string[]): unknown => ({
  runnerId,
  name: runnerId,
  hostname: `host-${runnerId}`,
  lastSeenAt: "2026-09-23T01:38:38.489Z",
  capabilities: ["runner"],
  directories: dirs.map((path) => ({ path, repositoryURL: null, canCreateWorktree: true })),
});

describe("discoverAmpRunners", () => {
  test("parses a one-shot turn transcript into a command source", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const discovered = await discoverAmpRunners({
      runCommand: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "-x") {
          expect(args[1]).toContain("list_runners");
          expect(args).toContain("--stream-json");
          expect(args).toContain("low");
          return transcript(JSON.stringify({ runners: [runnerRow("macbook", ["/srv/prism", "/srv/prism/"]), runnerRow("mac-mini", [])] }));
        }
        return "ok\n";
      },
    });
    expect(calls[0]?.args.slice(0, 2)).toEqual(["-x", expect.any(String)]);
    expect(calls[1]?.args).toEqual(["threads", "delete", "T-live"]);
    expect(discovered.source).toBe("command");
    expect(discovered.capturedAt).toBeDefined();
    expect(discovered.runners.map((runner) => runner.runnerId)).toEqual(["mac-mini", "macbook"]);
    // Trailing slash is normalized once, at snapshot time.
    expect(discovered.runners[1]?.directories.map((directory) => directory.path)).toEqual(["/srv/prism"]);
  });

  test("fails soft when the turn errors, with the reason and no thread deletion", async () => {
    const discovered = await discoverAmpRunners({
      runCommand: async () => "AMP_TURN_ERROR: Command failed: amp -x (exit 1): not logged in",
    });
    expect(discovered.source).toBe("empty");
    expect(discovered.runners).toEqual([]);
    expect(discovered.error).toBe("Command failed: amp -x (exit 1): not logged in");
  });
});

describe("refresh harness-types runner preservation", () => {
  const writeRunners = async (prismHome: string): Promise<void> => {
    writeHarnessTypesSnapshot(prismHome, {
      generatedAt: "2026-09-22T00:00:00.000Z",
      harnesses: [],
      ampRunners: {
        source: "command",
        capturedAt: "2026-09-22T01:00:00.000Z",
        runners: [runnerRow("macbook", ["/srv/prism"]) as never],
      },
    });
  };

  test("a plain refresh preserves the previously captured runner snapshot", async () => {
    const prismHome = await mkdtemp(join(tmpdir(), "prism-runners-preserve-"));
    await writeRunners(prismHome);
    const result = await refreshHarnessTypes(prismHome, {
      home: join(prismHome, "home"),
      runCommand: async () => "",
      readText: () => undefined,
    });
    expect(result.snapshot.ampRunners?.runners.map((runner) => runner.runnerId)).toEqual(["macbook"]);
    expect(result.snapshot.ampRunners?.capturedAt).toBe("2026-09-22T01:00:00.000Z");
    const source = await readFile(result.modelsPath, "utf8");
    expect(source).toContain("ampRunnerIds");
    expect(source).toContain('"/srv/prism"');
  });

  test("without a previous snapshot and without the flag there is no ampRunners key", async () => {
    const prismHome = await mkdtemp(join(tmpdir(), "prism-runners-none-"));
    const result = await refreshHarnessTypes(prismHome, {
      home: join(prismHome, "home"),
      runCommand: async () => "",
      readText: () => undefined,
    });
    expect(result.snapshot.ampRunners).toBeUndefined();
    expect(previousAmpRunners(prismHome)).toBeUndefined();
  });

  test("--discover-amp-runners replaces the snapshot and reports runners in the human output", async () => {
    const prismHome = await mkdtemp(join(tmpdir(), "prism-runners-refresh-"));
    await writeRunners(prismHome);
    const result = await refreshHarnessTypes(prismHome, {
      home: join(prismHome, "home"),
      runCommand: async (command, args) =>
        command === "amp" && args[0] === "-x"
          ? transcript(JSON.stringify({ runners: [runnerRow("macbook", ["/srv/prism"]), runnerRow("build-box", ["/work/a", "/work/b"])] }))
          : "ok\n",
      readText: () => undefined,
      discoverAmpRunners: true,
    });
    expect(result.snapshot.ampRunners?.runners.map((runner) => runner.runnerId)).toEqual(["build-box", "macbook"]);
    const source = await readFile(result.modelsPath, "utf8");
    expect(source).toContain('"build-box"');
    expect(source).toContain('"/work/a" | "/work/b"');
    const human = renderHarnessTypesRefreshHuman(result);
    expect(human).toContain("amp-runner: 2 runners, 3 served dirs (command)");
  });

  test("a failed live capture keeps the previously captured runners", async () => {
    const prismHome = await mkdtemp(join(tmpdir(), "prism-runners-keep-"));
    await writeRunners(prismHome);
    const result = await refreshHarnessTypes(prismHome, {
      home: join(prismHome, "home"),
      runCommand: async (command, args) =>
        command === "amp" && args[0] === "-x" ? "AMP_TURN_ERROR: offline" : "ok\n",
      readText: () => undefined,
      discoverAmpRunners: true,
    });
    expect(result.snapshot.ampRunners?.runners.map((runner) => runner.runnerId)).toEqual(["macbook"]);
    expect(result.snapshot.ampRunners?.error).toBeUndefined();
  });

  test("a successful empty capture replaces the previous snapshot (no live runners left)", async () => {
    const prismHome = await mkdtemp(join(tmpdir(), "prism-runners-empty-"));
    await writeRunners(prismHome);
    const result = await refreshHarnessTypes(prismHome, {
      home: join(prismHome, "home"),
      runCommand: async (command, args) =>
        command === "amp" && args[0] === "-x"
          ? transcript(JSON.stringify({ runners: [] }))
          : "ok\n",
      readText: () => undefined,
      discoverAmpRunners: true,
    });
    expect(result.snapshot.ampRunners?.runners).toEqual([]);
    expect(result.snapshot.ampRunners?.source).toBe("empty");
  });
});

describe("amp -x --stream-json transcript shape", () => {
  test("the parser reads the tool result from a 'user' event, not from assistant text", () => {
    const assistantEcho = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ runners: [runnerRow("echo", ["/x"])] }) }] },
    });
    const parsed = parseAmpRunnersStreamJson(`${transcript(JSON.stringify({ runners: [runnerRow("macbook", ["/srv/prism"])] }))}\n${assistantEcho}`);
    expect(parsed.runners.map((runner) => runner.runnerId)).toEqual(["macbook"]);
  });
});
