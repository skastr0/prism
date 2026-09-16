/**
 * LaunchAgent management for the scheduler.
 *
 * The split this file implements is the one the design settled on: **launchd
 * owns the process, Prism owns the schedules.** launchd starts one scheduler at
 * login and restarts it if it dies; Prism decides what is due. Prism never
 * registers a LaunchAgent per workflow, because a schedule is data, not a
 * process, and one service watching one catalog is what makes the instance lock
 * meaningful.
 *
 * Two failure modes are designed against, both drawn from the repo's own
 * `src/doctor/launchd-residue.ts` (OBS-002), which exists because a retired
 * Prism service once respawned forever against a deleted bundle:
 *
 *   1. **The launcher must not live in a deletable bundle.** `ProgramArguments`
 *      invokes `/bin/sh` with the real command passed as positional arguments —
 *      never interpolated into shell source — and a preflight that checks the
 *      executable before `exec`. A missing installation produces one diagnostic
 *      and exits **0**, which with `KeepAlive: { SuccessfulExit: false }` tells
 *      launchd to stand down rather than respawn into the same failure.
 *   2. **Prism must not overwrite a file it does not own.** The plist is only
 *      written when absent or when it is recognizably ours, and the install
 *      records what it created so `uninstall` removes exactly that.
 *
 * A LaunchAgent runs as the logged-in user but does **not** inherit an
 * interactive shell's environment. `PRISM_HOME` and `PATH` are therefore written
 * into the plist explicitly, and credentials are not: the plist is world-readable
 * by default and secrets belong in the harness's own credential store.
 *
 * `launchctl` and the filesystem are injected, so the lifecycle is testable on a
 * host without launchd. The macOS-specific end-to-end path — a real
 * `launchctl bootstrap` and a real respawn — cannot be verified in a Linux orb
 * and is called out as such rather than assumed.
 */

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export const SCHEDULER_SERVICE_PREFLIGHT = `if [ ! -x "$1" ]; then
  echo "prism workflow scheduler: $1 is not executable; reinstall Prism or run 'prism workflow scheduler serve' by hand" >&2
  exit 0
fi
exec "$@"`;

/** A label unique to one Prism home, so two homes never fight over one service. */
export const schedulerServiceLabel = (prismHome: string): string =>
  `com.prism.workflow-scheduler.${createHash("sha256").update(prismHome).digest("hex").slice(0, 12)}`;

export const schedulerServicePlistPath = (homeDir: string, label: string): string =>
  join(homeDir, "Library", "LaunchAgents", `${label}.plist`);

export const schedulerServiceLogPath = (prismHome: string, stream: "out" | "err"): string =>
  join(prismHome, "logs", `workflow-scheduler.${stream}.log`);

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export interface SchedulerLaunchAgentInput {
  readonly label: string;
  /** The Prism invocation, already resolved: `[binary]` or `[bun, run, cli.ts]`. */
  readonly prismCommand: ReadonlyArray<string>;
  readonly prismHome: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /** The `PATH` the scheduler should see, since a LaunchAgent inherits none. */
  readonly pathEnv: string;
  readonly throttleSeconds?: number;
}

/**
 * Render the LaunchAgent.
 *
 * No `StartCalendarInterval`: Prism owns the clock, and putting the schedule in
 * both places would give two authorities for the same fact. No resource limits:
 * scheduling introduces no cap on a workflow's runtime, output, or cost.
 */
export const renderSchedulerLaunchAgent = (input: SchedulerLaunchAgentInput): string => {
  const throttle = input.throttleSeconds ?? 30;
  const argumentsXml = [
    "/bin/sh",
    "-c",
    SCHEDULER_SERVICE_PREFLIGHT,
    "prism-workflow-scheduler",
    ...input.prismCommand,
    "workflow",
    "scheduler",
    "serve",
  ]
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <!--
    SuccessfulExit: false restarts only on an unsuccessful exit, so the
    preflight's deliberate exit 0 for a missing installation is a stand-down
    rather than a respawn loop. Do not add PathState expecting an AND: launchd
    ORs KeepAlive conditions.
  -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${throttle}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(input.stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRISM_HOME</key>
    <string>${escapeXml(input.prismHome)}</string>
    <key>PATH</key>
    <string>${escapeXml(input.pathEnv)}</string>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
</dict>
</plist>
`;
};

export interface LaunchctlInvocation {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SchedulerServiceDeps {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly uid: number;
  readonly runLaunchctl: (args: ReadonlyArray<string>) => Promise<LaunchctlInvocation>;
  readonly readFile: (path: string) => Promise<string | null>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly mkdirp: (path: string) => Promise<void>;
}

export type SchedulerServiceResult =
  | { readonly kind: "installed"; readonly label: string; readonly plistPath: string; readonly changed: boolean }
  | { readonly kind: "uninstalled"; readonly label: string; readonly plistPath: string }
  | { readonly kind: "unsupported"; readonly reason: string; readonly hint: string }
  | { readonly kind: "blocked"; readonly reason: string; readonly hint: string };

const unsupportedPlatform = (platform: NodeJS.Platform): SchedulerServiceResult => ({
  kind: "unsupported",
  reason: `Prism manages a LaunchAgent on macOS only; this host is '${platform}'`,
  hint: "run `prism workflow scheduler serve` under whatever supervises your processes, or use `prism workflow scheduler serve --once` from a cron entry",
});

/** Ours if it carries our label; anything else is not ours to replace. */
const plistLooksOurs = (contents: string, label: string): boolean => contents.includes(label);

export const installSchedulerService = async (
  deps: SchedulerServiceDeps,
  input: SchedulerLaunchAgentInput,
): Promise<SchedulerServiceResult> => {
  if (deps.platform !== "darwin") return unsupportedPlatform(deps.platform);

  const plistPath = schedulerServicePlistPath(deps.homeDir, input.label);
  const existing = await deps.readFile(plistPath);
  if (existing !== null && !plistLooksOurs(existing, input.label)) {
    return {
      kind: "blocked",
      reason: `${plistPath} already exists and was not written by Prism`,
      hint: "move it aside, or choose a different PRISM_HOME so the label differs",
    };
  }

  await deps.mkdirp(dirname(input.stdoutPath));
  await deps.mkdirp(dirname(plistPath));
  await deps.writeFile(plistPath, renderSchedulerLaunchAgent(input));

  // Boot out first so a re-install replaces the loaded definition rather than
  // leaving the previous arguments resident. An absent service is not an error.
  await deps.runLaunchctl(["bootout", `gui/${deps.uid}/${input.label}`]);
  const bootstrap = await deps.runLaunchctl(["bootstrap", `gui/${deps.uid}`, plistPath]);
  if (bootstrap.exitCode !== 0) {
    return {
      kind: "blocked",
      reason: `launchctl bootstrap failed for ${input.label}: ${bootstrap.stderr.trim() || `exit ${bootstrap.exitCode}`}`,
      hint: `check that ${plistPath} is valid, or run 'launchctl bootstrap gui/${deps.uid} ${plistPath}' by hand`,
    };
  }
  return { kind: "installed", label: input.label, plistPath, changed: existing === null };
};

export const uninstallSchedulerService = async (
  deps: Pick<SchedulerServiceDeps, "platform" | "homeDir" | "uid" | "runLaunchctl" | "readFile" | "removeFile">,
  label: string,
): Promise<SchedulerServiceResult> => {
  if (deps.platform !== "darwin") return unsupportedPlatform(deps.platform);
  const plistPath = schedulerServicePlistPath(deps.homeDir, label);

  const bootout = await deps.runLaunchctl(["bootout", `gui/${deps.uid}/${label}`]);
  // "Not loaded" is the desired state, not a failure. Anything else is real.
  if (bootout.exitCode !== 0 && !/not find|no such|Could not find/i.test(bootout.stderr)) {
    return {
      kind: "blocked",
      reason: `launchctl bootout failed for ${label}: ${bootout.stderr.trim() || `exit ${bootout.exitCode}`}`,
      hint: `run 'launchctl bootout gui/${deps.uid}/${label}' by hand to see why`,
    };
  }

  const existing = await deps.readFile(plistPath);
  if (existing !== null && plistLooksOurs(existing, label)) {
    await deps.removeFile(plistPath);
  }
  return { kind: "uninstalled", label, plistPath };
};
