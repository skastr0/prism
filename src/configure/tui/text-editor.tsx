/**
 * Small file editor for configure TUI — OpenTUI <textarea>, not vim.
 * Word-wrap, mouse, save, clipboard, basic markdown hotkeys.
 */

import type { CliRenderer, KeyEvent, TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { ATTR, PALETTE, truncate } from "../../plugins-tui/theme.js";
import { readClipboard, writeClipboard } from "./clipboard.js";
import {
  applyEnterList,
  setLineHeading,
  toggleBold,
  toggleBulletLine,
  toggleItalic,
  toggleNumberedLine,
  wrapLink,
  type EditResult,
  type TextRange,
} from "./markdown-edit.js";

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

const selectionOf = (ta: TextareaRenderable): TextRange => {
  const sel = ta.getSelection();
  if (sel && sel.end > sel.start) {
    return { start: sel.start, end: sel.end };
  }
  const o = ta.cursorOffset;
  return { start: o, end: o };
};

const applyEdit = (ta: TextareaRenderable, result: EditResult): void => {
  ta.setText(result.text);
  const { start, end } = result.selection;
  if (end > start) {
    ta.setSelection(start, end);
  } else {
    ta.cursorOffset = start;
    ta.clearSelection();
  }
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

  const renderer = useRenderer() as CliRenderer | null;
  const ref = useRef<TextareaRenderable | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const editorKey = `${path}:${text.length}:${text.slice(0, 32)}`;

  useEffect(() => {
    setDirty(false);
    setHint(null);
    if (hintTimerRef.current) {
      clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
  }, [path, text]);

  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused, editorKey]);

  useEffect(() => {
    return () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    };
  }, []);

  const titleShown = truncate(title, Math.max(8, Math.min(28, width)));
  const pathBudget = Math.max(8, width - Bun.stringWidth(titleShown) - 28);
  const pathShown = truncate(path, pathBudget);
  const bodyH = Math.max(3, height - 2);

  const save = (): void => {
    const next = ref.current?.plainText ?? text;
    onSave(next);
  };

  /** Transient status (copied/pasted/…) — auto-clears so the help line returns. */
  const HINT_MS = 1_500;
  const flash = (msg: string): void => {
    setHint(msg);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => {
      setHint(null);
      hintTimerRef.current = null;
    }, HINT_MS);
  };

  const withTa = (fn: (ta: TextareaRenderable) => void): void => {
    const ta = ref.current;
    if (!ta) return;
    fn(ta);
    setDirty(true);
  };

  const copySelection = async (): Promise<void> => {
    const ta = ref.current;
    if (!ta) return;
    const selected = ta.getSelectedText();
    if (!selected) {
      flash("nothing selected");
      return;
    }
    const ok = await writeClipboard(selected, renderer);
    flash(ok ? "copied" : "copy failed");
  };

  const cutSelection = async (): Promise<void> => {
    const ta = ref.current;
    if (!ta) return;
    const selected = ta.getSelectedText();
    if (!selected) {
      flash("nothing selected");
      return;
    }
    const ok = await writeClipboard(selected, renderer);
    if (ok) {
      ta.deleteSelection();
      setDirty(true);
      flash("cut");
    } else {
      flash("cut failed (clipboard)");
    }
  };

  const pasteClipboard = async (): Promise<void> => {
    const ta = ref.current;
    if (!ta) return;
    const clip = await readClipboard();
    if (clip === null) {
      flash("paste failed (clipboard)");
      return;
    }
    if (ta.hasSelection()) ta.deleteSelection();
    ta.insertText(clip);
    setDirty(true);
    flash("pasted");
  };

  const onKeyDown = (event: KeyEvent): void => {
    const mod = event.ctrl || event.meta;
    const ta = ref.current;

    // Save
    if (mod && event.name === "s" && !event.shift) {
      event.preventDefault();
      save();
      return;
    }

    // Cancel
    if (event.name === "escape") {
      event.preventDefault();
      onCancel();
      return;
    }

    // Clipboard: cmd/ctrl+c / x / v  (D also paste — user request alias)
    if (mod && event.name === "c" && !event.shift) {
      event.preventDefault();
      void copySelection();
      return;
    }
    if (mod && event.name === "x" && !event.shift) {
      event.preventDefault();
      void cutSelection();
      return;
    }
    if (mod && (event.name === "v" || event.name === "d") && !event.shift) {
      event.preventDefault();
      void pasteClipboard();
      return;
    }

    // Markdown: bold / italic / link
    if (mod && event.name === "b" && !event.shift) {
      event.preventDefault();
      withTa((t) => applyEdit(t, toggleBold(t.plainText, selectionOf(t))));
      return;
    }
    if (mod && event.name === "i" && !event.shift) {
      event.preventDefault();
      withTa((t) => applyEdit(t, toggleItalic(t.plainText, selectionOf(t))));
      return;
    }
    if (mod && event.name === "k" && !event.shift) {
      event.preventDefault();
      withTa((t) => applyEdit(t, wrapLink(t.plainText, selectionOf(t))));
      return;
    }

    // Headers: cmd/ctrl+1..6, cmd/ctrl+0 strips
    if (mod && event.name && /^[0-6]$/u.test(event.name)) {
      event.preventDefault();
      const level = Number(event.name);
      withTa((t) => applyEdit(t, setLineHeading(t.plainText, t.cursorOffset, level)));
      return;
    }

    // Lists: cmd/ctrl+shift+8 bullet, cmd/ctrl+shift+7 numbered
    // (shift+8 is often "*", shift+7 is "&" — use name when available)
    if (mod && event.shift && (event.name === "8" || event.raw === "*" || event.name === "*")) {
      event.preventDefault();
      withTa((t) => applyEdit(t, toggleBulletLine(t.plainText, t.cursorOffset)));
      return;
    }
    if (mod && event.shift && (event.name === "7" || event.name === "&")) {
      event.preventDefault();
      withTa((t) => applyEdit(t, toggleNumberedLine(t.plainText, t.cursorOffset)));
      return;
    }
    // Easier aliases: cmd/ctrl+l bullet, cmd/ctrl+shift+l numbered
    if (mod && event.name === "l" && !event.shift) {
      event.preventDefault();
      withTa((t) => applyEdit(t, toggleBulletLine(t.plainText, t.cursorOffset)));
      return;
    }
    if (mod && event.name === "l" && event.shift) {
      event.preventDefault();
      withTa((t) => applyEdit(t, toggleNumberedLine(t.plainText, t.cursorOffset)));
      return;
    }

    // Enter continues lists
    if (event.name === "return" && !event.shift && ta) {
      const result = applyEnterList(ta.plainText, ta.cursorOffset);
      if (result) {
        event.preventDefault();
        applyEdit(ta, result);
        setDirty(true);
      }
    }
  };

  const footer =
    hint ??
    (saving
      ? "saving…"
      : "^s save  ^c/x/v copy cut paste  ^b/i/k bold italic link  ^1-6 heading  ^l list  enter continues list");

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
          selectable
          textColor={PALETTE.fg}
          backgroundColor={PALETTE.bg}
          focusedTextColor={PALETTE.fgBright}
          focusedBackgroundColor={PALETTE.bg}
          selectionBg={PALETTE.selBg}
          cursorColor={PALETTE.accent}
          style={{ width: "100%", height: "100%" }}
          onContentChange={() => setDirty(true)}
          onKeyDown={onKeyDown}
        />
      </box>
      <box style={{ height: 1, flexDirection: "row", width: "100%" }}>
        <text style={{ wrapMode: "none" }}>
          <span fg={hint ? PALETTE.ok : PALETTE.fgDim}>{truncate(footer, Math.max(20, width - 2))}</span>
        </text>
      </box>
    </box>
  );
}
