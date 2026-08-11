/**
 * User-initiated settings writes for prism configure.
 * Scalar/enum/secret only — complex types and yaml blocked for now.
 */

import { join } from "node:path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { copyFile, exists, expandPath, readFile, writeFile } from "../fs.js";
import type { HarnessId } from "../types.js";
import { getHarnessCatalog, HARNESS_CATALOGS } from "./catalogs/index.js";
import type { CatalogField, CatalogSettingsFile } from "./catalogs/types.js";

export type SetSettingRequest = {
  harness: string; // HarnessId
  root?: string; // default catalog globalRoot expanded
  key: string; // catalogue field key, dotted path into settings file
  value: string | boolean | number;
  dryRun?: boolean;
};

export type SetSettingResult = {
  ok: boolean;
  dryRun: boolean;
  path: string;
  key: string;
  previousPreview?: string;
  nextPreview: string;
  message: string;
  blocked?: string;
};

const JSONC_FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

const WRITABLE_TYPES = new Set(["string", "boolean", "number", "enum", "secret"]);

/**
 * Immutably set a dotted path on a plain object tree (creates intermediate objects).
 */
export function setDottedPath(doc: unknown, key: string, value: unknown): unknown {
  const parts = key.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) return value;

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);

  const root: Record<string, unknown> = isPlainObject(doc) ? { ...doc } : {};
  let cursor: Record<string, unknown> = root;

  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    const next = cursor[seg];
    if (isPlainObject(next)) {
      cursor[seg] = { ...next };
    } else {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }

  cursor[parts[parts.length - 1]!] = value;
  return root;
}

export function getDottedPath(doc: unknown, key: string): unknown {
  const parts = key.split(".").filter((p) => p.length > 0);
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const previewValue = (value: unknown): string => {
  if (value === undefined) return "(unset)";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const blockedResult = (
  req: SetSettingRequest,
  dryRun: boolean,
  path: string,
  reason: string,
): SetSettingResult => ({
  ok: false,
  dryRun,
  path,
  key: req.key,
  nextPreview: previewValue(req.value),
  message: reason,
  blocked: reason,
});

const resolveFilePath = (root: string, file: string): string => {
  if (file.startsWith("~") || file.startsWith("/")) return expandPath(file);
  return join(root, file);
};

const findSettingsFile = (
  catalog: { settingsFiles: ReadonlyArray<CatalogSettingsFile> },
  file: string,
): CatalogSettingsFile | undefined => catalog.settingsFiles.find((sf) => sf.path === file);

const coerceValue = (
  field: CatalogField,
  value: string | boolean | number,
): { ok: true; value: string | boolean | number } | { ok: false; reason: string } => {
  if (field.type === "boolean") {
    if (typeof value === "boolean") return { ok: true, value };
    if (value === "true") return { ok: true, value: true };
    if (value === "false") return { ok: true, value: false };
    return { ok: false, reason: `expected boolean for ${field.key}, got ${typeof value}` };
  }
  if (field.type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return { ok: true, value: Number(value) };
    }
    return { ok: false, reason: `expected number for ${field.key}` };
  }
  if (field.type === "enum") {
    const asString = String(value);
    if (field.enumValues !== undefined && field.enumValues.length > 0) {
      if (!field.enumValues.includes(asString)) {
        return {
          ok: false,
          reason: `invalid enum value for ${field.key}: ${asString} (allowed: ${field.enumValues.join(", ")})`,
        };
      }
    }
    return { ok: true, value: asString };
  }
  // string | secret
  if (typeof value === "string") return { ok: true, value };
  return { ok: true, value: String(value) };
};

const tomlLiteral = (value: unknown): string => {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    return JSON.stringify(value); // double-quoted, escapes handled
  }
  if (value === null || value === undefined) return '""';
  if (Array.isArray(value)) {
    return `[${value.map(tomlLiteral).join(", ")}]`;
  }
  // nested object as inline table is lossy; fall back to JSON string
  return JSON.stringify(JSON.stringify(value));
};

/** Best-effort TOML serialize for plain objects of scalars/nested tables (comments lost). */
export function serializeToml(doc: unknown): string {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return "";
  }

  const lines: string[] = [];

  const writeTable = (obj: Record<string, unknown>, path: ReadonlyArray<string>): void => {
    const scalars: Array<[string, unknown]> = [];
    const tables: Array<[string, Record<string, unknown>]> = [];

    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        tables.push([k, v as Record<string, unknown>]);
      } else {
        scalars.push([k, v]);
      }
    }

    if (path.length > 0) {
      lines.push(`[${path.join(".")}]`);
    }
    for (const [k, v] of scalars) {
      lines.push(`${k} = ${tomlLiteral(v)}`);
    }
    for (const [k, v] of tables) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      writeTable(v, [...path, k]);
    }
  };

  writeTable(doc as Record<string, unknown>, []);
  const body = lines.join("\n").replace(/\n+$/, "");
  return body.length === 0 ? "" : `${body}\n`;
};

const applyJsonModify = (
  text: string,
  key: string,
  value: unknown,
): string => {
  const base = text.trim().length === 0 ? "{}\n" : text;
  const path = key.split(".").filter((p) => p.length > 0);
  const edits = modify(base, path, value, { formattingOptions: JSONC_FORMAT });
  return applyEdits(base, edits);
};

/**
 * Plan (and optionally apply) a single catalogue field write.
 */
export async function planSetSetting(req: SetSettingRequest): Promise<SetSettingResult> {
  const dryRun = req.dryRun ?? false;

  if (!(req.harness in HARNESS_CATALOGS)) {
    return blockedResult(req, dryRun, "", `unknown harness: ${req.harness}`);
  }

  const catalog = getHarnessCatalog(req.harness as HarnessId);
  const field = catalog.fields.find((f) => f.key === req.key);
  if (field === undefined) {
    return blockedResult(
      req,
      dryRun,
      "",
      `unknown setting key '${req.key}' for harness ${req.harness}`,
    );
  }

  if (field.type === "object" || field.type === "array") {
    return blockedResult(
      req,
      dryRun,
      "",
      `complex types not writable yet (${field.type})`,
    );
  }

  if (!WRITABLE_TYPES.has(field.type)) {
    return blockedResult(
      req,
      dryRun,
      "",
      `type '${field.type}' is not writable`,
    );
  }

  const coerced = coerceValue(field, req.value);
  if (!coerced.ok) {
    return blockedResult(req, dryRun, "", coerced.reason);
  }

  const root = expandPath(req.root ?? catalog.globalRoot);
  const path = resolveFilePath(root, field.file);
  const settingsMeta = findSettingsFile(catalog, field.file);
  const format = settingsMeta?.format ?? inferFormat(field.file);

  if (format === "yaml") {
    return blockedResult(req, dryRun, path, "yaml write not supported yet");
  }
  if (format === "md" || format === "mdc" || format === "other") {
    return blockedResult(
      req,
      dryRun,
      path,
      `format '${format}' is not writable via configure settings`,
    );
  }

  let text = "";
  let previous: unknown = undefined;
  if (await exists(path)) {
    text = await readFile(path);
    try {
      if (format === "toml") {
        previous = getDottedPath(Bun.TOML.parse(text), field.key);
      } else {
        // json | jsonc
        previous = getDottedPath(parseJsonc(text) as unknown, field.key);
      }
    } catch (error) {
      return blockedResult(
        req,
        dryRun,
        path,
        `failed to parse ${format}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const nextPreview = previewValue(coerced.value);
  const previousPreview = previous === undefined ? undefined : previewValue(previous);

  let nextText: string;
  try {
    if (format === "toml") {
      const doc = text.trim().length === 0 ? {} : Bun.TOML.parse(text);
      const nextDoc = setDottedPath(doc, field.key, coerced.value);
      nextText = serializeToml(nextDoc);
    } else {
      // json | jsonc — prefer modify to preserve comments when possible
      nextText = applyJsonModify(text, field.key, coerced.value);
    }
  } catch (error) {
    return blockedResult(
      req,
      dryRun,
      path,
      `failed to build next document: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      path,
      key: req.key,
      ...(previousPreview !== undefined ? { previousPreview } : {}),
      nextPreview,
      message: `Would set ${req.key}=${nextPreview} in ${path}`,
    };
  }

  if (await exists(path)) {
    await copyFile(path, `${path}.prism-configure-bak`);
  }
  await writeFile(path, nextText);

  return {
    ok: true,
    dryRun: false,
    path,
    key: req.key,
    ...(previousPreview !== undefined ? { previousPreview } : {}),
    nextPreview,
    message: `Set ${req.key}=${nextPreview} in ${path}`,
  };
}

const inferFormat = (file: string): CatalogSettingsFile["format"] => {
  if (file.endsWith(".toml")) return "toml";
  if (file.endsWith(".yaml") || file.endsWith(".yml")) return "yaml";
  if (file.endsWith(".jsonc")) return "jsonc";
  if (file.endsWith(".json")) return "json";
  if (file.endsWith(".md")) return "md";
  if (file.endsWith(".mdc")) return "mdc";
  return "other";
};
