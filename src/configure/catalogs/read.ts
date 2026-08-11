/**
 * Read live setting values for a harness catalogue (best-effort, secrets redacted).
 */

import { join } from "node:path";
import { exists, expandPath, readFile } from "../../fs.js";
import type { HarnessCatalog, ResolvedSettingValue } from "./types.js";

const SECRET_RE = /key|token|secret|password|credential|oauth|auth|apikey/i;

const isSecretKey = (key: string): boolean => SECRET_RE.test(key);

const previewValue = (key: string, value: unknown): { preview: string; redacted: boolean } => {
  if (isSecretKey(key)) return { preview: "<redacted>", redacted: true };
  if (value === null || value === undefined) return { preview: "null", redacted: false };
  if (typeof value === "string") {
    if (value.length > 80) return { preview: `${value.slice(0, 77)}…`, redacted: false };
    return { preview: value, redacted: false };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { preview: String(value), redacted: false };
  }
  if (Array.isArray(value)) {
    return { preview: `list/${value.length}`, redacted: false };
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return {
      preview: `dict/${keys.slice(0, 8).join(",")}${keys.length > 8 ? "…" : ""}`,
      redacted: false,
    };
  }
  return { preview: String(value), redacted: false };
};

const parseDocument = (format: string, text: string): unknown => {
  if (format === "json" || format === "jsonc") {
    // strip // and /* */ comments roughly for jsonc
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    return JSON.parse(stripped);
  }
  if (format === "toml") {
    return Bun.TOML.parse(text);
  }
  // yaml: return raw marker — full yaml parse not required for key walk of known fields
  if (format === "yaml") {
    try {
      // Bun may not have yaml; fall back to line map of top-level scalars
      const map: Record<string, unknown> = {};
      for (const line of text.split("\n")) {
        const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const k = m[1]!;
        let v: unknown = m[2]!.trim();
        if (v === "true") v = true;
        else if (v === "false") v = false;
        else if (typeof v === "string" && /^[0-9]+$/.test(v)) v = Number(v);
        else if (typeof v === "string" && (v.startsWith('"') || v.startsWith("'"))) {
          v = v.slice(1, -1);
        }
        map[k] = v;
      }
      return map;
    } catch {
      return {};
    }
  }
  return {};
};

const getPath = (doc: unknown, dotted: string): unknown => {
  const parts = dotted.split(".");
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
};

const loadFileDocs = async (
  root: string,
  catalog: HarnessCatalog,
): Promise<Map<string, unknown>> => {
  const byFile = new Map<string, unknown>();
  for (const sf of catalog.settingsFiles) {
    if (sf.format === "md" || sf.format === "mdc" || sf.format === "other") continue;
    const abs = sf.path.startsWith("~") || sf.path.startsWith("/")
      ? expandPath(sf.path)
      : join(root, sf.path);
    if (!(await exists(abs))) continue;
    try {
      const text = await readFile(abs);
      byFile.set(sf.path, parseDocument(sf.format, text));
    } catch {
      // skip unreadable
    }
  }
  return byFile;
};

/**
 * Resolve catalogue fields against on-disk settings for one harness root.
 */
export const readCatalogSettings = async (options: {
  readonly catalog: HarnessCatalog;
  readonly root?: string;
}): Promise<ReadonlyArray<ResolvedSettingValue>> => {
  const root = options.root ?? expandPath(options.catalog.globalRoot);
  const docs = await loadFileDocs(root, options.catalog);
  const out: ResolvedSettingValue[] = [];

  for (const field of options.catalog.fields) {
    const doc = docs.get(field.file);
    if (doc === undefined) {
      out.push({ key: field.key, present: false });
      continue;
    }
    const value = getPath(doc, field.key);
    if (value === undefined) {
      out.push({ key: field.key, present: false });
      continue;
    }
    const { preview, redacted } = previewValue(field.key, value);
    out.push({
      key: field.key,
      present: true,
      valuePreview: preview,
      redacted,
    });
  }
  return out;
};
