/**
 * Best-effort artifact metadata for the configure TUI reader pane.
 * Frontmatter via gray-matter when available; regex fallback otherwise.
 */

import { basename, dirname, extname } from "node:path";
import matter from "gray-matter";
import { exists, readFile } from "../fs.js";

export type ArtifactMeta = {
  path: string;
  title?: string;
  description?: string;
  kind: "skill" | "agent" | "command" | "markdown" | "text" | "unknown";
};

const READER_MAX_BYTES = 512 * 1024;

type ParsedFrontmatter = {
  readonly data: Record<string, unknown>;
  readonly content: string;
};

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Minimal YAML-ish key:value frontmatter parser when gray-matter fails. */
function parseFrontmatterRegex(raw: string): ParsedFrontmatter | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;
  const yamlBlock = raw.slice(3, end).replace(/^\r?\n/, "");
  const content = raw.slice(end + 4).replace(/^\r?\n/, "");
  const data: Record<string, unknown> = {};
  for (const line of yamlBlock.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, content };
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  try {
    const parsed = matter(raw);
    const data =
      parsed.data !== null &&
      typeof parsed.data === "object" &&
      !Array.isArray(parsed.data)
        ? (parsed.data as Record<string, unknown>)
        : {};
    return { data, content: parsed.content ?? "" };
  } catch {
    return parseFrontmatterRegex(raw) ?? { data: {}, content: raw };
  }
}

function firstNonEmptyParagraph(content: string): string | undefined {
  const blocks = content.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      // skip headings / horizontal rules — want body prose
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith("---") &&
          !/^#{1,6}\s/.test(line),
      );
    if (lines.length === 0) continue;
    const joined = lines.join(" ").trim();
    if (joined.length > 0) return joined;
  }
  return undefined;
}

function classifyPath(filePath: string): ArtifactMeta["kind"] {
  const base = basename(filePath);
  const lower = base.toLowerCase();
  const normalized = filePath.replace(/\\/g, "/");

  if (lower === "skill.md") return "skill";

  if (normalized.includes("/agents/") && lower.endsWith(".md")) return "agent";
  if (normalized.includes("/commands/") && lower.endsWith(".md")) return "command";
  if (lower === "agent.md" || lower.endsWith(".agent.md")) return "agent";
  if (lower === "command.md" || lower.endsWith(".command.md")) return "command";

  const ext = extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (
    ext === ".txt" ||
    ext === ".json" ||
    ext === ".toml" ||
    ext === ".yaml" ||
    ext === ".yml"
  ) {
    return "text";
  }
  return "unknown";
}

function optionalSnippet(text: string, max = 200): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/**
 * Read SKILL.md / agent.md / command.md frontmatter description via gray-matter
 * if available, else regex.
 */
export async function loadArtifactMeta(path: string): Promise<ArtifactMeta> {
  const kind = classifyPath(path);
  const base: ArtifactMeta = { path, kind };

  if (!(await exists(path))) {
    return base;
  }

  let raw: string;
  try {
    raw = await readFile(path);
  } catch {
    return base;
  }

  if (kind === "unknown") {
    return base;
  }

  if (kind === "markdown" || kind === "text") {
    return {
      ...base,
      title: basename(path),
      description: optionalSnippet(raw, 200),
    };
  }

  const { data, content } = parseFrontmatter(raw);
  const description =
    asNonEmptyString(data.description) ?? firstNonEmptyParagraph(content);
  const nameFromFm = asNonEmptyString(data.name);

  if (kind === "skill") {
    return {
      path,
      kind,
      title: nameFromFm ?? basename(dirname(path)),
      description,
    };
  }

  return {
    path,
    kind,
    title: nameFromFm ?? basename(path, extname(path)),
    description,
  };
}

/** Best-effort batch for a list of paths (skip missing). */
export async function loadArtifactMetas(
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<ArtifactMeta>> {
  const out: ArtifactMeta[] = [];
  for (const path of paths) {
    if (!(await exists(path))) continue;
    out.push(await loadArtifactMeta(path));
  }
  return out;
}

/**
 * Read full text of a file for the reader pane; max ~512KB, else truncated with note.
 */
export async function loadTextForReader(
  path: string,
): Promise<{ path: string; text: string; truncated: boolean; error?: string }> {
  if (!(await exists(path))) {
    return {
      path,
      text: "",
      truncated: false,
      error: "File not found",
    };
  }

  try {
    const raw = await readFile(path);
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes <= READER_MAX_BYTES) {
      return { path, text: raw, truncated: false };
    }
    let end = Math.min(raw.length, READER_MAX_BYTES);
    while (end > 0 && Buffer.byteLength(raw.slice(0, end), "utf8") > READER_MAX_BYTES) {
      end -= 1;
    }
    const head = raw.slice(0, end);
    const note = `\n\n… [truncated: showing first ~${READER_MAX_BYTES} bytes of ${bytes}]\n`;
    return { path, text: head + note, truncated: true };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      path,
      text: "",
      truncated: false,
      error: message,
    };
  }
}
