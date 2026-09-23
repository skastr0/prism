import { describe, expect, test } from "bun:test";
import {
  AMP_RUNNERS_PROMPT,
  ampRunnerIds,
  ampRunnerServedDirs,
  parseAmpRunnersStreamJson,
  validateAmpRunnerTarget,
  type DiscoveredAmpRunners,
} from "./amp-runners.js";

// Shape of the list_runners tool result (amp 0.0.1790121694-g18bb0a, 2026-09-23).
const runnerRow = (runnerId: string, dirs: readonly string[], overrides: Record<string, unknown> = {}) => ({
  runnerId,
  name: runnerId,
  hostname: `host-${runnerId}`,
  workingDirectory: "/srv",
  repositoryURL: null,
  lastSeenAt: "2026-09-23T01:38:38.489Z",
  runningThreads: [],
  obelisk: false,
  serveCwd: true,
  isCurrent: false,
  capabilities: ["runner", "any-directory", "create-worktree"],
  directories: dirs.map((path) => ({
    path,
    repositoryURL: path === "/srv/junto" ? "https://github.com/acme/junto.git" : null,
    canCreateWorktree: path !== "/srv",
  })),
  ...overrides,
});

const payload = (runners: readonly unknown[]): string => JSON.stringify({ runners });

/** A stream-json transcript whose code_exec tool_result carries the raw list_runners JSON. */
const transcript = (resultContent: string, sessionId = "T-abc"): string =>
  [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, cwd: "/x", tools: ["code_exec"] }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: AMP_RUNNERS_PROMPT }] } }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "TU-1", name: "code_exec", input: { code: "…" } }] },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "TU-1", content: resultContent }] },
    }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "2 runners, macbook and mac-mini" }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "2 runners", session_id: sessionId }),
  ].join("\n") + "\n";

const TOOL_RESULT_JSON = JSON.stringify([{ type: "text", text: payload([runnerRow("mac-mini", []), runnerRow("macbook", ["/srv/prism", "/srv", "/srv/junto"])]) }]);

describe("parseAmpRunnersStreamJson", () => {
  test("parses the list_runners tool result, not the assistant echo", () => {
    const parsed = parseAmpRunnersStreamJson(transcript(TOOL_RESULT_JSON));
    expect(parsed.error).toBeUndefined();
    expect(parsed.sessionId).toBe("T-abc");
    expect(ampRunnerIds({ runners: parsed.runners, source: "command" })).toEqual(["mac-mini", "macbook"]);
    const [macMini, macbook] = parsed.runners;
    expect(macbook?.name).toBe("macbook");
    expect(macbook?.hostname).toBe("host-macbook");
    expect(macbook?.lastSeenAt).toBe("2026-09-23T01:38:38.489Z");
    expect(macbook?.capabilities).toEqual(["runner", "any-directory", "create-worktree"]);
    expect(ampRunnerServedDirs(macbook!)).toEqual(["/srv", "/srv/junto", "/srv/prism"]);
    expect(macbook?.directories.find((directory) => directory.path === "/srv/junto")?.repositoryURL).toBe("https://github.com/acme/junto.git");
    expect(macbook?.directories.find((directory) => directory.path === "/srv")?.canCreateWorktree).toBe(false);
    expect(macMini?.directories).toEqual([]);
  });

  test("accepts a bare payload string and a bare runner array", () => {
    expect(parseAmpRunnersStreamJson(transcript(payload([runnerRow("macbook", [])]))).runners.map((runner) => runner.runnerId))
      .toEqual(["macbook"]);
    expect(parseAmpRunnersStreamJson(transcript(JSON.stringify([runnerRow("macbook", [])]))).runners.map((runner) => runner.runnerId))
      .toEqual(["macbook"]);
  });

  test("dedupes runnerIds, keeps sorted order, and reports skipped blank rows", () => {
    const parsed = parseAmpRunnersStreamJson(transcript(payload([
      runnerRow("macbook", ["/b"]),
      runnerRow("macbook", ["/a"]),
      runnerRow("   ", ["/x"]),
    ])));
    expect(ampRunnerServedDirs(parsed.runners[0]!)).toEqual(["/a"]);
    expect(parsed.error).toBe("skipped 1 runner row(s) with a blank runnerId");
  });

  test("fails closed on rows missing required fields (required fields fail closed, extras ignored)", () => {
    const missingDirs = parseAmpRunnersStreamJson(transcript(payload([
      runnerRow("macbook", [], { directories: undefined }),
      runnerRow("macbook", ["/a"]),
    ])));
    expect(missingDirs.runners).toEqual([]);
    expect(missingDirs.error).toContain("directories");

    const noLastSeen = parseAmpRunnersStreamJson(transcript(payload([{ runnerId: "macbook", directories: [] }])));
    expect(noLastSeen.runners).toEqual([]);
    expect(noLastSeen.error).toContain("lastSeenAt");
  });

  test("ignores the assistant echo and prose tool results", () => {
    const echoOnly = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "T-abc" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: payload([runnerRow("macbook", [])]) }] } }),
    ].join("\n");
    expect(parseAmpRunnersStreamJson(echoOnly).error).toContain("no list_runners tool result found");

    const prose = transcript(JSON.stringify([{ type: "text", text: "There are 2 runners." }]));
    expect(parseAmpRunnersStreamJson(prose).error).toContain("no list_runners tool result found");
  });

  test("fails soft on empty output, the turn-error sentinel, and non-JSONL garbage", () => {
    expect(parseAmpRunnersStreamJson("").error).toBe("amp -x --stream-json produced no output");
    expect(parseAmpRunnersStreamJson("AMP_TURN_ERROR: Command failed: amp -x (exit 1): not logged in").error)
      .toBe("Command failed: amp -x (exit 1): not logged in");
    expect(parseAmpRunnersStreamJson("Error: not logged in\n").error).toContain("no list_runners tool result found");
  });

  test("a sentinel with an appended partial transcript reports only the reason line", () => {
    const partial = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "T-leak", cwd: "/x" }),
    ].join("\n");
    const parsed = parseAmpRunnersStreamJson(`AMP_TURN_ERROR: amp -x timed out after 180s\n${partial}`);
    expect(parsed.error).toBe("amp -x timed out after 180s");
    expect(parsed.error).not.toContain("session_id");
    expect(parsed.sessionId).toBe("T-leak");
  });
});

const discovered = (): DiscoveredAmpRunners => ({
  source: "command",
  capturedAt: "2026-09-23T02:00:00.000Z",
  runners: [
    { runnerId: "macbook", name: "macbook", hostname: "MacBookPro", workingDirectory: "/Users/me/Projects", lastSeenAt: "2026-09-23T01:38:38.489Z", capabilities: ["runner"], directories: [{ path: "/srv/prism" }, { path: "/srv/" }] },
    { runnerId: "mac-mini", name: "mac-mini", hostname: "macmini.local", lastSeenAt: "2026-09-23T01:38:00.000Z", capabilities: ["runner"], directories: [] },
  ],
});

describe("validateAmpRunnerTarget", () => {
  test("falls back to strings without a snapshot or runners", () => {
    expect(validateAmpRunnerTarget("anything", "/anywhere", undefined)).toBeUndefined();
    expect(validateAmpRunnerTarget("anything", "/anywhere", { runners: [], source: "empty", error: "boom" })).toBeUndefined();
  });

  test("fails closed on an unknown runnerId, listing known runners and the refresh command", () => {
    const error = validateAmpRunnerTarget("build-box", undefined, discovered());
    expect(error).toContain('Unknown Amp runner "build-box"');
    expect(error).toContain("mac-mini (macmini.local), macbook (MacBookPro)");
    expect(error).toContain("prism workflow refresh-harness-types --discover-amp-runners");
    // Amp runner ids are exact: a differently-cased id fails with the exact id.
    const cased = validateAmpRunnerTarget("MacBook", undefined, discovered());
    expect(cased).toContain('Unknown Amp runner "MacBook"');
    expect(cased).toContain('Did you mean "macbook"?');
  });

  test("validates the (runnerId, runnerDir) pair against that runner's served directories", () => {
    expect(validateAmpRunnerTarget("macbook", "/srv/prism", discovered())).toBeUndefined();
    expect(validateAmpRunnerTarget("macbook", "/srv/", discovered())).toBeUndefined();
    const error = validateAmpRunnerTarget("macbook", "/Users/me/Projects", discovered());
    expect(error).toContain('Amp runner "macbook" does not serve "/Users/me/Projects"');
    expect(error).toContain("Served directories: /srv, /srv/prism");
    expect(error).toContain('omit runnerDir to use it');
    expect(validateAmpRunnerTarget("macbook", undefined, discovered())).toBeUndefined();
    const dirless = validateAmpRunnerTarget("mac-mini", "/srv/prism", discovered());
    expect(dirless).toContain('does not serve "/srv/prism"');
    expect(dirless).toContain("Served directories: (none)");
  });
});
