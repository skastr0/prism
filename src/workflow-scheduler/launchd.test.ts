import { describe, expect, test } from "bun:test";
import {
  installSchedulerService,
  renderSchedulerLaunchAgent,
  schedulerServiceLabel,
  schedulerServicePlistPath,
  SCHEDULER_SERVICE_PREFLIGHT,
  uninstallSchedulerService,
  type LaunchctlInvocation,
  type SchedulerLaunchAgentInput,
  type SchedulerServiceDeps,
} from "./launchd.js";

const input = (overrides: Partial<SchedulerLaunchAgentInput> = {}): SchedulerLaunchAgentInput => ({
  label: schedulerServiceLabel("/Users/ada/.prism"),
  prismCommand: ["/opt/prism/bin/prism"],
  prismHome: "/Users/ada/.prism",
  stdoutPath: "/Users/ada/.prism/logs/workflow-scheduler.out.log",
  stderrPath: "/Users/ada/.prism/logs/workflow-scheduler.err.log",
  pathEnv: "/opt/prism/bin:/usr/bin:/bin",
  ...overrides,
});

interface FakeLaunchctl {
  readonly deps: SchedulerServiceDeps;
  readonly calls: Array<ReadonlyArray<string>>;
  readonly files: Map<string, string>;
  readonly directories: string[];
}

const createDeps = (options: {
  readonly platform?: NodeJS.Platform;
  readonly existingPlist?: string | null;
  readonly exitCodes?: ReadonlyArray<number>;
  readonly stderr?: string;
} = {}): FakeLaunchctl => {
  const calls: Array<ReadonlyArray<string>> = [];
  const files = new Map<string, string>();
  const directories: string[] = [];
  const plistPath = schedulerServicePlistPath("/Users/ada", input().label);
  if (options.existingPlist != null) files.set(plistPath, options.existingPlist);

  let call = 0;
  return {
    calls,
    files,
    directories,
    deps: {
      platform: options.platform ?? "darwin",
      homeDir: "/Users/ada",
      uid: 501,
      runLaunchctl: async (args): Promise<LaunchctlInvocation> => {
        calls.push(args);
        const exitCode = options.exitCodes?.[call] ?? 0;
        call += 1;
        return { exitCode, stdout: "", stderr: options.stderr ?? "" };
      },
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async (path, contents) => {
        files.set(path, contents);
      },
      removeFile: async (path) => {
        files.delete(path);
      },
      mkdirp: async (path) => {
        directories.push(path);
      },
    },
  };
};

describe("launch agent rendering", () => {
  test("label is derived from the Prism home so two homes never collide", () => {
    expect(schedulerServiceLabel("/a/.prism")).toBe(schedulerServiceLabel("/a/.prism"));
    expect(schedulerServiceLabel("/a/.prism")).not.toBe(schedulerServiceLabel("/b/.prism"));
    expect(schedulerServiceLabel("/a/.prism")).toStartWith("com.prism.workflow-scheduler.");
  });

  test("runs the scheduler through a preflight launcher, not an interpolated command", () => {
    const plist = renderSchedulerLaunchAgent(input());
    // The launcher is /bin/sh, so it cannot live in a deletable bundle.
    expect(plist).toContain("<string>/bin/sh</string>");
    expect(plist).toContain("<string>-c</string>");
    // The preflight is a plist value, so its quotes are XML-escaped in place.
    expect(plist).toContain("if [ ! -x &quot;$1&quot; ]");
    expect(plist).toContain("exec &quot;$@&quot;");
    expect(SCHEDULER_SERVICE_PREFLIGHT).toContain("exit 0");
    // The real command is positional, never spliced into shell source.
    expect(plist).toContain("<string>/opt/prism/bin/prism</string>");
    expect(plist).toContain("<string>workflow</string>");
    expect(plist).toContain("<string>scheduler</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).not.toContain("/opt/prism/bin/prism workflow");
  });

  test("the preflight stands down rather than respawning into a missing install", () => {
    // A missing installation must exit 0: with SuccessfulExit:false that is a
    // stand-down, and a nonzero exit would respawn forever.
    expect(SCHEDULER_SERVICE_PREFLIGHT).toContain("exit 0");
    const plist = renderSchedulerLaunchAgent(input());
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
  });

  test("carries PRISM_HOME and PATH, because a LaunchAgent inherits no shell", () => {
    const plist = renderSchedulerLaunchAgent(input());
    expect(plist).toContain("<key>PRISM_HOME</key>");
    expect(plist).toContain("<string>/Users/ada/.prism</string>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/opt/prism/bin:/usr/bin:/bin</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
  });

  test("puts no schedule and no resource limits in the plist", () => {
    const plist = renderSchedulerLaunchAgent(input());
    // Prism owns the clock; a second authority for the same fact is a bug.
    expect(plist).not.toContain("StartCalendarInterval");
    expect(plist).not.toContain("StartInterval");
    // And scheduling introduces no cap on a workflow's runtime or spend.
    expect(plist).not.toContain("HardResourceLimits");
    expect(plist).not.toContain("ProcessType");
  });

  test("escapes XML metacharacters in every value", () => {
    const plist = renderSchedulerLaunchAgent(input({
      prismHome: "/Users/ada/.prism & <co>",
      stdoutPath: "/tmp/a&b<c>.log",
    }));
    expect(plist).toContain("&amp;");
    expect(plist).toContain("&lt;co&gt;");
    expect(plist).not.toContain("<co>");
  });
});

describe("service lifecycle", () => {
  test("installs, bootstraps the exact gui service, and creates the log directory", async () => {
    const fake = createDeps();
    const result = await installSchedulerService(fake.deps, input());

    expect(result.kind).toBe("installed");
    expect(fake.calls).toEqual([
      ["bootout", `gui/501/${input().label}`],
      ["bootstrap", "gui/501", schedulerServicePlistPath("/Users/ada", input().label)],
    ]);
    expect(fake.directories).toContain("/Users/ada/.prism/logs");
    expect(fake.files.get(schedulerServicePlistPath("/Users/ada", input().label))).toContain(input().label);
  });

  test("refuses to overwrite a plist Prism did not write", async () => {
    const fake = createDeps({ existingPlist: "<plist>someone else's agent</plist>" });
    const result = await installSchedulerService(fake.deps, input());
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" ? result.reason : "").toContain("not written by Prism");
    expect(fake.calls).toEqual([]);
  });

  test("reinstalls over its own plist", async () => {
    const fake = createDeps({ existingPlist: renderSchedulerLaunchAgent(input()) });
    const result = await installSchedulerService(fake.deps, input());
    expect(result.kind).toBe("installed");
    expect(result.kind === "installed" ? result.changed : true).toBe(false);
  });

  test("reports a failed bootstrap instead of claiming success", async () => {
    const fake = createDeps({ exitCodes: [0, 5], stderr: "Bootstrap failed: 5: Input/output error" });
    const result = await installSchedulerService(fake.deps, input());
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" ? result.reason : "").toContain("Bootstrap failed");
  });

  test("uninstall boots out and removes its own plist, tolerating an absent service", async () => {
    const fake = createDeps({ existingPlist: renderSchedulerLaunchAgent(input()), exitCodes: [3], stderr: "Could not find service" });
    const result = await uninstallSchedulerService(fake.deps, input().label);
    expect(result.kind).toBe("uninstalled");
    expect(fake.files.has(schedulerServicePlistPath("/Users/ada", input().label))).toBe(false);
  });

  test("uninstall leaves a foreign plist alone and reports a real bootout failure", async () => {
    const foreign = createDeps({ existingPlist: "<plist>not ours</plist>" });
    await uninstallSchedulerService(foreign.deps, input().label);
    expect(foreign.files.has(schedulerServicePlistPath("/Users/ada", input().label))).toBe(true);

    const failing = createDeps({ exitCodes: [1], stderr: "Operation not permitted" });
    const result = await uninstallSchedulerService(failing.deps, input().label);
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" ? result.reason : "").toContain("Operation not permitted");
  });

  test("fails closed on a host without launchd instead of pretending", async () => {
    const fake = createDeps({ platform: "linux" });
    const install = await installSchedulerService(fake.deps, input());
    expect(install.kind).toBe("unsupported");
    expect(install.kind === "unsupported" ? install.reason : "").toContain("macOS only");
    expect(install.kind === "unsupported" ? install.hint : "").toContain("--once");
    expect(fake.calls).toEqual([]);

    expect((await uninstallSchedulerService(fake.deps, input().label)).kind).toBe("unsupported");
  });
});
