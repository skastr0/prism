/**
 * Retired launchd-era `com.prism.mcp.*` MCP-daemon residue (OBS-002).
 *
 * `src/mcp/launchd.ts` (deleted at 1de11da, "retire manual TCP daemon
 * commands, migrate status to UDS") installed one macOS LaunchAgent per MCP
 * daemon: label `com.prism.mcp.<serverName>` (`launchAgentLabelForServer`),
 * plist at `~/Library/LaunchAgents/<label>.plist`, `KeepAlive: {
 * SuccessfulExit: false }` (unconditional respawn), `ProgramArguments:
 * [bunPath, serverPath]`, and `StandardOutPath`/`StandardErrorPath` under
 * `<prismHome>/runtime/logs/<serverName>.{out,err}.log` (`lifecycle.ts`'s
 * `startLaunchAgent`, deleted in the same commit). That whole install/
 * uninstall path was deleted when the shim moved to on-demand UDS spawning,
 * but nothing ever booted out or removed the plists/logs the retired scheme
 * had already installed -- `launchctl`'s `KeepAlive` keeps respawning a
 * daemon whose `server.mjs` bundle no longer exists, forever, writing an
 * unbounded crash-loop error log (verified live: one daemon at 39,068
 * "Module not found" lines / 4.99MB before manual remediation on
 * 2026-07-13).
 *
 * Every dependency that touches the OS (`launchctl`, `~/Library/LaunchAgents`,
 * the filesystem) is injected through `LaunchdResidueDeps` -- production
 * calls default to `realLaunchdResidueDeps`; `launchd-residue.test.ts` fakes
 * the whole surface, so this module (and its `bun:test` suite) never spawns
 * a real `launchctl` process or touches the real home directory. `doctor.ts`
 * additionally gates its own callers on the historical `launchAgentEligible`
 * predicate (real `~/.prism` home, darwin only -- the same gate
 * `lifecycle.ts` used before this scheme was retired) before ever reaching
 * the real deps, so a sandboxed doctor test run never touches this module's
 * OS surface either.
 */

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { exists, readFile, removeFile } from "../fs.js";

const execFileAsync = promisify(execFile);

const PRISM_LAUNCHD_LABEL_PREFIX = "com.prism.mcp.";

export interface LaunchdResidueDeps {
  /** Absolute paths of every `com.prism.mcp.*.plist` under `~/Library/LaunchAgents`. */
  readonly listPlistFiles: () => Promise<readonly string[]>;
  /** Labels `launchctl list` reports that start with `com.prism.mcp.`. */
  readonly listLoadedLabels: () => Promise<readonly string[]>;
  readonly readPlist: (path: string) => Promise<string | undefined>;
  readonly pathExists: (path: string) => Promise<boolean>;
  readonly fileSize: (path: string) => Promise<number | undefined>;
  /** Idempotent: never throws for an already-unloaded (or never-loaded) label. */
  readonly bootout: (label: string) => Promise<void>;
  /** Idempotent: returns whether a file actually existed and was removed. */
  readonly removeFile: (path: string) => Promise<boolean>;
}

const launchAgentsDir = (): string => join(homedir(), "Library", "LaunchAgents");

const launchctlDomain = (): string => {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) throw new Error("launchd user domain requires a numeric uid.");
  return `gui/${uid}`;
};

export const realLaunchdResidueDeps: LaunchdResidueDeps = {
  listPlistFiles: async () => {
    let names: string[];
    try {
      names = await readdir(launchAgentsDir());
    } catch {
      return [];
    }
    return names
      .filter((name) => name.startsWith(PRISM_LAUNCHD_LABEL_PREFIX) && name.endsWith(".plist"))
      .map((name) => join(launchAgentsDir(), name));
  },
  listLoadedLabels: async () => {
    try {
      const { stdout } = await execFileAsync("launchctl", ["list"]);
      return stdout
        .split("\n")
        .map((line) => line.split("\t").at(-1)?.trim())
        .filter(
          (label): label is string => label !== undefined && label.startsWith(PRISM_LAUNCHD_LABEL_PREFIX),
        );
    } catch {
      return [];
    }
  },
  readPlist: async (path) => {
    try {
      return await readFile(path);
    } catch {
      return undefined;
    }
  },
  pathExists: (path) => exists(path),
  fileSize: async (path) => {
    try {
      return (await stat(path)).size;
    } catch {
      return undefined;
    }
  },
  bootout: async (label) => {
    try {
      await execFileAsync("launchctl", ["bootout", `${launchctlDomain()}/${label}`]);
    } catch {
      // Already unloaded (or never loaded) is the expected steady state after
      // cleanup -- launchctl's own exit code is not a failure signal here.
    }
  },
  removeFile: async (path) => {
    const present = await exists(path);
    if (present) await removeFile(path);
    return present;
  },
};

// ---------------------------------------------------------------------------
// plist XML reading -- a narrow reader for exactly the shape
// `renderLaunchAgentPlist` (deleted `src/mcp/launchd.ts`) wrote. Never a
// general plist parser.
// ---------------------------------------------------------------------------

const xmlUnescape = (value: string): string =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const plistArrayAfterKey = (xml: string, key: string): string[] | undefined => {
  const keyIndex = xml.indexOf(`<key>${key}</key>`);
  if (keyIndex === -1) return undefined;
  const arrayStart = xml.indexOf("<array>", keyIndex);
  const arrayEnd = xml.indexOf("</array>", arrayStart);
  if (arrayStart === -1 || arrayEnd === -1) return undefined;
  const body = xml.slice(arrayStart, arrayEnd);
  return [...body.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlUnescape(match[1]!));
};

const plistScalarAfterKey = (xml: string, key: string): string | undefined => {
  const keyIndex = xml.indexOf(`<key>${key}</key>`);
  if (keyIndex === -1) return undefined;
  const match = xml.slice(keyIndex).match(/<string>([\s\S]*?)<\/string>/);
  return match ? xmlUnescape(match[1]!) : undefined;
};

export interface LaunchdResidueEntry {
  readonly label: string;
  readonly plistPath?: string;
  readonly plistExists: boolean;
  readonly loaded: boolean;
  readonly missingProgramPaths: readonly string[];
  readonly errLogPath?: string;
  readonly errLogSize?: number;
}

/**
 * Every retired `com.prism.mcp.*` label either currently loaded in
 * launchctl, or whose plist still survives on disk (or both) -- the union
 * is the full residue surface (module doc): a daemon can be loaded with its
 * plist already deleted out from under it, or a plist can survive unloaded.
 */
export const collectLaunchdResidueEntries = async (
  deps: LaunchdResidueDeps = realLaunchdResidueDeps,
): Promise<LaunchdResidueEntry[]> => {
  const plistPaths = await deps.listPlistFiles();
  const loadedLabels = new Set(await deps.listLoadedLabels());
  const plistPathByLabel = new Map<string, string>();
  for (const path of plistPaths) {
    plistPathByLabel.set(basename(path).replace(/\.plist$/, ""), path);
  }
  const allLabels = [...new Set([...plistPathByLabel.keys(), ...loadedLabels])].sort();

  const entries: LaunchdResidueEntry[] = [];
  for (const label of allLabels) {
    const plistPath = plistPathByLabel.get(label);
    const loaded = loadedLabels.has(label);
    const missingProgramPaths: string[] = [];
    let errLogPath: string | undefined;
    let errLogSize: number | undefined;

    if (plistPath !== undefined) {
      const xml = await deps.readPlist(plistPath);
      if (xml !== undefined) {
        const programArguments = plistArrayAfterKey(xml, "ProgramArguments") ?? [];
        // Index 0 is the bun binary path; index 1+ are the server bundle/
        // script paths a consolidation deletes (`startLaunchAgent`'s only
        // caller wrote exactly `[bunPath, serverPath]` -- module doc).
        for (const candidate of programArguments.slice(1)) {
          if (!(await deps.pathExists(candidate))) missingProgramPaths.push(candidate);
        }
        errLogPath = plistScalarAfterKey(xml, "StandardErrorPath");
        if (errLogPath !== undefined) errLogSize = await deps.fileSize(errLogPath);
      }
    }

    entries.push({
      label,
      ...(plistPath !== undefined ? { plistPath } : {}),
      plistExists: plistPath !== undefined,
      loaded,
      missingProgramPaths,
      ...(errLogPath !== undefined ? { errLogPath } : {}),
      ...(errLogSize !== undefined ? { errLogSize } : {}),
    });
  }
  return entries;
};

export interface LaunchdResidueCleanupResult {
  readonly label: string;
  readonly plistPath?: string;
  readonly removedPlist: boolean;
  readonly removedErrLog: boolean;
  readonly removedOutLog: boolean;
}

/**
 * Boots the label out (idempotent, tolerant of already-unloaded) and removes
 * its plist plus paired `.err.log`/`.out.log` (derived from `errLogPath` by
 * suffix swap -- `startLaunchAgent` always wrote the pair together, module
 * doc). A second call on the same, already-cleaned entry removes nothing
 * further (`removeFile`'s idempotent existence check).
 */
export const cleanupLaunchdResidueEntry = async (
  entry: LaunchdResidueEntry,
  deps: LaunchdResidueDeps = realLaunchdResidueDeps,
): Promise<LaunchdResidueCleanupResult> => {
  await deps.bootout(entry.label);
  const removedPlist = entry.plistPath !== undefined ? await deps.removeFile(entry.plistPath) : false;
  const removedErrLog = entry.errLogPath !== undefined ? await deps.removeFile(entry.errLogPath) : false;
  const outLogPath = entry.errLogPath?.replace(/\.err\.log$/, ".out.log");
  const removedOutLog = outLogPath !== undefined ? await deps.removeFile(outLogPath) : false;
  return {
    label: entry.label,
    ...(entry.plistPath !== undefined ? { plistPath: entry.plistPath } : {}),
    removedPlist,
    removedErrLog,
    removedOutLog,
  };
};
