/**
 * `src/doctor/launchd-residue.ts` (OBS-002) proof, entirely against the
 * injectable `LaunchdResidueDeps` seam -- never real `launchctl` or the real
 * `~/Library/LaunchAgents` (see the module doc's isolation note; `doctor.ts`
 * additionally gates its own callers on the real `~/.prism` home, covered by
 * `doctor.test.ts`'s existing sandboxed suite never reaching this module's
 * default deps at all).
 */

import { expect, test } from "bun:test";
import {
  cleanupLaunchdResidueEntry,
  collectLaunchdResidueEntries,
  type LaunchdResidueDeps,
} from "./launchd-residue.js";

const samplePlist = (options: {
  readonly label: string;
  readonly programPath: string;
  readonly errLogPath: string;
  readonly outLogPath: string;
}): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${options.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>${options.programPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/test/.prism</string>
  <key>EnvironmentVariables</key>
  <dict>
  </dict>
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
  <string>${options.outLogPath}</string>
  <key>StandardErrorPath</key>
  <string>${options.errLogPath}</string>
</dict>
</plist>
`;

interface FakeWorldOptions {
  readonly plists: Record<string, string>; // plistPath -> xml content
  readonly loadedLabels: readonly string[];
  readonly existingPaths?: readonly string[]; // program/log paths that "exist" on disk
  readonly fileSizes?: Record<string, number>;
}

const createFakeDeps = (
  options: FakeWorldOptions,
): { readonly deps: LaunchdResidueDeps; readonly boutedOut: string[]; readonly removedPaths: string[] } => {
  const boutedOut: string[] = [];
  const removedPaths: string[] = [];
  // One shared "does this path currently exist" pool backs both `pathExists`
  // (program-bundle existence check) and `removeFile` (idempotent removal
  // simulation) -- every plist itself plus every explicitly-declared
  // existing path starts out present.
  const present = new Set([...Object.keys(options.plists), ...(options.existingPaths ?? [])]);

  const deps: LaunchdResidueDeps = {
    listPlistFiles: async () => Object.keys(options.plists),
    listLoadedLabels: async () => options.loadedLabels,
    readPlist: async (path) => options.plists[path],
    pathExists: async (path) => present.has(path),
    fileSize: async (path) => options.fileSizes?.[path],
    bootout: async (label) => {
      boutedOut.push(label);
    },
    removeFile: async (path) => {
      const wasPresent = present.has(path);
      if (wasPresent) {
        present.delete(path);
        removedPaths.push(path);
      }
      return wasPresent;
    },
  };

  return { deps, boutedOut, removedPaths };
};

test("collectLaunchdResidueEntries: no plists and no loaded labels -> empty", async () => {
  const { deps } = createFakeDeps({ plists: {}, loadedLabels: [] });
  expect(await collectLaunchdResidueEntries(deps)).toEqual([]);
});

test("collectLaunchdResidueEntries: loaded service with a live bundle -> no missing program paths", async () => {
  const plistPath = "/home/Library/LaunchAgents/com.prism.mcp.owner.plist";
  const programPath = "/home/.prism/runtime/mcp/owner/server.mjs";
  const errLogPath = "/home/.prism/runtime/logs/owner.err.log";
  const outLogPath = "/home/.prism/runtime/logs/owner.out.log";
  const { deps } = createFakeDeps({
    plists: {
      [plistPath]: samplePlist({ label: "com.prism.mcp.owner", programPath, errLogPath, outLogPath }),
    },
    loadedLabels: ["com.prism.mcp.owner"],
    existingPaths: [programPath],
    fileSizes: { [errLogPath]: 1024 },
  });

  const entries = await collectLaunchdResidueEntries(deps);
  expect(entries).toEqual([
    {
      label: "com.prism.mcp.owner",
      plistPath,
      plistExists: true,
      loaded: true,
      missingProgramPaths: [],
      errLogPath,
      errLogSize: 1024,
    },
  ]);
});

test("collectLaunchdResidueEntries: dead-bundle respawn -> missing program path reported", async () => {
  const plistPath = "/home/Library/LaunchAgents/com.prism.mcp.owner.plist";
  const programPath = "/home/.prism/runtime/mcp/owner/server.mjs";
  const errLogPath = "/home/.prism/runtime/logs/owner.err.log";
  const outLogPath = "/home/.prism/runtime/logs/owner.out.log";
  const { deps } = createFakeDeps({
    plists: {
      [plistPath]: samplePlist({ label: "com.prism.mcp.owner", programPath, errLogPath, outLogPath }),
    },
    loadedLabels: ["com.prism.mcp.owner"],
    existingPaths: [], // programPath deleted by the consolidation
    fileSizes: { [errLogPath]: 5_234_991 },
  });

  const [entry] = await collectLaunchdResidueEntries(deps);
  expect(entry).toMatchObject({
    label: "com.prism.mcp.owner",
    loaded: true,
    missingProgramPaths: [programPath],
    errLogSize: 5_234_991,
  });
});

test("collectLaunchdResidueEntries: plist survives but is not loaded", async () => {
  const plistPath = "/home/Library/LaunchAgents/com.prism.mcp.prism-harness-qa.plist";
  const { deps } = createFakeDeps({
    plists: {
      [plistPath]: samplePlist({
        label: "com.prism.mcp.prism-harness-qa",
        programPath: "/home/.prism/runtime/mcp/prism-harness-qa/server.mjs",
        errLogPath: "/home/.prism/runtime/logs/prism-harness-qa.err.log",
        outLogPath: "/home/.prism/runtime/logs/prism-harness-qa.out.log",
      }),
    },
    loadedLabels: [],
    existingPaths: ["/home/.prism/runtime/mcp/prism-harness-qa/server.mjs"],
  });

  const [entry] = await collectLaunchdResidueEntries(deps);
  expect(entry).toMatchObject({ label: "com.prism.mcp.prism-harness-qa", loaded: false, plistExists: true });
});

test("collectLaunchdResidueEntries: loaded label with no surviving plist file", async () => {
  const { deps } = createFakeDeps({ plists: {}, loadedLabels: ["com.prism.mcp.ghost"] });
  const [entry] = await collectLaunchdResidueEntries(deps);
  expect(entry).toEqual({
    label: "com.prism.mcp.ghost",
    plistExists: false,
    loaded: true,
    missingProgramPaths: [],
  });
});

test("cleanupLaunchdResidueEntry: boots out the label and removes plist + paired logs", async () => {
  const plistPath = "/home/Library/LaunchAgents/com.prism.mcp.owner.plist";
  const errLogPath = "/home/.prism/runtime/logs/owner.err.log";
  const outLogPath = "/home/.prism/runtime/logs/owner.out.log";
  const { deps, boutedOut, removedPaths } = createFakeDeps({
    plists: { [plistPath]: "unused" },
    loadedLabels: ["com.prism.mcp.owner"],
    existingPaths: [errLogPath, outLogPath],
  });

  const result = await cleanupLaunchdResidueEntry(
    {
      label: "com.prism.mcp.owner",
      plistPath,
      plistExists: true,
      loaded: true,
      missingProgramPaths: [],
      errLogPath,
    },
    deps,
  );

  expect(boutedOut).toEqual(["com.prism.mcp.owner"]);
  expect(result).toEqual({
    label: "com.prism.mcp.owner",
    plistPath,
    removedPlist: true,
    removedErrLog: true,
    removedOutLog: true,
  });
  expect(removedPaths.sort()).toEqual([errLogPath, outLogPath, plistPath].sort());
});

test("cleanupLaunchdResidueEntry: idempotent -- a second cleanup of the same entry removes nothing further", async () => {
  const plistPath = "/home/Library/LaunchAgents/com.prism.mcp.owner.plist";
  const errLogPath = "/home/.prism/runtime/logs/owner.err.log";
  const { deps, boutedOut } = createFakeDeps({
    plists: { [plistPath]: "unused" },
    loadedLabels: ["com.prism.mcp.owner"],
    existingPaths: [errLogPath],
  });
  const entry = {
    label: "com.prism.mcp.owner",
    plistPath,
    plistExists: true,
    loaded: true,
    missingProgramPaths: [],
    errLogPath,
  } as const;

  const first = await cleanupLaunchdResidueEntry(entry, deps);
  const second = await cleanupLaunchdResidueEntry(entry, deps);

  expect(first.removedPlist).toBe(true);
  expect(second.removedPlist).toBe(false);
  expect(second.removedErrLog).toBe(false);
  expect(second.removedOutLog).toBe(false);
  // bootout is called every time -- launchctl's own bootout is idempotent,
  // never an error on an already-unloaded label (module doc).
  expect(boutedOut).toEqual(["com.prism.mcp.owner", "com.prism.mcp.owner"]);
});

test("cleanupLaunchdResidueEntry: no plist and no err log -> nothing to remove, still boots out", async () => {
  const { deps, boutedOut, removedPaths } = createFakeDeps({ plists: {}, loadedLabels: ["com.prism.mcp.ghost"] });
  const result = await cleanupLaunchdResidueEntry(
    { label: "com.prism.mcp.ghost", plistExists: false, loaded: true, missingProgramPaths: [] },
    deps,
  );
  expect(boutedOut).toEqual(["com.prism.mcp.ghost"]);
  expect(removedPaths).toEqual([]);
  expect(result).toEqual({
    label: "com.prism.mcp.ghost",
    removedPlist: false,
    removedErrLog: false,
    removedOutLog: false,
  });
});
