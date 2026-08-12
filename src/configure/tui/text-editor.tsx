/**
 * Small file editor for configure TUI — OpenTUI <textarea>, not vim.
 * Word-wrap on, mouse focus, type to edit, ctrl/cmd+s save, esc cancel.
 */

import type { TextareaRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { ATTR, PALETTE, truncate } from "../../plugins-tui/theme.js";

export type TextFileEditorProps = {
  readonly title: string;
  readonly path: string;
  readonly text: string;
  readonly height: number;
  readonly width: number;
  readonly focused?: boolean;
  readonly saving?: boolean;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
};

export function TextFileEditor(props: TextFileEditorProps) {
  const {
    title,
    path,
    text,
    height,
    width,
    focused = true,
    saving = false,
    onSave,
    onCancel,
  } = props;

  const ref = useRef<TextareaRenderable | null>(null);
  const [dirty, setDirty] = useState(false);
  // Re-mount textarea when path/text baseline changes so initialValue applies cleanly
  const editorKey = `${path}:${text.length}:${text.slice(0, 32)}`;

  useEffect(() => {
    setDirty(false);
  }, [path, text]);

  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused, editorKey]);

  const titleShown = truncate(title, Math.max(8, Math.min(28, width)));
  const pathBudget = Math.max(8, width - Bun.stringWidth(titleShown) - 28);
  const pathShown = truncate(path, pathBudget);
  const bodyH = Math.max(3, height - 2);

  const save = (): void => {
    const next = ref.current?.plainText ?? text;
    onSave(next);
  };

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
          <span fg={PALETTE.accentBright} attributes={ATTR.bold}>
            {`✎ ${titleShown}`}
          </span>
          <span fg={dirty ? PALETTE.yellow : PALETTE.fgDim}>
            {dirty ? "  · modified" : "  · clean"}
          </span>
          <span fg={PALETTE.fgDim}>{`  ${pathShown}`}</span>
        </text>
      </box>
      <box
        style={{
          height: bodyH,
          width: "100%",
          border: true,
          borderColor: focused ? PALETTE.borderActive : PALETTE.borderInactive,
          flexGrow: 0,
        }}
      >
        <textarea
          key={editorKey}
          ref={ref}
          initialValue={text}
          focused={focused}
          wrapMode="word"
          showCursor
          textColor={PALETTE.fg}
          backgroundColor={PALETTE.bg}
          focusedTextColor={PALETTE.fgBright}
          focusedBackgroundColor={PALETTE.bg}
          cursorColor={PALETTE.accent}
          style={{ width: "100%", height: "100%" }}
          onContentChange={() => setDirty(true)}
          onKeyDown={(event) => {
            // Save: ctrl+s / cmd+s
            if ((event.ctrl || event.meta) && event.name === "s") {
              event.preventDefault();
              save();
              return;
            }
            // Cancel: esc (don't leave dirty trap without explicit cancel)
            if (event.name === "escape") {
              event.preventDefault();
              onCancel();
            }
          }}
        />
      </box>
      <box style={{ height: 1, flexDirection: "row", width: "100%" }}>
        <text style={{ wrapMode: "none" }}>
          <span fg={PALETTE.fgDim}>
            {saving
              ? "saving…"
              : "ctrl/cmd+s save  ·  esc cancel  ·  mouse click to place cursor  ·  word-wrap on"}
          </span>
        </text>
      </box>
    </box>
  );
}
