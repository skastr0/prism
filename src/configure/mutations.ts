/**
 * Configure mutations — uninstall plugins / delete Prism-owned files for claude-code.
 * All writes go through syncDesiredRoot (sole harness-root writer).
 */

import { basename, dirname, join, relative, resolve } from "node:path";
import { exists, listDir, readFile, removeDir, removeFile } from "../fs.js";
import { resolvePrismHome } from "../prism-home.js";
import {
  decodeSnapshotManifest,
  type SnapshotEntry,
  type SnapshotManifest,
} from "../state/snapshot.js";
import { snapshotDir } from "../state/store.js";
import type { DesiredFile, DesiredRegion, DesiredRoot } from "../sync/desired.js";
import { parseRegionRef } from "../sync/plan.js";
import { syncDesiredRoot } from "../sync/run.js";
import { prismToolPluginDir } from "../tools-cli/paths.js";
import { barePluginName, pluginScopeNames } from "./inventory.js";
import type { MutationPlan, MutationPlanOp, MutationResult } from "./model.js";

const HARNESS = "claude-code" as const;

const listClaudeManifests = async (
  prismHome: string,
): Promise<ReadonlyArray<SnapshotManifest>> => {
  const dir = snapshotDir(prismHome);
  if (!(await exists(dir))) return [];
  const out: SnapshotManifest[] = [];
  for (const name of await listDir(dir)) {
    if (!name.endsWith(".json") || name.includes(".corrupt-")) continue;
    try {
      const decoded = decodeSnapshotManifest(await readFile(join(dir, name)));
      if (decoded._tag === "Right" && decoded.right.harness === HARNESS) {
        out.push(decoded.right);
      }
    } catch {
      // skip
    }
  }
  return out;
};

const opsFromReport = (
  report: Awaited<ReturnType<typeof syncDesiredRoot>>,
): MutationPlanOp[] =>
  report.ops.map((op) => ({
    kind: op.kind,
    targetPath: "targetPath" in op ? op.targetPath : "(regions)",
    detail:
      op.kind === "blocked"
        ? op.hint
        : op.kind === "prune"
          ? op.reason
          : op.kind === "repair"
            ? op.reason
            : undefined,
  }));

/**
 * Rehydrate a snapshot region entry into a DesiredRegion so sibling regions
 * are preserved when deleting a single owned file under the same plugin scope.
 */
const rehydrateRegion = async (
  entry: SnapshotEntry,
): Promise<DesiredRegion | undefined> => {
  if (entry.mode !== "region" || entry.regionKey === undefined) return undefined;
  if (!(await exists(entry.targetPath))) return undefined;
  const parsed = parseRegionRef(entry.regionKey);
  if (!parsed) return undefined;
  const content = await readFile(entry.targetPath);

  if (parsed.kind === "marker") {
    const prefix = parsed.commentPrefix;
    const key = parsed.regionKey;
    const suffix = parsed.commentSuffix ?? "";
    const begin = `${prefix} --- prism:${key} begin ---${suffix}`;
    const end = `${prefix} --- prism:${key} end ---${suffix}`;
    const beginIdx = content.indexOf(begin);
    const endIdx = content.indexOf(end);
    if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return undefined;
    const body = content.slice(beginIdx + begin.length, endIdx).replace(/^\n/, "").replace(/\n$/, "");
    return {
      kind: "marker",
      targetPath: entry.targetPath,
      regionKey: key,
      commentPrefix: prefix,
      ...(parsed.commentSuffix !== undefined ? { commentSuffix: parsed.commentSuffix } : {}),
      content: body,
      plugin: entry.plugin,
    };
  }

  if (parsed.kind === "json") {
    // Re-assert current value so the key is not pruned.
    try {
      const { parse: parseJsonc } = await import("jsonc-parser");
      const doc = parseJsonc(content) as unknown;
      let cursor: unknown = doc;
      for (const seg of parsed.jsonPath) {
        if (cursor === null || typeof cursor !== "object") return undefined;
        cursor = (cursor as Record<string, unknown>)[String(seg)];
      }
      return {
        kind: "json-key",
        targetPath: entry.targetPath,
        regionKey: parsed.regionKey,
        jsonPath: parsed.jsonPath,
        value: cursor,
        plugin: entry.plugin,
      };
    } catch {
      return undefined;
    }
  }

  // json-array-member: re-assert identity value if present
  if (parsed.kind === "json-array") {
    return {
      kind: "json-array-member",
      targetPath: entry.targetPath,
      regionKey: parsed.regionKey,
      jsonPath: parsed.jsonPath,
      value: parsed.identity,
      ...(parsed.memberKey !== undefined ? { memberKey: parsed.memberKey } : {}),
      plugin: entry.plugin,
    };
  }

  return undefined;
};

const removeToolRuntime = async (
  prismHome: string,
  pluginName: string,
): Promise<string | undefined> => {
  const dir = prismToolPluginDir(prismHome, pluginName);
  if (!(await exists(dir))) return undefined;
  await removeDir(dir);
  return dir;
};

/**
 * Uninstall a Prism plugin from all claude-code snapshot roots.
 * Empty desired + scopePlugins prunes ledgered files/regions for that plugin.
 * Also removes unledgered PRISM_HOME/runtime/tools/<plugin>.
 */
export const planUninstallPlugin = async (options: {
  readonly pluginName: string;
  readonly prismHome?: string;
  readonly dryRun?: boolean;
}): Promise<MutationResult> => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const dryRun = options.dryRun ?? true;
  const bare = barePluginName(options.pluginName);
  const scope = pluginScopeNames(bare);
  const manifests = await listClaudeManifests(prismHome);

  const rootsWithPlugin = manifests.filter((m) =>
    m.entries.some((e) => scope.has(e.plugin)),
  );

  const allOps: MutationPlanOp[] = [];
  const blocked: string[] = [];
  const failures: string[] = [];
  const notes: string[] = [];

  if (rootsWithPlugin.length === 0) {
    notes.push(`No claude-code snapshot entries for plugin '${bare}'.`);
  }

  for (const manifest of rootsWithPlugin) {
    const desired: DesiredRoot = {
      harness: HARNESS,
      root: manifest.root,
      files: [],
      regions: [],
    };
    try {
      const report = await syncDesiredRoot({
        prismHome,
        desired,
        scopePlugins: scope,
        dryRun,
      });
      allOps.push(...opsFromReport(report));
      for (const b of report.blocked) {
        blocked.push(`${b.targetPath}: ${b.hint}`);
      }
      for (const f of report.failures) {
        failures.push(`${f.op.kind} ${"targetPath" in f.op ? f.op.targetPath : "?"}: ${f.message}`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Tools runtime (outside snapshot)
  const toolsDir = prismToolPluginDir(prismHome, bare);
  if (await exists(toolsDir)) {
    allOps.push({
      kind: dryRun ? "would-remove-tools-runtime" : "remove-tools-runtime",
      targetPath: toolsDir,
    });
    if (!dryRun) {
      try {
        const removed = await removeToolRuntime(prismHome, bare);
        if (removed) notes.push(`Removed tools runtime ${removed}`);
      } catch (error) {
        failures.push(
          `tools runtime: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    plan: {
      title: `Uninstall plugin '${bare}' from claude-code`,
      dryRun,
      ops: allOps,
      blocked,
      notes,
    },
    applied: !dryRun && failures.length === 0,
    failures,
  };
};

/**
 * Delete one Prism-owned whole file, preserving other owned files + regions
 * for the same plugin on that root.
 */
export const planDeleteOwnedFile = async (options: {
  readonly targetPath: string;
  readonly prismHome?: string;
  readonly dryRun?: boolean;
}): Promise<MutationResult> => {
  const prismHome = options.prismHome ?? resolvePrismHome();
  const dryRun = options.dryRun ?? true;
  const target = resolve(options.targetPath);
  const manifests = await listClaudeManifests(prismHome);

  let hit: { manifest: SnapshotManifest; entry: SnapshotEntry } | undefined;
  for (const manifest of manifests) {
    const entry = manifest.entries.find(
      (e) => resolve(e.targetPath) === target && e.mode === "owned",
    );
    if (entry) {
      hit = { manifest, entry };
      break;
    }
  }

  if (!hit) {
    return {
      plan: {
        title: `Delete ${basename(target)}`,
        dryRun,
        ops: [],
        blocked: [`Not a Prism-owned whole file on claude-code: ${target}`],
        notes: ["Only snapshot mode=owned files can be deleted here. Regions require plugin uninstall or a region-aware delete."],
      },
      applied: false,
      failures: [],
    };
  }

  const { manifest, entry } = hit;
  const scope = pluginScopeNames(barePluginName(entry.plugin));
  // Keep same-plugin entries on this root except the target path
  const siblings = manifest.entries.filter(
    (e) => scope.has(e.plugin) && !(e.mode === "owned" && resolve(e.targetPath) === target),
  );

  const files: DesiredFile[] = [];
  const regions: DesiredRegion[] = [];

  for (const sibling of siblings) {
    if (sibling.mode === "owned") {
      if (!(await exists(sibling.targetPath))) continue;
      files.push({
        targetPath: sibling.targetPath,
        content: await readFile(sibling.targetPath),
        plugin: sibling.plugin,
      });
    } else {
      const region = await rehydrateRegion(sibling);
      if (region) regions.push(region);
    }
  }

  const desired: DesiredRoot = {
    harness: HARNESS,
    root: manifest.root,
    files,
    regions,
  };

  const failures: string[] = [];
  const blocked: string[] = [];
  let ops: MutationPlanOp[] = [];

  try {
    const report = await syncDesiredRoot({
      prismHome,
      desired,
      scopePlugins: scope,
      dryRun,
    });
    ops = opsFromReport(report);
    for (const b of report.blocked) blocked.push(`${b.targetPath}: ${b.hint}`);
    for (const f of report.failures) {
      failures.push(`${f.op.kind}: ${f.message}`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  return {
    plan: {
      title: `Delete owned file ${relative(manifest.root, target) || basename(target)}`,
      dryRun,
      ops,
      blocked,
      notes: [
        `Plugin scope: ${barePluginName(entry.plugin)}`,
        `Preserved ${files.length} owned file(s) and ${regions.length} region(s) for the same plugin.`,
      ],
    },
    applied: !dryRun && failures.length === 0 && blocked.length === 0,
    failures,
  };
};

/**
 * Best-effort delete of an unledgered prism-generated path (stray).
 * Only allows paths containing prism-generated- under the claude root.
 */
export const planDeleteStrayPath = async (options: {
  readonly targetPath: string;
  readonly claudeRoot: string;
  readonly dryRun?: boolean;
}): Promise<MutationResult> => {
  const dryRun = options.dryRun ?? true;
  const target = resolve(options.targetPath);
  const root = resolve(options.claudeRoot);
  if (!target.startsWith(`${root}/`) && target !== root) {
    return {
      plan: {
        title: "Delete stray",
        dryRun,
        ops: [],
        blocked: ["Path is outside the claude-code root."],
        notes: [],
      },
      applied: false,
      failures: [],
    };
  }
  if (!target.includes("prism-generated-")) {
    return {
      plan: {
        title: "Delete stray",
        dryRun,
        ops: [],
        blocked: ["Refusing to delete paths that are not prism-generated-*."],
        notes: [],
      },
      applied: false,
      failures: [],
    };
  }

  const ops: MutationPlanOp[] = [
    { kind: dryRun ? "would-remove" : "remove", targetPath: target },
  ];
  if (!dryRun) {
    try {
      // If directory, removeDir; if file, removeFile
      const parent = dirname(target);
      await removeFile(target).catch(async () => {
        await removeDir(target);
      });
      // clean empty parents up to root
      let current = parent;
      while (current.startsWith(root) && current !== root) {
        const names = await listDir(current).catch(() => ["."]);
        if (names.length > 0) break;
        await removeDir(current).catch(() => undefined);
        current = dirname(current);
      }
    } catch (error) {
      return {
        plan: { title: "Delete stray", dryRun, ops, blocked: [], notes: [] },
        applied: false,
        failures: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  return {
    plan: {
      title: `Delete unledgered ${basename(target)}`,
      dryRun,
      ops,
      blocked: [],
      notes: ["Unledgered prism-generated path (not in snapshot)."],
    },
    applied: !dryRun,
    failures: [],
  };
};
