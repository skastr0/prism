import { backupFile, removeDir, removeFile, writeFile } from "../../fs.js";
import type { LowerOperation } from "./opencode.js";

export const normalizeBundleSegment = (value: string, fallback = "plugin"): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
};

export const yamlScalar = (value: string | number | boolean): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

export const serializeSimpleFrontmatter = (values: Record<string, unknown>): string => {
  const lines = ["---"];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(String(item))}`);
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
};

export const executeStandardLowering = async (
  operations: LowerOperation[],
  options: { backup: boolean; dryRun: boolean },
): Promise<{ backups: string[] }> => {
  const backups: string[] = [];
  if (options.dryRun) return { backups };

  for (const operation of operations) {
    if (operation.reason === "unchanged") continue;

    if (operation.kind === "write-md" || operation.kind === "write-plugin-file") {
      if (options.backup && operation.kind === "write-md") {
        const backup = await backupFile(operation.target);
        if (backup) backups.push(backup);
      }
      await writeFile(operation.target, operation.content);
      continue;
    }

    if (operation.kind === "prune-plugin-path") {
      if (operation.targetType === "dir") await removeDir(operation.target);
      else await removeFile(operation.target);
    }
  }

  return { backups };
};
