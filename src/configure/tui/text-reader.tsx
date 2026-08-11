/**
 * Scrollable text reader — pure presentational pane for file bodies.
 * Parent owns scroll state and keyboard; this only windows lines.
 */

import { ATTR, PALETTE, truncate } from "../../plugins-tui/theme.js";

export type TextReaderProps = {
  title: string;
  path: string;
  text: string;
  truncated?: boolean;
  scroll: number; // line offset
  height: number; // visible rows
  width: number;
  focused?: boolean;
};

/** Clamp scroll so last page still shows content. */
export function clampReaderScroll(scroll: number, lineCount: number, height: number): number {
  const view = Math.max(0, height);
  const maxScroll = Math.max(0, lineCount - view);
  if (!Number.isFinite(scroll)) return 0;
  return Math.max(0, Math.min(Math.floor(scroll), maxScroll));
}

function Line({ content, fg }: { readonly content: string; readonly fg?: string }) {
  return (
    <box style={{ height: 1, width: "100%" }}>
      <text content={content} style={{ fg: fg ?? PALETTE.fg, wrapMode: "none" }} />
    </box>
  );
}

export function TextReader(props: TextReaderProps) {
  const { title, path, text, truncated = false, scroll, height, width, focused = false } = props;

  const lines = text.split("\n");
  const headerRows = 1;
  const warnRows = truncated ? 1 : 0;
  const bodyRows = Math.max(0, height - headerRows - warnRows);
  const start = clampReaderScroll(scroll, lines.length, bodyRows);
  const visible = lines.slice(start, start + bodyRows);

  const lineBudget = Math.max(1, width - 2);
  const titleShown = truncate(title, Math.max(8, Math.min(40, width)));
  const pathBudget = Math.max(8, width - Bun.stringWidth(titleShown) - 3);
  const pathShown = truncate(path, pathBudget);

  const titleFg = focused ? PALETTE.fgBright : PALETTE.fgMuted;

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
          <span fg={PALETTE.fgDim}>{`  ${pathShown}`}</span>
        </text>
      </box>
      {truncated ? (
        <Line content={truncate("! truncated — content exceeds read limit", lineBudget)} fg={PALETTE.warnSoft} />
      ) : null}
      {visible.map((line, i) => (
        <Line key={start + i} content={truncate(line, lineBudget)} fg={PALETTE.fg} />
      ))}
    </box>
  );
}
