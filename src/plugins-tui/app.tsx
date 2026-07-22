/**
 * Plugins TUI — open prism in a folder, inspect every plugin's per-harness
 * install state, deep-introspect what it creates, and refresh with live
 * per-file progress. Mirrors the mount scaffold of `src/workflow-tui.tsx`.
 *
 * Interaction model: a focus toggle between the plugin list (left) and the
 * detail browser (right). Tab cycles the detail view; →/Enter dives into an
 * enterable tab (Introspect/Doctor); ←/Esc returns to the list. Mouse clicks
 * select rows, switch tabs, and pick entries/findings via real hit-testing.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exitWith } from "../exit.js";
import { expandPath } from "../fs.js";
import { readManifest } from "../manifest.js";
import type { DoctorReport } from "../doctor.js";
import type {
  CellState,
  HarnessScope,
  InstallPreview,
  IntrospectionResult,
  LogEntry,
  LogStatus,
  PluginManifest,
  PluginPlan,
  PluginRow,
} from "./model.js";
import { ATTR, PALETTE, clamp, colorJsonLine, jsonBlock, marchMask, spinnerFrame, truncate } from "./theme.js";
import { harnessMark } from "./harness-meta.js";
import { classifyHarness, rollupStates, stateColor, stateGlyph, stateLabel } from "./status.js";
import { buildPreview } from "./preview.js";
import { applyRefresh, loadPluginRows } from "./data.js";
import { getDoctor, getIntrospection, getPlan, invalidatePlugin } from "./cache.js";

export interface PluginsTuiOptions {
  readonly dir?: string;
  readonly projectPath?: string;
  readonly pollMs?: number;
}

type Tab = "preview" | "status" | "introspect" | "doctor";
type Focus = "list" | "detail";
type Confirm = "refresh" | "refresh-all" | null;

const TABS: ReadonlyArray<Tab> = ["preview", "status", "introspect", "doctor"];
const ENTERABLE: ReadonlySet<Tab> = new Set<Tab>(["introspect", "doctor"]);
/** Subtle row-selection background. */
const SEL_BG = PALETTE.selBg;

/** Syntax-colored JSON (one <text> per line; opentui ships no json grammar). */
function JsonView({ content }: { readonly content: string }) {
  return (
    <box style={{ flexDirection: "column" }}>
      {content.split("\n").map((line, i) => (
        <text key={i} style={{ wrapMode: "none" }}>
          {colorJsonLine(line).map((token, j) => (
            <span key={j} fg={token.color}>
              {token.text}
            </span>
          ))}
        </text>
      ))}
    </box>
  );
}

const gitRootOf = (start: string): string => {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
};

type ScopedPlan = { readonly scope: HarnessScope; readonly projectPath?: string; readonly plan: PluginPlan };

interface SelectionState {
  readonly pluginPath: string;
  readonly manifest?: PluginManifest;
  readonly manifestError?: string;
  readonly preview?: InstallPreview;
  readonly plans: ReadonlyArray<ScopedPlan>;
  readonly loading: boolean;
}

type Lazy<T> = { readonly path: string; readonly value: T } | null;

/** Minimal shape of an opentui mouse-scroll event. */
type ScrollEvt = { readonly scroll?: { readonly direction?: string } };
const scrollDelta = (event: ScrollEvt): number =>
  event?.scroll?.direction === "up" ? -1 : event?.scroll?.direction === "down" ? 1 : 0;

const errMsg = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** A slice of `items` centered on `cursor`, so the cursor stays visible and a
 *  long list never overflows its pane (which would bleed into the next column). */
const windowAround = <T,>(
  items: ReadonlyArray<T>,
  cursor: number,
  size: number,
): { readonly slice: ReadonlyArray<{ readonly item: T; readonly index: number }>; readonly above: number; readonly below: number } => {
  const len = items.length;
  const start = len <= size ? 0 : clamp(cursor - Math.floor(size / 2), 0, len - size);
  const end = len <= size ? len : start + size;
  return {
    slice: items.slice(start, end).map((item, i) => ({ item, index: start + i })),
    above: start,
    below: len - end,
  };
};

const LIST_WINDOW = 24;

// ── Plugin list (left) ──────────────────────────────────────────────────────

function PluginList({
  rows,
  worstByPath,
  selectedIndex,
  focused,
  windowSize,
  width,
  onSelect,
}: {
  readonly rows: ReadonlyArray<PluginRow>;
  readonly worstByPath: ReadonlyMap<string, CellState>;
  readonly selectedIndex: number;
  readonly focused: boolean;
  readonly windowSize: number;
  readonly width: number;
  readonly onSelect: (index: number) => void;
}) {
  const win = windowAround(rows, selectedIndex, windowSize);
  const nameMax = Math.max(10, width - 8);
  return (
    <box
      title={`Plugins (${selectedIndex + 1}/${rows.length})`}
      onMouseScroll={(event: ScrollEvt) => {
        const delta = scrollDelta(event);
        if (delta !== 0) onSelect(selectedIndex + delta);
      }}
      style={{
        width,
        height: "100%",
        border: true,
        borderColor: focused ? PALETTE.borderActive : PALETTE.borderInactive,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: PALETTE.bg,
      }}
    >
      {rows.length === 0
        ? [<text key="empty" content="(no plugins here)" style={{ fg: PALETTE.fgDim }} />]
        : [
            win.above > 0 ? <text key="up" content={`  +${win.above} more above`} style={{ fg: PALETTE.fgDim }} /> : null,
            ...win.slice.map(({ item: row, index }) => {
              const selected = index === selectedIndex;
              const worst: CellState = row.valid ? worstByPath.get(row.pluginPath) ?? "n/a" : "error";
              const marker = row.valid ? stateGlyph(worst) : "!";
              const hard = !row.valid || worst === "error" || worst === "blocked";
              const markerColor = hard
                ? PALETTE.red
                : worst === "drifted"
                  ? PALETTE.orange
                  : marker
                    ? PALETTE.yellow
                    : PALETTE.fgDim;
              const nameColor = selected
                ? PALETTE.fgBright
                : hard
                  ? PALETTE.red
                  : worst === "drifted"
                    ? PALETTE.orange
                    : worst === "stale" || worst === "orphaned"
                      ? PALETTE.yellow
                      : worst === "n/a"
                        ? PALETTE.fgDim
                        : PALETTE.fg;
              return (
                <box
                  key={row.pluginPath}
                  onMouseDown={() => onSelect(index)}
                  style={{ height: 1, flexDirection: "row", ...(selected ? { backgroundColor: SEL_BG } : {}) }}
                >
                  <text>
                    <span fg={selected ? PALETTE.fgBright : PALETTE.fgDim}>{selected ? "› " : "  "}</span>
                    <span fg={markerColor}>{marker ? `${marker} ` : "  "}</span>
                    <span fg={nameColor}>{truncate(row.name, nameMax)}</span>
                  </text>
                </box>
              );
            }),
            win.below > 0 ? <text key="dn" content={`  +${win.below} more below`} style={{ fg: PALETTE.fgDim }} /> : null,
          ]}
    </box>
  );
}

// ── Tab bar (clickable) ─────────────────────────────────────────────────────

function TabBar({ tab, onPick }: { readonly tab: Tab; readonly onPick: (tab: Tab) => void }) {
  return (
    <box style={{ flexDirection: "row" }}>
      {TABS.map((candidate) => (
        <text key={candidate} onMouseDown={() => onPick(candidate)} style={{ marginRight: 1 }}>
          <span fg={candidate === tab ? PALETTE.accentBright : PALETTE.fgDim} attributes={candidate === tab ? ATTR.bold : 0}>
            {candidate === tab ? `[${candidate}]` : ` ${candidate} `}
          </span>
        </text>
      ))}
    </box>
  );
}

// ── Preview ───────────────────────────────────────────────────────────────────

function PreviewContent({ selection }: { readonly selection: SelectionState }) {
  if (selection.manifestError) {
    return <text content={`! invalid manifest:\n${selection.manifestError}`} style={{ fg: PALETTE.danger, wrapMode: "word" }} />;
  }
  const preview = selection.preview;
  if (!preview) return <text content={selection.loading ? "loading…" : "-"} style={{ fg: PALETTE.fgDim }} />;
  const allHarnesses = [...new Set(preview.rows.flatMap((row) => row.harnesses))];
  return (
    <box style={{ flexDirection: "column" }}>
      <text>
        <span fg={PALETTE.fgMuted} attributes={ATTR.bold}>{"INSTALLS"}</span>
      </text>
      <box style={{ height: 1 }} />
      {preview.rows.map((row) => (
        <text key={row.noun} style={{ wrapMode: "none" }}>
          <span fg={PALETTE.fg}>{`  ${row.noun.padEnd(11)}`}</span>
          <span fg={row.phase === "compile" ? PALETTE.warnSoft : PALETTE.fgDim}>{row.phase.padEnd(9)}</span>
          {row.harnesses.map((harness) => {
            const mark = harnessMark(harness);
            return (
              <span key={harness} fg={mark.color}>
                {`${mark.glyph} `}
              </span>
            );
          })}
        </text>
      ))}
      {preview.inlineSkills.length > 0 ? (
        <text style={{ marginTop: 1 }}>
          <span fg={PALETTE.fgMuted}>{"inline skills  "}</span>
          <span fg={PALETTE.fg}>{preview.inlineSkills.join(", ")}</span>
        </text>
      ) : null}
      <box style={{ height: 1 }} />
      <text>
        <span fg={PALETTE.fgMuted} attributes={ATTR.bold}>{"HARNESSES"}</span>
      </text>
      {allHarnesses.map((harness) => {
        const mark = harnessMark(harness);
        return (
          <text key={harness}>
            <span fg={mark.color}>{`  ${mark.glyph} `}</span>
            <span fg={PALETTE.fg}>{harness}</span>
          </text>
        );
      })}
    </box>
  );
}

// ── Status matrix ──────────────────────────────────────────────────────────────

function StatusContent({ selection }: { readonly selection: SelectionState }) {
  if (selection.manifestError) {
    return <text content={`! invalid manifest:\n${selection.manifestError}`} style={{ fg: PALETTE.red, wrapMode: "word" }} />;
  }
  if (selection.plans.length === 0) {
    return <text content={selection.loading ? "probing harnesses…" : "-"} style={{ fg: PALETTE.fgDim }} />;
  }
  return (
    <box style={{ flexDirection: "column" }}>
      {selection.plans.map(({ scope, projectPath, plan }) => (
        <box key={`${scope}:${projectPath ?? ""}`} style={{ flexDirection: "column", marginBottom: 1 }}>
          <text>
            <span fg={PALETTE.fgMuted} attributes={ATTR.bold}>{scope.toUpperCase()}</span>
            <span fg={PALETTE.fgDim}>{projectPath ? ` ${truncate(projectPath, 38)}` : ""}</span>
          </text>
          {plan.harnesses.length === 0 ? (
            <text content="  (no targeted harnesses)" style={{ fg: PALETTE.fgDim }} />
          ) : (
            plan.harnesses.map((harnessPlan) => {
              const cell = classifyHarness(harnessPlan);
              const counts = Object.entries(cell.opCounts)
                .map(([kind, n]) => `${kind}=${n}`)
                .join(" ");
              return (
                <text key={harnessPlan.harness}>
                  <span fg={stateColor(cell.state)}>{`  ${stateGlyph(cell.state) || " "} `}</span>
                  <span fg={harnessMark(harnessPlan.harness).color}>{`${harnessMark(harnessPlan.harness).glyph} `}</span>
                  <span fg={PALETTE.fg}>{harnessPlan.harness.padEnd(16)}</span>
                  <span fg={stateColor(cell.state)}>{stateLabel(cell.state).padEnd(14)}</span>
                  <span fg={PALETTE.fgDim}>{counts}</span>
                  {cell.detail ? <span fg={PALETTE.orange}>{`  ${truncate(cell.detail, 46)}`}</span> : <span>{" "}</span>}
                </text>
              );
            })
          )}
        </box>
      ))}
    </box>
  );
}

// ── Introspect (group | entries | detail) ───────────────────────────────────────

function IntrospectContent({
  path,
  introspection,
  cursor,
  paneWidth,
  onPickEntry,
  onScroll,
}: {
  readonly path: string;
  readonly introspection: Lazy<IntrospectionResult>;
  readonly cursor: number;
  readonly paneWidth: number;
  readonly onPickEntry: (flatIndex: number) => void;
  readonly onScroll: (delta: number) => void;
}) {
  if (!introspection || introspection.path !== path) {
    return <text content="loading registry…" style={{ fg: PALETTE.fgDim }} />;
  }
  const result = introspection.value;
  if (!result.ok) {
    return (
      <text
        content={`registry load failed:\n${result.error.headline}\n${(result.error.detail ?? []).join("\n")}`}
        style={{ fg: PALETTE.red, wrapMode: "word" }}
      />
    );
  }
  const groups = result.value.groups;
  if (groups.length === 0) {
    return (
      <text
        content="(nothing compiled — this plugin defines no agents / tools / orbits / skills / hooks)"
        style={{ fg: PALETTE.fgDim, wrapMode: "word" }}
      />
    );
  }
  const flat = groups.flatMap((group, gi) => group.entries.map((entry, ei) => ({ gi, ei, group, entry })));
  const at = flat[clamp(cursor, 0, flat.length - 1)]!;
  const baseOffset = groups.slice(0, at.gi).reduce((n, group) => n + group.entries.length, 0);
  const activeEntries = groups[at.gi]!.entries;
  const entry = at.entry;
  // Responsive: drop the groups column when the pane is narrow; shrink entries.
  const threeCol = paneWidth >= 76;
  const entriesW = paneWidth >= 70 ? 24 : paneWidth >= 50 ? 20 : 16;
  const entryNameMax = Math.max(8, entriesW - 4);
  return (
    <box
      onMouseScroll={(event: ScrollEvt) => {
        const delta = scrollDelta(event);
        if (delta !== 0) onScroll(delta);
      }}
      style={{ flexDirection: "row", height: "100%" }}
    >
      {threeCol ? (
        <box style={{ width: 18, flexDirection: "column", marginRight: 1 }}>
          {groups.map((group, gi) => (
            <text key={group.noun}>
              <span fg={gi === at.gi ? PALETTE.cyan : PALETTE.fgDim}>{gi === at.gi ? "› " : "  "}</span>
              <span fg={gi === at.gi ? PALETTE.fgBright : PALETTE.fg}>{`${group.noun} (${group.count})`}</span>
            </text>
          ))}
          <text content={`orbit-skills ${result.value.orbitSkillCount}`} style={{ fg: PALETTE.fgDim, marginTop: 1 }} />
        </box>
      ) : null}
      <box style={{ width: entriesW, flexDirection: "column", marginRight: 1 }}>
        {!threeCol ? (
          <box style={{ height: 1 }}>
            <text content={`${at.group.noun} (${at.gi + 1}/${groups.length})`} style={{ fg: PALETTE.cyan }} />
          </box>
        ) : null}
        {(() => {
          const win = windowAround(activeEntries, at.ei, LIST_WINDOW);
          return [
            win.above > 0 ? <text key="up" content={`  +${win.above}`} style={{ fg: PALETTE.fgDim }} /> : null,
            ...win.slice.map(({ item: candidate, index: ei }) => {
              const selected = ei === at.ei;
              return (
                <box
                  key={candidate.name}
                  onMouseDown={() => onPickEntry(baseOffset + ei)}
                  style={{ height: 1, flexDirection: "row", ...(selected ? { backgroundColor: SEL_BG } : {}) }}
                >
                  <text>
                    <span fg={selected ? PALETTE.fgBright : PALETTE.fg}>{`${selected ? "› " : "  "}${truncate(candidate.name, entryNameMax)}`}</span>
                  </text>
                </box>
              );
            }),
            win.below > 0 ? <text key="dn" content={`  +${win.below}`} style={{ fg: PALETTE.fgDim }} /> : null,
          ];
        })()}
      </box>
      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1 }}>
        <box style={{ height: 1 }}>
          <text content={truncate(entry.name, 60)} style={{ fg: PALETTE.accentBright, attributes: ATTR.bold }} />
        </box>
        {entry.summary ? (
          <box style={{ marginBottom: 1 }}>
            <text content={entry.summary} style={{ fg: PALETTE.fg, wrapMode: "word" }} />
          </box>
        ) : null}
        <box style={{ flexGrow: 1, backgroundColor: PALETTE.surfaceInset }}>
          <scrollbox scrollY={true} style={{ width: "100%", height: "100%" }}>
            <JsonView content={jsonBlock(entry.json, 2_000)} />
          </scrollbox>
        </box>
      </box>
    </box>
  );
}

// ── Doctor (findings list | detail) ──────────────────────────────────────────────

function DoctorContent({
  path,
  doctor,
  cursor,
  paneWidth,
  onPickFinding,
  onScroll,
}: {
  readonly path: string;
  readonly doctor: Lazy<DoctorReport>;
  readonly cursor: number;
  readonly paneWidth: number;
  readonly onPickFinding: (index: number) => void;
  readonly onScroll: (delta: number) => void;
}) {
  if (!doctor || doctor.path !== path) {
    return <text content="running doctor…" style={{ fg: PALETTE.fgDim }} />;
  }
  const findings = doctor.value.findings;
  if (findings.length === 0) return <text content="✓ healthy — no findings" style={{ fg: PALETTE.green }} />;
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const at = clamp(cursor, 0, findings.length - 1);
  const active = findings[at]!;
  // Responsive: shrink the findings list at narrow widths so detail keeps room.
  const listW = paneWidth >= 96 ? 46 : paneWidth >= 64 ? 36 : 26;
  const msgMax = Math.max(8, listW - 16);
  return (
    <box
      onMouseScroll={(event: ScrollEvt) => {
        const delta = scrollDelta(event);
        if (delta !== 0) onScroll(delta);
      }}
      style={{ flexDirection: "column", height: "100%" }}
    >
      <text
        content={`${findings.length} findings — ${errors} error · ${warnings} warning`}
        style={{ fg: errors > 0 ? PALETTE.red : warnings > 0 ? PALETTE.yellow : PALETTE.green }}
      />
      <box style={{ flexDirection: "row", marginTop: 1 }}>
        <box style={{ width: listW, flexDirection: "column", marginRight: 1 }}>
          {(() => {
            const win = windowAround(findings, at, LIST_WINDOW);
            return [
              win.above > 0 ? <text key="up" content={`  +${win.above}`} style={{ fg: PALETTE.fgDim }} /> : null,
              ...win.slice.map(({ item: finding, index }) => {
                const color =
                  finding.severity === "error" ? PALETTE.red : finding.severity === "warning" ? PALETTE.yellow : PALETTE.fgDim;
                const selected = index === at;
                return (
                  <box
                    key={index}
                    onMouseDown={() => onPickFinding(index)}
                    style={{ height: 1, flexDirection: "row", ...(selected ? { backgroundColor: SEL_BG } : {}) }}
                  >
                    <text>
                      <span fg={color}>{`${selected ? "›" : " "}${finding.severity[0]!.toUpperCase()} `}</span>
                      <span fg={PALETTE.fgDim}>{finding.harness ? `${finding.harness} ` : ""}</span>
                      <span fg={PALETTE.fg}>{truncate(finding.message, msgMax)}</span>
                    </text>
                  </box>
                );
              }),
              win.below > 0 ? <text key="dn" content={`  +${win.below}`} style={{ fg: PALETTE.fgDim }} /> : null,
            ];
          })()}
        </box>
        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          <text content={`${active.family} · ${active.severity}`} style={{ fg: PALETTE.purple }} />
          {active.harness ? <text content={`harness: ${active.harness}`} style={{ fg: PALETTE.fgDim }} /> : null}
          {active.path ? <text content={`path: ${truncate(active.path, 60)}`} style={{ fg: PALETTE.fgDim }} /> : null}
          <text content={active.message} style={{ fg: PALETTE.detail, wrapMode: "word", marginTop: 1 }} />
          {active.fix ? <text content={`→ fix: ${active.fix}`} style={{ fg: PALETTE.cyan, marginTop: 1 }} /> : null}
        </box>
      </box>
    </box>
  );
}

// ── Detail pane ──────────────────────────────────────────────────────────────────

function DetailPane({
  tab,
  focused,
  selection,
  introspection,
  doctor,
  introCursor,
  doctorCursor,
  paneWidth,
  onPick,
  onPickEntry,
  onPickFinding,
  onScrollIntrospect,
  onScrollDoctor,
}: {
  readonly tab: Tab;
  readonly focused: boolean;
  readonly selection: SelectionState | null;
  readonly introspection: Lazy<IntrospectionResult>;
  readonly doctor: Lazy<DoctorReport>;
  readonly introCursor: number;
  readonly doctorCursor: number;
  readonly paneWidth: number;
  readonly onPick: (tab: Tab) => void;
  readonly onPickEntry: (index: number) => void;
  readonly onPickFinding: (index: number) => void;
  readonly onScrollIntrospect: (delta: number) => void;
  readonly onScrollDoctor: (delta: number) => void;
}) {
  const title = selection ? truncate(selection.pluginPath.split("/").pop() ?? "plugin", 36) : "Detail";
  // Introspect lays out its own columns; the others scroll.
  const body =
    selection === null ? (
      <text content="select a plugin" style={{ fg: PALETTE.fgDim }} />
    ) : tab === "introspect" ? (
      <IntrospectContent
        path={selection.pluginPath}
        introspection={introspection}
        cursor={introCursor}
        paneWidth={paneWidth}
        onPickEntry={onPickEntry}
        onScroll={onScrollIntrospect}
      />
    ) : tab === "doctor" ? (
      <DoctorContent
        path={selection.pluginPath}
        doctor={doctor}
        cursor={doctorCursor}
        paneWidth={paneWidth}
        onPickFinding={onPickFinding}
        onScroll={onScrollDoctor}
      />
    ) : (
      <scrollbox scrollY={true} style={{ width: "100%", height: "100%" }}>
        {tab === "preview" ? <PreviewContent selection={selection} /> : <StatusContent selection={selection} />}
      </scrollbox>
    );
  return (
    <box
      title={title}
      style={{
        flexGrow: 1,
        border: true,
        borderColor: focused ? PALETTE.borderActive : PALETTE.borderInactive,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: PALETTE.bg,
      }}
    >
      <TabBar tab={tab} onPick={onPick} />
      <box style={{ height: 1 }} />
      {body}
    </box>
  );
}

// ── Live refresh log ──────────────────────────────────────────────────────────

const logColor = (status: LogStatus): string => {
  if (status === "applied") return PALETTE.green;
  if (status === "failed" || status === "blocked") return PALETTE.red;
  if (status === "running") return PALETTE.cyan;
  return PALETTE.fgDim;
};
const logGlyph = (status: LogStatus): string => {
  if (status === "applied") return "✓";
  if (status === "failed") return "x";
  if (status === "blocked") return "!";
  if (status === "running") return "…";
  return "·";
};

/** Animated "working" scan-line: a 2-cell cyan comet gliding over a dim-indigo
 *  rule, run-length encoded so it's a handful of spans, not one per cell. */
function MarchLine({ width, tick }: { readonly width: number; readonly tick: number }) {
  const mask = marchMask(Math.min(width, 160), tick);
  const runs: Array<{ lit: boolean; len: number }> = [];
  for (const lit of mask) {
    const last = runs[runs.length - 1];
    if (last && last.lit === lit) last.len += 1;
    else runs.push({ lit, len: 1 });
  }
  return (
    <text style={{ wrapMode: "none" }}>
      {runs.map((run, i) => (
        <span key={i} fg={run.lit ? PALETTE.running : PALETTE.accentDim}>
          {"─".repeat(run.len)}
        </span>
      ))}
    </text>
  );
}

function LogPane({
  log,
  busy,
  tick,
  width,
}: {
  readonly log: ReadonlyArray<LogEntry>;
  readonly busy: boolean;
  readonly tick: number;
  readonly width: number;
}) {
  const ordered = [...log].slice(-300).reverse();
  return (
    <box
      title={busy ? `refresh log ${spinnerFrame(tick)}` : "refresh log"}
      style={{
        height: "35%",
        width: "100%",
        border: true,
        borderColor: busy ? PALETTE.borderActive : PALETTE.borderInactive,
        flexDirection: "column",
        paddingLeft: 1,
        backgroundColor: PALETTE.bg,
      }}
    >
      {busy ? <MarchLine width={width} tick={tick} /> : null}
      <scrollbox scrollY={true} style={{ width: "100%", height: "100%" }}>
        {ordered.length === 0 ? (
          <text content="(idle — r refresh selected · a refresh all)" style={{ fg: PALETTE.fgDim }} />
        ) : (
          ordered.map((entry) => (
            <text key={entry.id} style={{ wrapMode: "none", truncate: true }}>
              <span fg={logColor(entry.status)}>{`${logGlyph(entry.status)} `}</span>
              <span fg={PALETTE.fgDim}>{entry.harness ? `${entry.harness} ` : ""}</span>
              <span fg={PALETTE.fgDim}>{`${entry.kind} `}</span>
              <span fg={PALETTE.fg}>{truncate(entry.targetPath, 70)}</span>
              {entry.error ? <span fg={PALETTE.red}>{`  ${truncate(entry.error, 50)}`}</span> : <span>{" "}</span>}
            </text>
          ))
        )}
      </scrollbox>
    </box>
  );
}

// ── Footer (context-aware hints) ────────────────────────────────────────────────

function Footer({
  focus,
  tab,
  scopeProject,
  busy,
  confirm,
  error,
}: {
  readonly focus: Focus;
  readonly tab: Tab;
  readonly scopeProject: boolean;
  readonly busy: boolean;
  readonly confirm: Confirm;
  readonly error: string | null;
}) {
  const hints: ReadonlyArray<readonly [string, string]> =
    focus === "detail"
      ? tab === "introspect"
        ? [["j/k", "entry"], ["esc", "back"], ["tab", "view"], ["r", "refresh"], ["q", "quit"]]
        : tab === "doctor"
          ? [["j/k", "finding"], ["esc", "back"], ["tab", "view"], ["r", "refresh"], ["q", "quit"]]
          : [["esc", "back"], ["tab", "view"], ["q", "quit"]]
      : [
          ["j/k", "move"],
          ["enter", "open"],
          ["tab", "view"],
          ["d", "doctor"],
          ["r", "refresh"],
          ["a", "all"],
          ["p", `project ${scopeProject ? "on" : "off"}`],
          ["q", "quit"],
        ];
  // Row-of-texts (the proven TabBar pattern) — one <text> per hint, never a
  // flatMap span-array inside a single <text> (that produced null text chunks).
  const content =
    confirm !== null ? (
      <text
        content={
          confirm === "refresh-all"
            ? "refresh all plugins (writes to harness configs)?   enter confirm · esc cancel"
            : "refresh selected plugin (writes to harness configs)?   enter confirm · esc cancel"
        }
        style={{ width: "100%", fg: PALETTE.danger, wrapMode: "none", truncate: true }}
      />
    ) : error !== null ? (
      <text content={`error · ${truncate(error, 110)}`} style={{ width: "100%", fg: PALETTE.danger, wrapMode: "none", truncate: true }} />
    ) : (
      <box style={{ flexDirection: "row" }}>
        {hints.map(([key, desc]) => (
          <text key={key} style={{ marginRight: 2 }}>
            <span fg={PALETTE.accent} attributes={ATTR.bold}>{key}</span>
            <span fg={PALETTE.fgDim}>{` ${desc}`}</span>
          </text>
        ))}
        {busy ? (
          <text>
            <span fg={PALETTE.running}>{"· working"}</span>
          </text>
        ) : null}
      </box>
    );
  return (
    <box style={{ height: 2, width: "100%", border: ["top"], borderColor: PALETTE.borderInactive, paddingLeft: 1 }}>
      {content}
    </box>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

export function PluginsApp({
  dir,
  projectPath,
  pollMs: _pollMs,
}: {
  readonly dir: string;
  readonly projectPath: string;
  readonly pollMs?: number;
}) {
  const renderer = useRenderer();
  const { width: termWidth, height: termHeight } = useTerminalDimensions();
  // List is the full-height left column (the log is under the DETAIL, not the
  // list). Its rows = terminal height minus footer (2) + list borders (2) + the
  // two "+N more" markers (2).
  const listWindow = Math.max(6, termHeight - 6);
  // Responsive widths: list scales with terminal; detail pane gets the rest.
  const listWidth = clamp(Math.round(termWidth * 0.26), 26, 40);
  const paneWidth = Math.max(20, termWidth - listWidth - 4);
  const [rows, setRows] = useState<ReadonlyArray<PluginRow>>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [tab, setTab] = useState<Tab>("preview");
  const [focus, setFocus] = useState<Focus>("list");
  const [introCursor, setIntroCursor] = useState(0);
  const [doctorCursor, setDoctorCursor] = useState(0);
  const [scopeProject, setScopeProject] = useState(true);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [introspection, setIntrospection] = useState<Lazy<IntrospectionResult>>(null);
  const [doctor, setDoctor] = useState<Lazy<DoctorReport>>(null);
  const [worstByPath, setWorstByPath] = useState<ReadonlyMap<string, CellState>>(new Map());
  const [log, setLog] = useState<ReadonlyArray<LogEntry>>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // One shared animation clock — ticks ONLY while something is working, so an
  // idle TUI does zero animation re-renders (herdr's "animate only on need").
  const [tick, setTick] = useState(0);
  const animating = busy || (selection?.loading ?? false);
  useEffect(() => {
    if (!animating) return;
    const id = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(id);
  }, [animating]);
  const spinner = animating ? spinnerFrame(tick) : "…";

  const scopes = useMemo<ReadonlyArray<{ scope: HarnessScope; projectPath?: string }>>(
    () =>
      scopeProject
        ? [{ scope: "global" as const }, { scope: "project" as const, projectPath }]
        : [{ scope: "global" as const }],
    [scopeProject, projectPath],
  );

  const selectedRow = rows[selectedIndex] ?? null;
  const selectedPath = selectedRow?.pluginPath ?? null;

  const harnessKey = useMemo(
    () => (selection?.plans ?? []).flatMap(({ plan }) => plan.harnesses.map((entry) => entry.harness)).join(","),
    [selection],
  );

  const fail = (cause: unknown): void => setError(errMsg(cause));

  // Reset per-tab cursors + focus whenever the selected plugin changes.
  useEffect(() => {
    setIntroCursor(0);
    setDoctorCursor(0);
    setFocus("list");
  }, [selectedPath]);

  useEffect(() => {
    let live = true;
    loadPluginRows({ dir })
      .then((loaded) => {
        if (!live) return;
        setRows(loaded);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (live) fail(cause);
      });
    return () => {
      live = false;
    };
  }, [dir]);


  // Manifest + preview + per-scope status (cached, cancellable).
  useEffect(() => {
    if (selectedRow === null) {
      setSelection(null);
      return;
    }
    let live = true;
    const pluginPath = selectedRow.pluginPath;
    setSelection({ pluginPath, plans: [], loading: true });
    void (async () => {
      try {
        const manifest = await readManifest(pluginPath);
        if (!live) return;
        const preview = buildPreview(manifest);
        const plans: ScopedPlan[] = [];
        for (const probe of scopes) {
          const plan = await getPlan(pluginPath, probe.scope, probe.projectPath);
          if (!live) return;
          plans.push({ scope: probe.scope, ...(probe.projectPath ? { projectPath: probe.projectPath } : {}), plan });
          // Render each scope as it lands — global shows first, project fills in.
          setSelection({ pluginPath, manifest, preview, plans: [...plans], loading: plans.length < scopes.length });
        }
        if (!live) return;
        setWorstByPath((current) =>
          new Map(current).set(
            pluginPath,
            rollupStates(plans.flatMap(({ plan }) => plan.harnesses.map((hp) => classifyHarness(hp).state))),
          ),
        );
      } catch (cause) {
        if (!live) return;
        setSelection({ pluginPath, manifestError: errMsg(cause), plans: [], loading: false });
        setWorstByPath((current) => new Map(current).set(pluginPath, "error"));
      }
    })();
    return () => {
      live = false;
    };
  }, [selectedRow, scopes, reloadKey]);

  // Lazy introspection (cached), path-keyed.
  useEffect(() => {
    if (selectedPath === null || tab !== "introspect") return;
    if (introspection && introspection.path === selectedPath) return;
    let live = true;
    getIntrospection(selectedPath)
      .then((value) => {
        if (live) setIntrospection({ path: selectedPath, value });
      })
      .catch(fail);
    return () => {
      live = false;
    };
  }, [tab, selectedPath, reloadKey, introspection]);

  // Lazy doctor (cached), sourced from the loaded harness set.
  useEffect(() => {
    if (selectedPath === null || tab !== "doctor") return;
    if (selectedRow === null || !selectedRow.valid) return;
    if (doctor && doctor.path === selectedPath) return;
    const plans = selection?.pluginPath === selectedPath ? selection.plans : [];
    const probe = plans[0];
    if (probe === undefined || probe.plan.harnesses.length === 0) return;
    let live = true;
    getDoctor(selectedPath, probe.scope, probe.projectPath)
      .then((value) => {
        if (live) setDoctor({ path: selectedPath, value });
      })
      .catch(fail);
    return () => {
      live = false;
    };
  }, [tab, selectedPath, reloadKey, harnessKey, doctor, selectedRow, selection]);

  const introGroups =
    introspection && introspection.path === selectedPath && introspection.value.ok
      ? introspection.value.value.groups
      : [];
  const introEntryCount = introGroups.reduce((n, group) => n + group.entries.length, 0);
  const doctorFindingCount =
    doctor && doctor.path === selectedPath ? doctor.value.findings.length : 0;

  const runRefresh = (targets: ReadonlyArray<PluginRow>): void => {
    setBusy(true);
    setLog([]);
    const append = (entry: LogEntry): void => setLog((current) => [...current, entry]);
    let counter = 0;
    void (async () => {
      try {
        for (const row of targets) {
          if (!row.valid) continue;
          const manifest = await readManifest(row.pluginPath);
          for (const probe of scopes) {
            await applyRefresh({
              pluginPath: row.pluginPath,
              manifest,
              scope: probe.scope,
              ...(probe.projectPath ? { projectPath: probe.projectPath } : {}),
              onOp: (op, outcome, opError) =>
                append({
                  id: `${row.name}-${probe.scope}-${counter++}`,
                  targetPath: op.targetPath,
                  kind: op.kind,
                  status: outcome,
                  ...(opError ? { error: opError } : {}),
                }),
            });
          }
        }
        setError(null);
      } catch (cause) {
        fail(cause);
      } finally {
        await Promise.all(targets.map((row) => invalidatePlugin(row.pluginPath, scopes)));
        setBusy(false);
        setIntrospection(null);
        setDoctor(null);
        setReloadKey((key) => key + 1);
      }
    })();
  };

  const selectRow = (index: number): void => {
    setSelectedIndex(clamp(index, 0, Math.max(0, rows.length - 1)));
    setFocus("list");
  };

  useKeyboard((key) => {
    if (confirm !== null) {
      if (key.name === "escape") setConfirm(null);
      if (key.name === "return") {
        const action = confirm;
        setConfirm(null);
        if (action === "refresh" && selectedRow) runRefresh([selectedRow]);
        if (action === "refresh-all") runRefresh(rows);
      }
      return;
    }
    if (key.name === "q") {
      renderer?.destroy();
      exitWith(0);
    }
    if (key.name === "tab") {
      setTab((current) => TABS[(TABS.indexOf(current) + 1) % TABS.length]!);
      setFocus("list");
      return;
    }
    if (key.name === "p") {
      setScopeProject((current) => !current);
      return;
    }
    if (key.name === "d") {
      setTab("doctor");
      setFocus("detail");
      return;
    }
    if (key.name === "r" && selectedRow?.valid) {
      setConfirm("refresh");
      return;
    }
    if (key.name === "a") {
      setConfirm("refresh-all");
      return;
    }

    const move = key.name === "up" || key.name === "k" ? -1 : key.name === "down" || key.name === "j" ? 1 : 0;

    if (focus === "list") {
      if ((key.name === "return" || key.name === "right" || key.name === "l") && ENTERABLE.has(tab)) {
        setFocus("detail");
        return;
      }
      if (move !== 0) selectRow(selectedIndex + move);
      return;
    }

    // focus === "detail"
    if (key.name === "escape" || key.name === "left" || key.name === "h") {
      setFocus("list");
      return;
    }
    if (move !== 0) {
      if (tab === "introspect") {
        setIntroCursor((index) => clamp(index + move, 0, Math.max(0, introEntryCount - 1)));
      } else if (tab === "doctor") {
        setDoctorCursor((index) => clamp(index + move, 0, Math.max(0, doctorFindingCount - 1)));
      }
    }
  });

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: PALETTE.bg }}>
      <box style={{ width: "100%", flexGrow: 1, flexDirection: "row" }}>
        <PluginList
          rows={rows}
          worstByPath={worstByPath}
          selectedIndex={selectedIndex}
          focused={focus === "list"}
          windowSize={listWindow}
          width={listWidth}
          onSelect={selectRow}
        />
        <box style={{ flexGrow: 1, height: "100%", flexDirection: "column" }}>
          <DetailPane
            tab={tab}
            focused={focus === "detail"}
            selection={selection}
            introspection={introspection}
            doctor={doctor}
            introCursor={introCursor}
            doctorCursor={doctorCursor}
            paneWidth={paneWidth}
            onPick={(next) => {
              setTab(next);
              setFocus(ENTERABLE.has(next) ? "detail" : "list");
            }}
            onPickEntry={(index) => {
              setIntroCursor(index);
              setFocus("detail");
            }}
            onPickFinding={(index) => {
              setDoctorCursor(index);
              setFocus("detail");
            }}
            onScrollIntrospect={(delta) => {
              setFocus("detail");
              setIntroCursor((index) => clamp(index + delta, 0, Math.max(0, introEntryCount - 1)));
            }}
            onScrollDoctor={(delta) => {
              setFocus("detail");
              setDoctorCursor((index) => clamp(index + delta, 0, Math.max(0, doctorFindingCount - 1)));
            }}
          />
          <LogPane log={log} busy={busy} tick={tick} width={paneWidth} />
        </box>
      </box>
      <Footer focus={focus} tab={tab} scopeProject={scopeProject} busy={busy} confirm={confirm} error={error} />
    </box>
  );
}

export const runPluginsTui = async (options: PluginsTuiOptions = {}): Promise<void> => {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const dir = expandPath(options.dir ?? process.cwd());
  const projectPath = options.projectPath ? expandPath(options.projectPath) : gitRootOf(process.cwd());
  createRoot(renderer).render(<PluginsApp dir={dir} projectPath={projectPath} />);
};
