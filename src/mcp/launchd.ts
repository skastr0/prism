import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LaunchAgentSpec {
  readonly label: string;
  readonly programArguments: ReadonlyArray<string>;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly standardOutPath: string;
  readonly standardErrorPath: string;
}

export interface LaunchAgentInstallResult {
  readonly label: string;
  readonly plistPath: string;
}

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const renderStringArray = (values: ReadonlyArray<string>): string =>
  [
    "  <array>",
    ...values.map((value) => `    <string>${xmlEscape(value)}</string>`),
    "  </array>",
  ].join("\n");

const renderEnvironment = (environment: Readonly<Record<string, string>>): string =>
  [
    "  <dict>",
    ...Object.entries(environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, value]) => [
        `    <key>${xmlEscape(key)}</key>`,
        `    <string>${xmlEscape(value)}</string>`,
      ]),
    "  </dict>",
  ].join("\n");

export const renderLaunchAgentPlist = (spec: LaunchAgentSpec): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(spec.label)}</string>
  <key>ProgramArguments</key>
${renderStringArray(spec.programArguments)}
  <key>WorkingDirectory</key>
  <string>${xmlEscape(spec.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
${renderEnvironment(spec.environment)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(spec.standardOutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(spec.standardErrorPath)}</string>
</dict>
</plist>
`;

const userLaunchAgentDir = (): string =>
  join(homedir(), "Library", "LaunchAgents");

export const launchAgentLabelForServer = (serverName: string): string =>
  `com.prism.mcp.${serverName.replace(/[^A-Za-z0-9.-]/gu, "-")}`;

export const launchAgentPathForLabel = (label: string): string =>
  join(userLaunchAgentDir(), `${label}.plist`);

const launchctlDomain = (): string => {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) throw new Error("launchd user domain requires a numeric uid.");
  return `gui/${uid}`;
};

const runLaunchctl = async (
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean } = {},
): Promise<void> => {
  try {
    await execFileAsync("launchctl", [...args]);
  } catch (error) {
    if (options.allowFailure) return;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`launchctl ${args.join(" ")} failed: ${detail}`);
  }
};

const readExistingPlist = async (plistPath: string): Promise<string | undefined> => {
  try {
    return await readFile(plistPath, "utf8");
  } catch {
    return undefined;
  }
};

const isLaunchAgentLoaded = async (domain: string, label: string): Promise<boolean> => {
  try {
    await execFileAsync("launchctl", ["print", `${domain}/${label}`]);
    return true;
  } catch {
    return false;
  }
};

export const installLaunchAgent = async (
  spec: LaunchAgentSpec,
): Promise<LaunchAgentInstallResult> => {
  const plistPath = launchAgentPathForLabel(spec.label);
  const desiredPlist = renderLaunchAgentPlist(spec);
  const domain = launchctlDomain();

  // The LaunchAgent label is plugin-global (one MCP daemon per plugin across all
  // harnesses). If the on-disk plist already matches the desired spec byte-for-byte
  // and launchd has the service loaded, this is a no-op — skip the bootout /
  // bootstrap / kickstart churn that would otherwise race against other harness
  // compiles and trip launchd's ThrottleInterval.
  const existingPlist = await readExistingPlist(plistPath);
  if (existingPlist === desiredPlist && await isLaunchAgentLoaded(domain, spec.label)) {
    return { label: spec.label, plistPath };
  }

  await mkdir(userLaunchAgentDir(), { recursive: true });
  await mkdir(join(spec.workingDirectory, "runtime", "logs"), { recursive: true, mode: 0o700 });
  await writeFile(plistPath, desiredPlist, { mode: 0o600 });
  await chmod(plistPath, 0o600).catch(() => undefined);

  await runLaunchctl(["bootout", `${domain}/${spec.label}`], { allowFailure: true });
  await runLaunchctl(["bootout", domain, plistPath], { allowFailure: true });
  await runLaunchctl(["bootstrap", domain, plistPath]);
  await runLaunchctl(["kickstart", "-k", `${domain}/${spec.label}`]);

  return { label: spec.label, plistPath };
};

export const stopLaunchAgent = async (label: string): Promise<void> => {
  const plistPath = launchAgentPathForLabel(label);
  const domain = launchctlDomain();
  await runLaunchctl(["bootout", `${domain}/${label}`], { allowFailure: true });
  await runLaunchctl(["bootout", domain, plistPath], { allowFailure: true });
};
