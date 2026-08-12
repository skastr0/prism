/**
 * Pure markdown edit helpers for the configure inline editor.
 * No I/O — unit-tested transforms applied via textarea APIs.
 */

export type TextRange = {
  readonly start: number; // inclusive, character offset
  readonly end: number; // exclusive
};

export type EditResult = {
  readonly text: string;
  /** Selection after edit (or collapsed caret). */
  readonly selection: TextRange;
};

export const lineBoundsAt = (
  text: string,
  offset: number,
): { readonly start: number; readonly end: number; readonly line: string } => {
  const o = Math.max(0, Math.min(offset, text.length));
  const start = text.lastIndexOf("\n", o - 1) + 1;
  let end = text.indexOf("\n", o);
  if (end === -1) end = text.length;
  return { start, end, line: text.slice(start, end) };
};

/** Wrap range with open/close markers; toggle off if already wrapped. */
export const wrapOrUnwrap = (
  text: string,
  range: TextRange,
  open: string,
  close: string = open,
): EditResult => {
  const start = Math.max(0, Math.min(range.start, range.end, text.length));
  const end = Math.max(start, Math.min(Math.max(range.start, range.end), text.length));
  const selected = text.slice(start, end);

  // Toggle off when selection already includes markers or sits between them
  if (
    selected.startsWith(open) &&
    selected.endsWith(close) &&
    selected.length >= open.length + close.length
  ) {
    const inner = selected.slice(open.length, selected.length - close.length);
    const next = text.slice(0, start) + inner + text.slice(end);
    return {
      text: next,
      selection: { start, end: start + inner.length },
    };
  }

  // Expand to markers if caret/selection is inside already-wrapped run
  const before = text.slice(Math.max(0, start - open.length), start);
  const after = text.slice(end, end + close.length);
  if (before === open && after === close) {
    const outerStart = start - open.length;
    const outerEnd = end + close.length;
    const next = text.slice(0, outerStart) + selected + text.slice(outerEnd);
    return {
      text: next,
      selection: { start: outerStart, end: outerStart + selected.length },
    };
  }

  if (selected.length === 0) {
    const insert = open + close;
    const next = text.slice(0, start) + insert + text.slice(end);
    const caret = start + open.length;
    return { text: next, selection: { start: caret, end: caret } };
  }

  const wrapped = open + selected + close;
  const next = text.slice(0, start) + wrapped + text.slice(end);
  return {
    text: next,
    selection: { start: start + open.length, end: start + open.length + selected.length },
  };
};

export const toggleBold = (text: string, range: TextRange): EditResult =>
  wrapOrUnwrap(text, range, "**");

export const toggleItalic = (text: string, range: TextRange): EditResult =>
  wrapOrUnwrap(text, range, "*");

/** Wrap as [label](url). Empty selection → [text](url) with "text" selected. */
export const wrapLink = (text: string, range: TextRange, url = "url"): EditResult => {
  const start = Math.max(0, Math.min(range.start, range.end, text.length));
  const end = Math.max(start, Math.min(Math.max(range.start, range.end), text.length));
  const selected = text.slice(start, end);
  const label = selected.length > 0 ? selected : "text";
  const insert = `[${label}](${url})`;
  const next = text.slice(0, start) + insert + text.slice(end);
  if (selected.length > 0) {
    // Select the URL so operator can type it immediately
    const urlStart = start + 1 + label.length + 2; // [label](
    return {
      text: next,
      selection: { start: urlStart, end: urlStart + url.length },
    };
  }
  // Select "text" label placeholder
  return {
    text: next,
    selection: { start: start + 1, end: start + 1 + label.length },
  };
};

/**
 * Set ATX header level on the current line (1–6). Level 0 strips heading markers.
 * Preserves indent.
 */
export const setLineHeading = (
  text: string,
  offset: number,
  level: number,
): EditResult => {
  const { start, end, line } = lineBoundsAt(text, offset);
  const indent = /^(\s*)/.exec(line)?.[1] ?? "";
  const body = line.slice(indent.length).replace(/^#{1,6}\s+/u, "");
  const lvl = Math.max(0, Math.min(6, Math.floor(level)));
  const nextLine =
    lvl === 0 ? `${indent}${body}` : `${indent}${"#".repeat(lvl)} ${body}`;
  const next = text.slice(0, start) + nextLine + text.slice(end);
  const caret = start + nextLine.length;
  return { text: next, selection: { start: caret, end: caret } };
};

export type ListContinue =
  | { readonly kind: "continue"; readonly prefix: string }
  | { readonly kind: "exit" }
  | { readonly kind: "none" };

/**
 * Decide what Enter should do on a list line.
 * - empty bullet/number item → exit list (blank line)
 * - non-empty → continue with same bullet or next number
 */
export const listContinueOnEnter = (line: string): ListContinue => {
  const bullet = /^(\s*)([-*+])\s+(.*)$/u.exec(line);
  if (bullet) {
    const indent = bullet[1] ?? "";
    const mark = bullet[2] ?? "-";
    const rest = bullet[3] ?? "";
    if (rest.trim().length === 0) return { kind: "exit" };
    return { kind: "continue", prefix: `${indent}${mark} ` };
  }
  const numbered = /^(\s*)(\d+)\.\s+(.*)$/u.exec(line);
  if (numbered) {
    const indent = numbered[1] ?? "";
    const n = Number(numbered[2]);
    const rest = numbered[3] ?? "";
    if (rest.trim().length === 0) return { kind: "exit" };
    if (!Number.isFinite(n)) return { kind: "none" };
    return { kind: "continue", prefix: `${indent}${n + 1}. ` };
  }
  return { kind: "none" };
};

/**
 * Apply Enter on the current line: may insert list continuation or exit list.
 * Returns null when the default newline should stand.
 */
export const applyEnterList = (
  text: string,
  offset: number,
): EditResult | null => {
  const { start, end, line } = lineBoundsAt(text, offset);
  // Only special-case when caret is at/after end of line content (typical list typing)
  const col = offset - start;
  if (col < line.length) return null;

  const action = listContinueOnEnter(line);
  if (action.kind === "none") return null;

  if (action.kind === "exit") {
    // Replace empty list marker line with blank
    const next = text.slice(0, start) + text.slice(end);
    // If there was a trailing newline after end, keep structure: insert blank line
    const withBlank =
      end < text.length && text[end] === "\n"
        ? text.slice(0, start) + "\n" + text.slice(end + 1)
        : text.slice(0, start) + (start > 0 ? "\n" : "") + text.slice(end);
    // Simpler: empty the list line and leave caret on it
    const emptyLine = line.match(/^(\s*)/)?.[1] ?? "";
    const simplified = text.slice(0, start) + emptyLine + text.slice(end);
    const caret = start + emptyLine.length;
    return { text: simplified, selection: { start: caret, end: caret } };
  }

  const insert = `\n${action.prefix}`;
  const next = text.slice(0, offset) + insert + text.slice(offset);
  const caret = offset + insert.length;
  return { text: next, selection: { start: caret, end: caret } };
};

/** Ensure a line starts with `- ` (bullet). Toggle off if already a bullet. */
export const toggleBulletLine = (text: string, offset: number): EditResult => {
  const { start, end, line } = lineBoundsAt(text, offset);
  const indent = /^(\s*)/.exec(line)?.[1] ?? "";
  const rest = line.slice(indent.length);
  let nextLine: string;
  if (/^[-*+]\s+/u.test(rest)) {
    nextLine = indent + rest.replace(/^[-*+]\s+/u, "");
  } else if (/^\d+\.\s+/u.test(rest)) {
    nextLine = indent + rest.replace(/^\d+\.\s+/u, "- ");
  } else {
    nextLine = `${indent}- ${rest}`;
  }
  const next = text.slice(0, start) + nextLine + text.slice(end);
  const caret = start + nextLine.length;
  return { text: next, selection: { start: caret, end: caret } };
};

/** Ensure a line starts with `1. ` or renumber from 1. Toggle off numbered. */
export const toggleNumberedLine = (text: string, offset: number): EditResult => {
  const { start, end, line } = lineBoundsAt(text, offset);
  const indent = /^(\s*)/.exec(line)?.[1] ?? "";
  const rest = line.slice(indent.length);
  let nextLine: string;
  if (/^\d+\.\s+/u.test(rest)) {
    nextLine = indent + rest.replace(/^\d+\.\s+/u, "");
  } else if (/^[-*+]\s+/u.test(rest)) {
    nextLine = indent + rest.replace(/^[-*+]\s+/u, "1. ");
  } else {
    nextLine = `${indent}1. ${rest}`;
  }
  const next = text.slice(0, start) + nextLine + text.slice(end);
  const caret = start + nextLine.length;
  return { text: next, selection: { start: caret, end: caret } };
};
