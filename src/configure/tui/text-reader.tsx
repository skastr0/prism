/**
 * Scrollable text reader — pure presentational pane for file bodies.
 * Parent owns scroll state and keyboard; this only windows lines.
 *
 * Long source lines are word-wrapped into the pane width (no ellipsis).
 * Scroll indexes visual (wrapped) lines, not raw file lines.
 */

import { ATTR, PALETTE, truncate, wordWrap } from "../../plugins-tui/theme.js";

export type TextReaderProps = {
  title: string;
  path: string;
  text: string;
  truncated?: boolean;
  scroll: number; // visual-line offset
  height: number; // visible rows
  width: number;
  focused?: boolean;
};

/** Expand file text into display lines that fit `width` columns. */
export function wrapReaderLines(text: string, width: number): ReadonlyArray<string> {
  const budget = Math.max(8, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    // Empty source line → blank visual row
    if (raw.length === 0) {
      out.push("");
      continue;
    }
    // wordWrap never ellipsizes; hard-breaks oversize tokens
    const wrapped = wordWrap(raw, budget);
    for (const visual of wrapped.split("\n")) {
      out.push(visual);
    }
  }
  return out.length > 0 ? out : [""];
}

/** Clamp scroll so last page still shows content. */
export function clampReaderScroll(scroll: number, lineCount: number, height: number): number {
  const view = Math.max(0, height);
  const maxScroll = Math.max(0, lineCount - view);
  if (!Number.isFinite(scroll)) return 0;
  return Math.max(0, Math.min(Math.floor(scroll), maxScroll));
}

function Line({ content, fg }: { readonly content: string; readonly fg?: string }) {
  return (
    <box style={{ height: 1, width: "100%", flexDirection: "row" }}>
      <text content={content.length > 0 ? content : " "} style={{ fg: fg ?? PALETTE.fg, wrapMode: "none" }} />
    </box>
  );
}

export function TextReader(props: TextReaderProps) {
  const { title, path, text, truncated = false, scroll, height, width, focused = false } = props;

  const lineBudget = Math.max(8, width - 2);
  const visualLines = wrapReaderLines(text, lineBudget);
  const headerRows = 1;
  const warnRows = truncated ? 1 : 0;
  const bodyRows = Math.max(0, height - headerRows - warnRows);
  const start = clampReaderScroll(scroll, visualLines.length, bodyRows);
  const visible = visualLines.slice(start, start + bodyRows);

  // Header can still truncate path (chrome only — body never ellipsizes)
  const titleShown = truncate(title, Math.max(8, Math.min(40, width)));
  const pathBudget = Math.max(8, width - Bun.stringWidth(titleShown) - 3);
  const pathShown = truncate(path, pathBudget);

  const titleFg = focused ? PALETTE.fgBright : PALETTE.fgMuted;
  const end = Math.min(visualLines.length, start + visible.length);
  const pos =
    visualLines.length === 0
      ? ""
      : `  ${start + 1}-${end}/${visualLines.length}`;

  return (
    <box
      style={{
        flexDirection: "column",
        height,
        width: "100%",
        backgroundColor: PALETTE.bg,
      }}
    >
      <box style={{ height: 1, flexDirection: "row", width: "100%" }}>
        <text style={{ wrapMode: "none" }}>
          <span fg={titleFg} attributes={ATTR.bold}>
            {titleShown}
          </span>
          <span fg={PALETTE.fgDim}>{`  ${pathShown}${pos}`}</span>
        </text>
      </box>
      {truncated ? (
        <Line
          content="! file body capped at reader size limit (content continues on disk)"
          fg={PALETTE.warnSoft}
        />
      ) : null}
      {visible.map((line, i) => (
        <Line key={start + i} content={line} fg={PALETTE.fg} />
      ))}
    </box>
  );
}
