/**
 * Configure TUI — inspect Prism-managed harness inventory, project/profile
 * scopes, memories, and uninstall plugins / delete owned or stray paths.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { exitWith } from "../../exit.js";
import { harnessMark } from "../../plugins-tui/harness-meta.js";
import { ATTR, PALETTE, clamp, spinnerFrame, truncate, wordWrap } from "../../plugins-tui/theme.js";
import {
  artifactsForPlugin,
  groupsForPlugin,
  groupsForSection,
  loadConfigureInventory,
} from "../inventory.js";
import type {
  ArtifactEntry,
  ArtifactGroup,
  ConfigFileEntry,
  ConfigureInventory,
  HarnessPresence,
  HarnessSummary,
  MutationPlan,
  OwnershipKind,
  PluginSummary,
  ProfileInventory,
  ProfileSummary,
  ProjectInventory,
  SectionId,
} from "../model.js";
import {
  planDeleteOwnedFile,
  planDeleteStrayPath,
  planUninstallPlugin,
} from "../mutations.js";
import { planSetSetting } from "../settings-apply.js";
import { loadTextForReader } from "../metadata.js";
import { getHarnessCatalog } from "../catalogs/index.js";
import { exists, readFile, writeFile } from "../../fs.js";
import {
  findNavIndex,
  navBackFromNavFocus,
  popTrail,
  viewFromNavItem,
  type ConfigureNavItem,
  type ConfigureView,
} from "./nav.js";
import { TextFileEditor } from "./text-editor.js";
import { TextReader, clampReaderScroll, wrapReaderLines } from "./text-reader.js";

/** Soft cap for inline edits — huge files belong in a real editor. */
const EDIT_MAX_BYTES = 2 * 1024 * 1024;

export interface ConfigureTuiOptions {
  readonly projectPath?: string;
}

type Focus = "nav" | "detail";
type View = ConfigureView;

type ConfirmAction =
  | {
      readonly kind: "uninstall";
      readonly plugin: string;
      readonly plan: MutationPlan;
    }
  | {
      readonly kind: "delete";
      readonly targetPath: string;
      readonly ownership: OwnershipKind;
      readonly plan: MutationPlan;
    }
  | {
      readonly kind: "set-setting";
      readonly key: string;
      readonly value: string | boolean | number;
      readonly message: string;
    };

type NavItem = ConfigureNavItem;

const SEL_BG = PALETTE.selBg;

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "config", label: "Config" },
  { id: "plugins", label: "Plugins" },
  { id: "skills", label: "Skills" },
  { id: "commands", label: "Commands" },
  { id: "agents", label: "Agents" },
  { id: "hooks", label: "Hooks" },
  { id: "rules", label: "Rules" },
  { id: "bundles", label: "Bundles" },
  { id: "identity", label: "Identity" },
  { id: "memories", label: "Memories" },
  { id: "other", label: "Other" },
];

/** Sections shown under a Hermes profile (harness-equivalent, no agents/commands noise). */
const PROFILE_SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "config", label: "Config" },
  { id: "skills", label: "Skills" },
  { id: "hooks", label: "Hooks" },
  { id: "identity", label: "Identity" },
  { id: "memories", label: "Memories" },
  { id: "other", label: "Other" },
];

/** Sections shown under a project-local harness root. */
const PROJECT_SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "config", label: "Config" },
  { id: "skills", label: "Skills" },
  { id: "memories", label: "Memories" },
  { id: "rules", label: "Rules" },
  { id: "identity", label: "Identity" },
  { id: "other", label: "Other" },
];

/** Always offer Memories on these harnesses, even when the count is still 0. */
const MEMORY_NAV_HARNESSES: ReadonlySet<string> = new Set([
  "hermes",
  "claude-code",
  "grok",
  "codex-cli",
  "openclaw",
  "omp",
]);

type ScrollEvt = { readonly scroll?: { readonly direction?: string } };
const scrollDelta = (event: ScrollEvt): number =>
  event?.scroll?.direction === "up" ? -1 : event?.scroll?.direction === "down" ? 1 : 0;

const errMsg = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const windowAround = <T,>(
  items: ReadonlyArray<T>,
  cursor: number,
  size: number,
): {
  readonly slice: ReadonlyArray<{ readonly item: T; readonly index: number }>;
  readonly above: number;
  readonly below: number;
} => {
  const len = items.length;
  const start = len <= size ? 0 : clamp(cursor - Math.floor(size / 2), 0, len - size);
  const end = len <= size ? len : start + size;
  return {
    slice: items.slice(start, end).map((item, i) => ({ item, index: start + i })),
    above: start,
    below: len - end,
  };
};

const presenceColor = (p: HarnessPresence): string => {
  if (p === "present") return PALETTE.ok;
  if (p === "snapshot-only") return PALETTE.yellow;
  return PALETTE.fgDim;
};

const ownershipGlyph = (o: OwnershipKind): { glyph: string; color: string } => {
  switch (o) {
    case "prism-owned":
      return { glyph: "●", color: PALETTE.ok };
    case "prism-region":
      return { glyph: "◐", color: PALETTE.cyan };
    case "prism-namespace":
      return { glyph: "◌", color: PALETTE.yellow };
    case "foreign":
      return { glyph: "○", color: PALETTE.fgDim };
  }
};

const identitySectionCount = (
  counts: Pick<HarnessSummary["counts"], "soul" | "identity">,
): number => (counts.soul ?? 0) + (counts.identity ?? 0);

const memoriesSectionCount = (
  summary: Pick<HarnessSummary, "counts"> | ProfileSummary,
): number => {
  const fromCounts = summary.counts.memory ?? 0;
  const fromFiles =
    "memoryFiles" in summary && Array.isArray(summary.memoryFiles)
      ? summary.memoryFiles.length
      : 0;
  return Math.max(fromCounts, fromFiles);
};

const showMemoriesSection = (harness: string, count: number): boolean =>
  count > 0 || MEMORY_NAV_HARNESSES.has(harness);

const sectionCount = (
  summary: Pick<HarnessSummary, "counts" | "plugins" | "config"> | ProfileSummary,
  section: SectionId,
): number => {
  if (section === "summary") return 0;
  if (section === "config") return summary.config?.settingsKeys.length ?? 0;
  if (section === "plugins") {
    return "plugins" in summary && Array.isArray(summary.plugins) ? summary.plugins.length : 0;
  }
  if (section === "skills") return summary.counts.skill;
  if (section === "commands") return summary.counts.command;
  if (section === "agents") return summary.counts.agent;
  if (section === "hooks") return summary.counts.hook;
  if (section === "rules") return summary.counts.rules;
  if (section === "bundles") return summary.counts.bundle;
  if (section === "identity") {
    return identitySectionCount(summary.counts);
  }
  if (section === "memories") {
    return memoriesSectionCount(summary);
  }
  if (section === "other") return summary.counts.other + summary.counts["tool-runtime"];
  return 0;
};

const findArtifact = (
  artifacts: ReadonlyArray<ArtifactEntry>,
  id: string,
): ArtifactEntry | undefined => artifacts.find((a) => a.id === id);

const findGroup = (
  groups: ReadonlyArray<ArtifactGroup>,
  id: string,
): ArtifactGroup | undefined => groups.find((g) => g.id === id);

// ── Nav (left) ────────────────────────────────────────────────────────────────

function NavList({
  items,
  selectedIndex,
  focused,
  windowSize,
  width,
  onSelect,
}: {
  readonly items: ReadonlyArray<NavItem>;
  readonly selectedIndex: number;
  readonly focused: boolean;
  readonly windowSize: number;
  readonly width: number;
  readonly onSelect: (index: number) => void;
}) {
  const win = windowAround(items, selectedIndex, windowSize);
  const nameMax = Math.max(8, width - 6);
  return (
    <box
      title="Configure"
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
      {win.above > 0 ? <text key="up" content={`  +${win.above} more`} style={{ fg: PALETTE.fgDim }} /> : null}
      {win.slice.map(({ item, index }) => {
        const selected = index === selectedIndex;
        const indent =
          item.kind === "harness"
            ? ""
            : item.kind === "profile" || item.kind === "project"
              ? "  "
              : item.kind === "plugin"
                ? "      "
                : item.kind === "section" && (item.profileId || item.projectId)
                  ? "    "
                  : "  ";
        const color =
          item.kind === "harness"
            ? selected
              ? PALETTE.fgBright
              : PALETTE.accentBright
            : item.kind === "profile" || item.kind === "project"
              ? selected
                ? PALETTE.fgBright
                : PALETTE.cyan
              : selected
                ? PALETTE.fgBright
                : PALETTE.fg;
        return (
          <box
            key={item.id}
            onMouseDown={() => onSelect(index)}
            style={{ height: 1, flexDirection: "row", ...(selected ? { backgroundColor: SEL_BG } : {}) }}
          >
            <text>
              <span fg={selected ? PALETTE.fgBright : PALETTE.fgDim}>{selected ? "› " : "  "}</span>
              <span fg={color}>{truncate(`${indent}${item.label}`, nameMax)}</span>
            </text>
          </box>
        );
      })}
      {win.below > 0 ? <text key="dn" content={`  +${win.below} more`} style={{ fg: PALETTE.fgDim }} /> : null}
    </box>
  );
}

// ── Detail panes ──────────────────────────────────────────────────────────────

/** One fixed-height row — multi-span flex without height:1 glues glyphs in OpenTUI. */
function Row({ content, fg }: { readonly content: string; readonly fg?: string }) {
  return (
    <box style={{ height: 1, flexDirection: "row", width: "100%" }}>
      <text content={content} style={{ fg: fg ?? PALETTE.fg, wrapMode: "none" }} />
    </box>
  );
}

/** Column budget for readable (non-ellipsis) text in the detail pane + footer. */
const WrapWidthContext = createContext(80);
const useWrapWidth = (): number => useContext(WrapWidthContext);

/**
 * Full-width text that word-wraps (no ellipsis).
 * One fixed-height row per visual line — multi-line OpenTUI <text> still
 * clips/ellipsis under flex layout; per-row <text> is the reliable path.
 */
function WrapText({
  content,
  fg,
  width: widthOverride,
}: {
  readonly content: string;
  readonly fg?: string;
  /** Optional override; defaults to WrapWidthContext (detail pane budget). */
  readonly width?: number;
}) {
  const ctxW = useWrapWidth();
  const width = Math.max(12, widthOverride ?? ctxW);
  const lines = wordWrap(content, width).split("\n");
  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      {lines.map((line, i) => (
        <box key={i} style={{ height: 1, width: "100%", flexDirection: "row" }}>
          <text content={line.length > 0 ? line : " "} style={{ fg: fg ?? PALETTE.fg, wrapMode: "none" }} />
        </box>
      ))}
    </box>
  );
}

function ConfigDetail({
  summary,
  cursor,
  windowSize,
  focused,
  onSelect,
  onScroll,
}: {
  readonly summary: HarnessSummary;
  readonly cursor: number;
  readonly windowSize: number;
  readonly focused: boolean;
  readonly onSelect: (index: number) => void;
  readonly onScroll: (delta: number) => void;
}) {
  const cfg = summary.config;
  if (!cfg) {
    return <Row content="No catalogue config for this harness." fg={PALETTE.fgDim} />;
  }
  const keyCol = 30;
  const shapeCol = 10;
  const headerLines = 4 + cfg.files.length + 2;
  const bodyHeight = Math.max(4, windowSize - headerLines);
  const win = windowAround(cfg.settingsKeys, cursor, bodyHeight);
  return (
    <box
      onMouseScroll={(event: ScrollEvt) => {
        const delta = scrollDelta(event);
        if (delta !== 0) onScroll(delta);
      }}
      style={{ flexDirection: "column", width: "100%", height: "100%" }}
    >
      <Row content="Settings  ·  enter edit enum/bool  ·  esc back" fg={PALETTE.fgBright} />
      {cfg.settingsPath ? (
        <WrapText content={`primary  ${cfg.settingsPath}`} fg={PALETTE.fgDim} />
      ) : null}
      <Row content="FILES" fg={PALETTE.fgMuted} />
      {cfg.files.map((f) => {
        const mark = f.exists ? "●" : "○";
        const size = f.sizeBytes !== undefined ? ` ${f.sizeBytes}b` : "";
        return (
          <Row
            key={f.id}
            content={`${mark} ${truncate(f.label, 18).padEnd(18)} ${f.kind.padEnd(8)} ${f.prismTouch}${size}`}
            fg={f.exists ? PALETTE.fg : PALETTE.fgDim}
          />
        );
      })}
      <Row content={`KEYS (${cfg.settingsKeys.length})  j/k select`} fg={PALETTE.fgMuted} />
      {win.above > 0 ? <Row content={`  +${win.above} more above`} fg={PALETTE.fgDim} /> : null}
      {win.slice.map(({ item: k, index }) => {
        const selected = focused && index === cursor;
        const key = truncate(k.key, keyCol - 1).padEnd(keyCol);
        const shape = truncate(k.shape, shapeCol).padEnd(shapeCol);
        const prev =
          k.shape === "absent" ? "—" : k.preview ? truncate(k.preview, 28) : "set";
        const editable = k.shape === "boolean" || k.shape === "enum";
        const line = `${selected ? "›" : " "} ${key}${shape}${prev}${editable ? "  ✎" : ""}`;
        return (
          <box
            key={k.key}
            onMouseDown={() => onSelect(index)}
            style={{
              height: 1,
              width: "100%",
              ...(selected ? { backgroundColor: SEL_BG } : {}),
            }}
          >
            <text
              content={line}
              style={{
                fg: selected ? PALETTE.fgBright : k.shape === "absent" ? PALETTE.fgDim : PALETTE.fg,
                wrapMode: "none",
              }}
            />
          </box>
        );
      })}
      {win.below > 0 ? <Row content={`  +${win.below} more below`} fg={PALETTE.fgDim} /> : null}
      {cfg.notes[0] ? <WrapText content={`· ${cfg.notes[0]}`} fg={PALETTE.fgDim} /> : null}
    </box>
  );
}

function ConfigPickDetail({
  keyName,
  options,
  current,
  cursor,
  onSelect,
}: {
  readonly keyName: string;
  readonly options: ReadonlyArray<string>;
  readonly current?: string;
  readonly cursor: number;
  readonly onSelect: (index: number) => void;
}) {
  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <Row content={`Set ${keyName}`} fg={PALETTE.fgBright} />
      <Row content="enter confirm · esc cancel" fg={PALETTE.fgDim} />
      <Row content="" />
      {options.map((opt, index) => {
        const selected = index === cursor;
        const isCur = opt === current;
        return (
          <box
            key={opt}
            onMouseDown={() => onSelect(index)}
            style={{
              height: 1,
              width: "100%",
              ...(selected ? { backgroundColor: SEL_BG } : {}),
            }}
          >
            <text
              content={`${selected ? "›" : " "} ${opt}${isCur ? "  (current)" : ""}`}
              style={{ fg: selected ? PALETTE.fgBright : PALETTE.fg, wrapMode: "none" }}
            />
          </box>
        );
      })}
    </box>
  );
}

function SummaryDetail({
  summary,
  duplicateCount,
  profileCount,
  profiles,
  projectCount,
  projects,
}: {
  readonly summary: HarnessSummary;
  readonly duplicateCount: number;
  readonly profileCount?: number;
  readonly profiles?: ReadonlyArray<ProfileInventory>;
  readonly projectCount?: number;
  readonly projects?: ReadonlyArray<ProjectInventory>;
}) {
  const mark = harnessMark(summary.harness);
  const identityN = identitySectionCount(summary.counts);
  const memoryN = memoriesSectionCount(summary);
  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <Row
        content={`${mark.glyph} ${summary.displayName}  [${summary.presence}]`}
        fg={PALETTE.fgBright}
      />
      <Row content="" />
      <WrapText content={`root    ${summary.globalRoot}`} />
      <Row content={`exists  ${summary.rootExists ? "yes" : "no"}`} />
      <WrapText
        content={`bin     ${summary.binaryPath ?? "(not found)"}`}
        fg={summary.binaryPath ? PALETTE.fg : PALETTE.fgDim}
      />
      <Row content={`snap    ${summary.snapshotEntryCount} entries`} />
      {profileCount !== undefined && profileCount > 0 ? (
        <Row content={`profiles ${profileCount}  (expand under nav)`} fg={PALETTE.cyan} />
      ) : null}
      {projectCount !== undefined && projectCount > 0 ? (
        <Row content={`projects ${projectCount}  (expand under nav)`} fg={PALETTE.cyan} />
      ) : null}
      <Row
        content={
          duplicateCount > 0
            ? `dedup   ${duplicateCount} multi-site items (⊞)`
            : "dedup   no multi-site duplicates"
        }
        fg={duplicateCount > 0 ? PALETTE.yellow : PALETTE.fg}
      />
      <Row content="" />
      <Row content="COUNTS (shared root · unique)" fg={PALETTE.fgMuted} />
      {(
        [
          ["plugins", summary.plugins.length],
          ["skills", summary.counts.skill],
          ["commands", summary.counts.command],
          ["agents", summary.counts.agent],
          ["hooks", summary.counts.hook],
          ["rules", summary.counts.rules],
          ["identity", identityN],
          ["memories", memoryN],
          ["bundles", summary.counts.bundle],
          ["other", summary.counts.other + summary.counts["tool-runtime"]],
        ] as const
      ).map(([label, n]) => (
        <Row
          key={label}
          content={`  ${label.padEnd(10)}${String(n)}`}
          fg={n === 0 ? PALETTE.fgDim : PALETTE.fg}
        />
      ))}
      {profiles && profiles.length > 0 ? (
        <>
          <Row content="" />
          <Row content={`PROFILES (${profiles.length})`} fg={PALETTE.fgMuted} />
          {profiles.slice(0, 16).map((p) => (
            <Row
              key={p.summary.id}
              content={`  ${truncate(p.summary.id, 16).padEnd(16)}  sk ${p.summary.counts.skill}  id ${identitySectionCount(p.summary.counts)}  hk ${p.summary.counts.hook}`}
              fg={PALETTE.cyan}
            />
          ))}
          {profiles.length > 16 ? (
            <Row content={`  +${profiles.length - 16} more`} fg={PALETTE.fgDim} />
          ) : null}
        </>
      ) : null}
      {projects && projects.length > 0 ? (
        <>
          <Row content="" />
          <Row content={`PROJECTS (${projects.length})`} fg={PALETTE.fgMuted} />
          {projects.slice(0, 16).map((p) => (
            <Row
              key={p.summary.id}
              content={`  ${truncate(p.summary.id, 16).padEnd(16)}  sk ${p.summary.counts.skill}  mem ${memoriesSectionCount(p.summary)}  id ${identitySectionCount(p.summary.counts)}`}
              fg={PALETTE.cyan}
            />
          ))}
          {projects.length > 16 ? (
            <Row content={`  +${projects.length - 16} more`} fg={PALETTE.fgDim} />
          ) : null}
        </>
      ) : null}
      <Row content="" />
      <Row content={`PLUGINS (${summary.plugins.length})`} fg={PALETTE.fgMuted} />
      {summary.plugins.length === 0 ? (
        <Row content="  (none)" fg={PALETTE.fgDim} />
      ) : (
        summary.plugins.slice(0, 18).map((p) => (
          <Row
            key={p.name}
            content={`  ${truncate(p.name, 28).padEnd(28)}  ${p.entryCount} entries${p.hasToolRuntime ? "  tools" : ""}`}
          />
        ))
      )}
      {summary.plugins.length > 18 ? (
        <Row content={`  +${summary.plugins.length - 18} more`} fg={PALETTE.fgDim} />
      ) : null}
    </box>
  );
}

function FileEntryRow({
  file,
  onOpen,
}: {
  readonly file: ConfigFileEntry;
  readonly onOpen?: (path: string, title: string) => void;
}) {
  const line = `  ${file.exists ? "●" : "○"} ${truncate(file.label, 22).padEnd(22)}${file.exists && file.sizeBytes !== undefined ? ` ${file.sizeBytes}b` : " —"}`;
  if (onOpen && file.exists) {
    return (
      <box
        onMouseDown={() => onOpen(file.path, file.label)}
        style={{ height: 1, width: "100%", flexDirection: "row" }}
      >
        <text content={line} style={{ fg: PALETTE.fg, wrapMode: "none" }} />
      </box>
    );
  }
  return <Row content={line} fg={file.exists ? PALETTE.fg : PALETTE.fgDim} />;
}

function ScopeSummaryDetail({
  scope,
  variant,
  duplicateCount,
  onOpenFile,
}: {
  readonly scope: ProfileInventory;
  readonly variant: "profile" | "project";
  readonly duplicateCount: number;
  readonly onOpenFile: (path: string, title: string) => void;
}) {
  const s = scope.summary;
  const identityN = identitySectionCount(s.counts);
  const memoryN = memoriesSectionCount(s);
  const memoryFiles = s.memoryFiles ?? [];
  const countRows =
    variant === "project"
      ? ([
          ["skills", s.counts.skill],
          ["memories", memoryN],
          ["rules", s.counts.rules],
          ["identity", identityN],
          ["other", s.counts.other],
        ] as const)
      : ([
          ["skills", s.counts.skill],
          ["hooks", s.counts.hook],
          ["identity", identityN],
          ["memories", memoryN],
          ["other", s.counts.other],
        ] as const);
  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <Row
        content={
          variant === "project"
            ? `▣ Project  ${s.displayName}`
            : `◎ Hermes profile  ${s.displayName}`
        }
        fg={PALETTE.fgBright}
      />
      <Row content="" />
      <WrapText content={`root    ${s.root}`} />
      {s.memoryRoot ? <WrapText content={`memory  ${s.memoryRoot}`} fg={PALETTE.fgDim} /> : null}
      <Row
        content={
          duplicateCount > 0
            ? `dedup   ${duplicateCount} multi-site items (⊞)`
            : "dedup   no multi-site duplicates"
        }
        fg={duplicateCount > 0 ? PALETTE.yellow : PALETTE.fg}
      />
      <Row content="" />
      <Row
        content={variant === "project" ? "COUNTS (project-local only)" : "COUNTS (profile-local only)"}
        fg={PALETTE.fgMuted}
      />
      {countRows.map(([label, n]) => (
        <Row
          key={label}
          content={`  ${label.padEnd(10)}${String(n)}`}
          fg={n === 0 ? PALETTE.fgDim : PALETTE.fg}
        />
      ))}
      {(s.identityFiles ?? []).length > 0 ? (
        <>
          <Row content="" />
          <Row content="IDENTITY FILES" fg={PALETTE.fgMuted} />
          {(s.identityFiles ?? []).map((f) => (
            <FileEntryRow key={f.id} file={f} onOpen={onOpenFile} />
          ))}
        </>
      ) : null}
      {memoryFiles.length > 0 ? (
        <>
          <Row content="" />
          <Row content="MEMORY FILES  ·  click / enter from Memories" fg={PALETTE.fgMuted} />
          {memoryFiles.map((f) => (
            <FileEntryRow key={f.id} file={f} onOpen={onOpenFile} />
          ))}
        </>
      ) : null}
    </box>
  );
}

function MemoryFileRows({
  files,
  cursor,
  windowSize,
  focused,
  onSelect,
  onScroll,
}: {
  readonly files: ReadonlyArray<ConfigFileEntry>;
  readonly cursor: number;
  readonly windowSize: number;
  readonly focused: boolean;
  readonly onSelect: (index: number) => void;
  readonly onScroll: (delta: number) => void;
}) {
  if (files.length === 0) {
    return <text content="(no memory files)" style={{ fg: PALETTE.fgDim }} />;
  }
  const win = windowAround(files, cursor, windowSize);
  return (
    <box
      onMouseScroll={(event: ScrollEvt) => {
        const delta = scrollDelta(event);
        if (delta !== 0) onScroll(delta);
      }}
      style={{ flexDirection: "column", height: "100%" }}
    >
      {win.above > 0 ? <text content={`  +${win.above} more above`} style={{ fg: PALETTE.fgDim }} /> : null}
      {win.slice.map(({ item, index }) => {
        const selected = focused && index === cursor;
        const size =
          item.exists && item.sizeBytes !== undefined ? `  ${item.sizeBytes}b` : item.exists ? "" : "  —";
        return (
          <box
            key={item.id}
            onMouseDown={() => onSelect(index)}
            style={{ height: 1, flexDirection: "row", ...(selected ? { backgroundColor: SEL_BG } : {}) }}
          >
            <text>
              <span fg={selected ? PALETTE.fgBright : PALETTE.fgDim}>{selected ? "› " : "  "}</span>
              <span fg={item.exists ? PALETTE.ok : PALETTE.fgDim}>{item.exists ? "● " : "○ "}</span>
              <span fg={selected ? PALETTE.fgBright : PALETTE.fg}>{truncate(item.label, 32)}</span>
              <span fg={PALETTE.fgDim}>{size}</span>
            </text>
          </box>
        );
      })}
      {win.below > 0 ? <text content={`  +${win.below} more below`} style={{ fg: PALETTE.fgDim }} /> : null}
    </box>
  );
}

function GroupRows({
  items,
  cursor,
  windowSize,
  focused,
  onSelect,
  onScroll,
}: {
  readonly items: ReadonlyArray<ArtifactGroup>;
  readonly cursor: number;
  readonly windowSize: number;
  readonly focused: boolean;
  readonly onSelect: (index: number) => void;
  readonly onScroll: (delta: number) => void;
}) {
  if (items.length === 0) {
    return <text content="(empty)" style={{ fg: PALETTE.fgDim }} />;
  }
  const win = windowAround(items, cursor, windowSize);
  return (
    <box
      onMouseScroll={(event: ScrollEvt) => {
        const delta = scrollDelta(event);
        if (delta !== 0) onScroll(delta);
      }}
      style={{ flexDirection: "column", height: "100%" }}
    >
      {win.above > 0 ? <text content={`  +${win.above} more above`} style={{ fg: PALETTE.fgDim }} /> : null}
      {win.slice.map(({ item, index }) => {
        const selected = focused && index === cursor;
        const own = ownershipGlyph(item.ownerships[0] ?? "foreign");
        const sites =
          item.isDuplicate
            ? `  ×${item.siteCount} sites`
            : item.locationCount > 1
              ? `  ${item.locationCount} files`
              : "";
        return (
          <box
            key={item.id}
            onMouseDown={() => onSelect(index)}
            style={{ height: 1, flexDirection: "row", ...(selected ? { backgroundColor: SEL_BG } : {}) }}
          >
            <text>
              <span fg={selected ? PALETTE.fgBright : PALETTE.fgDim}>{selected ? "› " : "  "}</span>
              <span fg={item.isDuplicate ? PALETTE.yellow : own.color}>
                {item.isDuplicate ? "⊞ " : `${own.glyph} `}
              </span>
              <span fg={selected ? PALETTE.fgBright : PALETTE.fg}>{truncate(item.label, 32)}</span>
              <span fg={item.isDuplicate ? PALETTE.yellow : PALETTE.fgDim}>{sites}</span>
              <span fg={PALETTE.fgDim}>
                {item.plugins.length === 1
                  ? `  ${truncate(item.plugins[0]!, 14)}`
                  : item.plugins.length > 1
                    ? `  ${item.plugins.length} plugins`
                    : ""}
              </span>
            </text>
          </box>
        );
      })}
      {win.below > 0 ? <text content={`  +${win.below} more below`} style={{ fg: PALETTE.fgDim }} /> : null}
    </box>
  );
}

function PluginRows({
  plugins,
  cursor,
  windowSize,
  focused,
  onSelect,
  onScroll,
}: {
  readonly plugins: ReadonlyArray<PluginSummary>;
  readonly cursor: number;
  readonly windowSize: number;
  readonly focused: boolean;
  readonly onSelect: (index: number) => void;
  readonly onScroll: (delta: number) => void;
}) {
  if (plugins.length === 0) {
    return <text content="(no plugins)" style={{ fg: PALETTE.fgDim }} />;
  }
  const win = windowAround(plugins, cursor, windowSize);
  return (
    <box
      onMouseScroll={(event: ScrollEvt) => {
        const delta = scrollDelta(event);
        if (delta !== 0) onScroll(delta);
      }}
      style={{ flexDirection: "column", height: "100%" }}
    >
      {win.above > 0 ? <text content={`  +${win.above} more above`} style={{ fg: PALETTE.fgDim }} /> : null}
      {win.slice.map(({ item, index }) => {
        const selected = focused && index === cursor;
        return (
          <box
            key={item.name}
            onMouseDown={() => onSelect(index)}
            style={{ height: 1, flexDirection: "row", ...(selected ? { backgroundColor: SEL_BG } : {}) }}
          >
            <text>
              <span fg={selected ? PALETTE.fgBright : PALETTE.fgDim}>{selected ? "› " : "  "}</span>
              <span fg={selected ? PALETTE.fgBright : PALETTE.fg}>{truncate(item.name, 28)}</span>
              <span fg={PALETTE.fgDim}>{`  ${item.ownedFiles} owned · ${item.regions} regions`}</span>
              {item.hasToolRuntime ? <span fg={PALETTE.cyan}>{"  tools"}</span> : null}
            </text>
          </box>
        );
      })}
      {win.below > 0 ? <text content={`  +${win.below} more below`} style={{ fg: PALETTE.fgDim }} /> : null}
    </box>
  );
}

function ArtifactDetail({ artifact }: { readonly artifact: ArtifactEntry }) {
  const own = ownershipGlyph(artifact.ownership);
  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      <text>
        <span fg={PALETTE.fgBright} attributes={ATTR.bold}>
          {artifact.label}
        </span>
      </text>
      <box style={{ height: 1 }} />
      <WrapText content={`path     ${artifact.targetPath}`} />
      <WrapText content={`relative ${artifact.relativePath}`} />
      <text>
        <span fg={PALETTE.fgMuted}>{"own      "}</span>
        <span fg={own.color}>{`${own.glyph} ${artifact.ownership}`}</span>
      </text>
      <text>
        <span fg={PALETTE.fgMuted}>{"noun     "}</span>
        <span fg={PALETTE.fg}>{artifact.noun}</span>
      </text>
      {artifact.siteKey ? (
        <text>
          <span fg={PALETTE.fgMuted}>{"site     "}</span>
          <span fg={PALETTE.fgDim}>{artifact.siteKey}</span>
        </text>
      ) : null}
      {artifact.plugin ? (
        <text>
          <span fg={PALETTE.fgMuted}>{"plugin   "}</span>
          <span fg={PALETTE.fg}>{artifact.plugin}</span>
        </text>
      ) : null}
      {artifact.regionKey ? (
        <text>
          <span fg={PALETTE.fgMuted}>{"region   "}</span>
          <span fg={PALETTE.cyan}>{artifact.regionKey}</span>
        </text>
      ) : null}
      {artifact.detail ? (
        <text>
          <span fg={PALETTE.fgMuted}>{"detail   "}</span>
          <span fg={PALETTE.fgDim}>{artifact.detail}</span>
        </text>
      ) : null}
      <box style={{ height: 1 }} />
      <text content="u uninstall plugin · d delete (owned/stray) · ← back" style={{ fg: PALETTE.fgDim }} />
    </box>
  );
}

function GroupDetail({
  group,
  cursor,
  windowSize,
  focused,
  onSelect,
  onScroll,
}: {
  readonly group: ArtifactGroup;
  readonly cursor: number;
  readonly windowSize: number;
  readonly focused: boolean;
  readonly onSelect: (index: number) => void;
  readonly onScroll: (delta: number) => void;
}) {
  const win = windowAround(group.locations, cursor, Math.max(4, windowSize - 8));
  return (
    <box style={{ flexDirection: "column", height: "100%" }}>
      <text>
        <span fg={PALETTE.fgBright} attributes={ATTR.bold}>
          {group.label}
        </span>
        <span fg={PALETTE.fgDim}>{`  ${group.noun}`}</span>
        {group.isDuplicate ? (
          <span fg={PALETTE.yellow}>{`  ⊞ ${group.siteCount} install sites`}</span>
        ) : null}
      </text>
      <text>
        <span fg={PALETTE.fgMuted}>{"key      "}</span>
        <span fg={PALETTE.fg}>{group.logicalKey}</span>
      </text>
      <text>
        <span fg={PALETTE.fgMuted}>{"files    "}</span>
        <span fg={PALETTE.fg}>{String(group.locationCount)}</span>
        <span fg={PALETTE.fgMuted}>{"  own "}</span>
        <span fg={PALETTE.fg}>{group.ownerships.join(", ")}</span>
      </text>
      {group.plugins.length > 0 ? (
        <WrapText content={`plugins  ${group.plugins.join(", ")}`} />
      ) : null}
      <box style={{ height: 1 }} />
      <text>
        <span fg={PALETTE.fgMuted} attributes={ATTR.bold}>
          {"LOCATIONS"}
        </span>
        <span fg={PALETTE.fgDim}>{"  enter open · d delete selected"}</span>
      </text>
      {win.above > 0 ? <text content={`  +${win.above} more above`} style={{ fg: PALETTE.fgDim }} /> : null}
      <box
        onMouseScroll={(event: ScrollEvt) => {
          const delta = scrollDelta(event);
          if (delta !== 0) onScroll(delta);
        }}
        style={{ flexDirection: "column", flexGrow: 1 }}
      >
        {win.slice.map(({ item, index }) => {
          const selected = focused && index === cursor;
          const own = ownershipGlyph(item.ownership);
          return (
            <box
              key={item.id}
              onMouseDown={() => onSelect(index)}
              style={{ height: 1, flexDirection: "row", ...(selected ? { backgroundColor: SEL_BG } : {}) }}
            >
              <text>
                <span fg={selected ? PALETTE.fgBright : PALETTE.fgDim}>{selected ? "› " : "  "}</span>
                <span fg={own.color}>{`${own.glyph} `}</span>
                <span fg={selected ? PALETTE.fgBright : PALETTE.fg}>
                  {truncate(item.relativePath, 56)}
                </span>
                <span fg={PALETTE.fgDim}>
                  {item.siteKey ? `  ${truncate(item.siteKey, 20)}` : ""}
                  {item.role === "support" ? "  support" : ""}
                </span>
              </text>
            </box>
          );
        })}
      </box>
      {win.below > 0 ? <text content={`  +${win.below} more below`} style={{ fg: PALETTE.fgDim }} /> : null}
    </box>
  );
}

function PlanPreview({ plan }: { readonly plan: MutationPlan }) {
  return (
    <box style={{ flexDirection: "column", marginTop: 1, width: "100%" }}>
      <WrapText
        content={`${plan.title}${plan.dryRun ? "  (dry-run)" : "  (apply)"}`}
        fg={PALETTE.fgMuted}
      />
      {plan.ops.length === 0 ? (
        <text content="  (no ops)" style={{ fg: PALETTE.fgDim }} />
      ) : (
        plan.ops.slice(0, 12).map((op, i) => (
          <WrapText
            key={`${op.kind}-${i}`}
            content={`  ${op.kind}  ${op.targetPath}${op.detail ? `  · ${op.detail}` : ""}`}
            fg={PALETTE.fg}
          />
        ))
      )}
      {plan.ops.length > 12 ? (
        <text content={`  +${plan.ops.length - 12} more ops`} style={{ fg: PALETTE.fgDim }} />
      ) : null}
      {plan.blocked.map((b, i) => (
        <WrapText key={`b-${i}`} content={`  ! ${b}`} fg={PALETTE.danger} />
      ))}
      {plan.notes.map((n, i) => (
        <WrapText key={`n-${i}`} content={`  · ${n}`} fg={PALETTE.fgDim} />
      ))}
    </box>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────

function Footer({
  focus,
  view,
  busy,
  confirm,
  error,
  status,
  width,
  viewingMemories,
}: {
  readonly focus: Focus;
  readonly view: View;
  readonly busy: boolean;
  readonly confirm: ConfirmAction | null;
  readonly error: string | null;
  readonly status: string | null;
  /** Full terminal width — used for explicit column wrap. */
  readonly width: number;
  readonly viewingMemories?: boolean;
}) {
  const hints: ReadonlyArray<readonly [string, string]> =
    focus === "detail"
      ? view.kind === "reader"
        ? view.editing
          ? [["^s", "save"], ["esc", "cancel"], ["mouse", "cursor"]]
          : [["j/k", "scroll"], ["e/click", "edit"], ["esc/h", "up"], ["q", "quit"]]
        : view.kind === "config-pick"
          ? [["j/k", "option"], ["enter", "set"], ["esc/h", "up"], ["q", "quit"]]
          : view.kind === "section" && view.section === "config"
            ? [["j/k", "key"], ["enter", "edit"], ["esc/h", "nav"], ["r", "reload"], ["q", "quit"]]
            : view.kind === "artifact"
              ? [["enter", "read"], ["d", "delete"], ["esc/h", "up"], ["q", "quit"]]
              : view.kind === "group"
                ? [["j/k", "loc"], ["enter", "read"], ["d", "delete"], ["esc/h", "up"], ["q", "quit"]]
                : view.kind === "plugin"
                  ? [["j/k", "item"], ["enter", "open"], ["u", "uninstall"], ["esc/h", "up"], ["q", "quit"]]
                  : view.kind === "section"
                    ? [["j/k", "row"], ["enter", "open"], ["esc/h", "nav"], ["q", "quit"]]
                    : [["tab", "nav"], ["esc/h", "nav"], ["q", "quit"]]
      : [
          ["j/k", "move"],
          ["enter/l", "open"],
          ["esc/h", "up"],
          ["tab", "detail"],
          ["q", "quit"],
        ];

  // Prefer measured term width; fall back to stdout so wrap always has a real budget.
  const colBudget = Math.max(
    20,
    (Number.isFinite(width) && width > 0 ? width : process.stdout.columns || 80) - 4,
  );
  const message =
    confirm !== null
      ? confirm.kind === "set-setting"
        ? `${confirm.message}  ·  enter apply · esc cancel`
        : `${confirm.plan.title}  ·  ${confirm.plan.ops.length} ops · enter apply · esc cancel`
      : error !== null
        ? `error · ${error}`
        : status !== null
          ? status
          : null;
  const messageFg =
    confirm !== null ? PALETTE.danger : error !== null ? PALETTE.danger : PALETTE.ok;
  // Cap lines so a megabyte error can't eat the screen
  const messageLines =
    message !== null ? wordWrap(message, colBudget).split("\n").slice(0, 6) : null;

  return (
    <box
      style={{
        width: "100%",
        // Let column height = sum of 1-row children + border (no fixed height clip)
        flexDirection: "column",
        border: ["top"],
        borderColor: PALETTE.borderInactive,
        paddingLeft: 1,
        paddingRight: 1,
        flexShrink: 0,
      }}
    >
      {messageLines !== null ? (
        messageLines.map((line, i) => (
          <box key={i} style={{ height: 1, width: "100%", flexDirection: "row" }}>
            <text
              content={line.length > 0 ? line : " "}
              style={{ fg: messageFg, wrapMode: "none" }}
            />
          </box>
        ))
      ) : (
        <box style={{ height: 1, flexDirection: "row", width: "100%" }}>
          {hints.map(([key, desc]) => (
            <text key={key} style={{ marginRight: 2 }}>
              <span fg={PALETTE.accent} attributes={ATTR.bold}>
                {key}
              </span>
              <span fg={PALETTE.fgDim}>{` ${desc}`}</span>
            </text>
          ))}
          {busy ? (
            <text>
              <span fg={PALETTE.running}>{" · working"}</span>
            </text>
          ) : null}
        </box>
      )}
      {viewingMemories && confirm === null && error === null ? (
        <box style={{ height: 1, width: "100%", flexDirection: "row" }}>
          <text
            content="Memories are generated files — session bugs land here."
            style={{ fg: PALETTE.fgDim, wrapMode: "none" }}
          />
        </box>
      ) : null}
    </box>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export function ConfigureApp({ projectPath }: { readonly projectPath?: string }) {
  const renderer = useRenderer();
  const { width: termWidth, height: termHeight } = useTerminalDimensions();
  const navWidth = clamp(Math.round(termWidth * 0.22), 20, 36);
  const listWindow = Math.max(6, termHeight - 8);

  const [inventory, setInventory] = useState<ConfigureInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [focus, setFocus] = useState<Focus>("nav");
  const [navCursor, setNavCursor] = useState(0);
  const [detailCursor, setDetailCursor] = useState(0);
  const [view, setView] = useState<View>({ kind: "summary" });
  /**
   * Detail drill trail (parent views). Esc/h pops one frame.
   * Cleared whenever the left-nav selection changes.
   */
  const [trail, setTrail] = useState<ReadonlyArray<View>>([]);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [pluginsExpanded, setPluginsExpanded] = useState(false);
  /** Only this harness shows sections — set by Enter/→, never by j/k alone. */
  const [expandedHarness, setExpandedHarness] = useState<string | null>(null);
  /** Hermes: which profile is expanded under the hermes harness. */
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null);
  /** Which project-local root is expanded under the focused harness. */
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  /** Which harness detail panel shows (follows expand, or last opened). */
  const [focusedHarness, setFocusedHarness] = useState<string | null>(null);
  const [metaByPath, setMetaByPath] = useState<ReadonlyMap<string, string>>(new Map());

  /** Replace view and wipe trail (nav-driven root selection). */
  const setRootView = useCallback((next: View): void => {
    setTrail([]);
    setView(next);
    setDetailCursor(0);
  }, []);

  /** Drill one level deeper in the detail pane (pushes current onto trail). */
  const drillTo = useCallback((next: View): void => {
    setView((current) => {
      setTrail((t) => [...t, current]);
      return next;
    });
    setDetailCursor(0);
    setFocus("detail");
  }, []);

  const [tick, setTick] = useState(0);
  const animating = loading || busy;
  useEffect(() => {
    if (!animating) return;
    const id = setInterval(() => setTick((v) => v + 1), 90);
    return () => clearInterval(id);
  }, [animating]);
  const spinner = animating ? spinnerFrame(tick) : "·";

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void loadConfigureInventory(projectPath ? { projectPath } : {})
      .then((inv) => {
        setInventory(inv);
        setFocusedHarness((prev) => prev ?? inv.focusedHarness);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        setError(errMsg(cause));
        setLoading(false);
      });
  }, [projectPath]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const activeHarnessId =
    expandedHarness ?? focusedHarness ?? inventory?.focusedHarness ?? "claude-code";
  const harnessDetail = inventory?.byHarness[activeHarnessId as keyof typeof inventory.byHarness];
  const profiles = harnessDetail?.profiles ?? [];
  /** Shared-root summary (always harness-level). */
  const harnessSummary =
    harnessDetail?.summary ??
    inventory?.harnesses.find((h) => h.harness === activeHarnessId) ??
    null;

  const navItems = useMemo<ReadonlyArray<NavItem>>(() => {
    if (!inventory) {
      return [{ id: "loading", kind: "harness", label: "Loading harnesses…" }];
    }
    const items: NavItem[] = [];
    for (const h of inventory.harnesses) {
      const mark = harnessMark(h.harness);
      const presence =
        h.presence === "present" ? "·" : h.presence === "snapshot-only" ? "◦" : " ";
      const open = expandedHarness === h.harness;
      const det = inventory.byHarness[h.harness as keyof typeof inventory.byHarness];
      const profileN = det?.profiles?.length ?? h.profileCount ?? 0;
      const projectN = det?.projects?.length ?? h.projectCount ?? 0;
      const harnessLabelExtra = `${
        h.harness === "hermes" && profileN > 0 ? ` ·${profileN}p` : ""
      }${projectN > 0 ? ` ·${projectN}proj` : ""}`;
      items.push({
        id: `harness:${h.harness}`,
        kind: "harness",
        label: `${open ? "▾" : "▸"} ${mark.glyph} ${truncate(h.displayName, 12)}${harnessLabelExtra} ${presence}`,
      });
      // Sections only for the harness the user opened with Enter/→
      if (!open) continue;
      const sum = det?.summary ?? h;
      for (const s of SECTIONS) {
        // Identity stays Hermes-only unless another harness actually has soul/identity files
        if (s.id === "identity" && h.harness !== "hermes" && sectionCount(sum, "identity") === 0) {
          continue;
        }
        const count = sectionCount(sum, s.id);
        if (s.id === "memories" && !showMemoriesSection(h.harness, count)) {
          continue;
        }
        items.push({
          id: `section:${h.harness}:${s.id}`,
          kind: "section",
          section: s.id,
          label: s.id === "summary" || s.id === "config" ? s.label : `${s.label} (${count})`,
          ...(s.id !== "summary" && s.id !== "config" ? { count } : {}),
        });
        if (s.id === "plugins" && pluginsExpanded) {
          for (const p of sum.plugins) {
            items.push({
              id: `plugin:${h.harness}:${p.name}`,
              kind: "plugin",
              plugin: p.name,
              label: p.name,
            });
          }
        }
      }
      // Hermes profiles as nested harness-equivalents
      if (h.harness === "hermes" && det?.profiles && det.profiles.length > 0) {
        for (const prof of det.profiles) {
          const pOpen = expandedProfile === prof.summary.id;
          const sk = prof.summary.counts.skill;
          items.push({
            id: `profile:${h.harness}:${prof.summary.id}`,
            kind: "profile",
            profileId: prof.summary.id,
            label: `${pOpen ? "▾" : "▸"} ${truncate(prof.summary.id, 14)} ·${sk}sk`,
          });
          if (!pOpen) continue;
          for (const s of PROFILE_SECTIONS) {
            const count = sectionCount(prof.summary, s.id);
            items.push({
              id: `section:${h.harness}:profile:${prof.summary.id}:${s.id}`,
              kind: "section",
              section: s.id,
              profileId: prof.summary.id,
              label:
                s.id === "summary" || s.id === "config"
                  ? s.label
                  : `${s.label} (${count})`,
              ...(s.id !== "summary" && s.id !== "config" ? { count } : {}),
            });
          }
        }
      }
      // Project-local roots — same expand/collapse UX as Hermes profiles
      for (const proj of det?.projects ?? []) {
        const jOpen = expandedProject === proj.summary.id;
        const sk = proj.summary.counts.skill;
        items.push({
          id: `project:${h.harness}:${proj.summary.id}`,
          kind: "project",
          projectId: proj.summary.id,
          label: `${jOpen ? "▾" : "▸"} ${truncate(proj.summary.id, 14)} ·${sk}sk`,
        });
        if (!jOpen) continue;
        for (const s of PROJECT_SECTIONS) {
          const count = sectionCount(proj.summary, s.id);
          if (s.id === "identity" && identitySectionCount(proj.summary.counts) === 0) {
            continue;
          }
          if (s.id === "memories" && !showMemoriesSection(h.harness, count)) {
            continue;
          }
          items.push({
            id: `section:${h.harness}:project:${proj.summary.id}:${s.id}`,
            kind: "section",
            section: s.id,
            projectId: proj.summary.id,
            label:
              s.id === "summary" || s.id === "config"
                ? s.label
                : `${s.label} (${count})`,
            ...(s.id !== "summary" && s.id !== "config" ? { count } : {}),
          });
        }
      }
    }
    return items;
  }, [inventory, expandedHarness, expandedProfile, expandedProject, pluginsExpanded]);

  // Keep nav cursor in range when items change — do NOT reset to 0 on expand
  useEffect(() => {
    setNavCursor((c) => clamp(c, 0, Math.max(0, navItems.length - 1)));
  }, [navItems.length]);

  const selectedNav = navItems[navCursor];

  // Scope lists only when nav is on a profile/project row or a scoped section.
  // expandedProfile / expandedProject only control which tree is open in the nav.
  const navProfileId =
    selectedNav?.kind === "profile"
      ? selectedNav.profileId
      : selectedNav?.kind === "section"
        ? selectedNav.profileId
        : undefined;
  const navProjectId =
    selectedNav?.kind === "project"
      ? selectedNav.projectId
      : selectedNav?.kind === "section"
        ? selectedNav.projectId
        : undefined;
  const activeProfile: ProfileInventory | undefined = navProfileId
    ? harnessDetail?.profiles?.find((p) => p.summary.id === navProfileId)
    : undefined;
  const activeProject: ProjectInventory | undefined = navProjectId
    ? harnessDetail?.projects?.find((p) => p.summary.id === navProjectId)
    : undefined;
  const activeScope = activeProfile ?? activeProject;

  /** Scope for lists/counts: profile/project when nav is on that subtree, else shared. */
  const summary = activeProfile
    ? ({
        harness: "hermes" as const,
        displayName: `Hermes · ${activeProfile.summary.displayName}`,
        presence: "present" as const,
        globalRoot: activeProfile.summary.root,
        rootExists: activeProfile.summary.rootExists,
        snapshotEntryCount: 0,
        plugins: [],
        counts: activeProfile.summary.counts,
        config: activeProfile.summary.config,
      } satisfies HarnessSummary)
    : activeProject
      ? ({
          harness: activeHarnessId as HarnessSummary["harness"],
          displayName: `${harnessSummary?.displayName ?? activeHarnessId} · ${activeProject.summary.displayName}`,
          presence: "present" as const,
          globalRoot: activeProject.summary.root,
          rootExists: activeProject.summary.rootExists,
          snapshotEntryCount: 0,
          plugins: [],
          counts: activeProject.summary.counts,
          config: activeProject.summary.config,
        } satisfies HarnessSummary)
      : harnessSummary;
  const artifacts = activeScope?.artifacts ?? harnessDetail?.artifacts ?? [];
  const groups = activeScope?.groups ?? harnessDetail?.groups ?? [];
  const memoryFiles = activeScope?.summary.memoryFiles ?? [];
  const duplicateCount = useMemo(
    () => groups.filter((g) => g.isDuplicate).length,
    [groups],
  );

  // Left-nav selection owns the root detail view. Always clear the drill trail
  // when the cursor moves so Esc never returns to a stale pane from another branch.
  useEffect(() => {
    if (focus !== "nav" || !selectedNav) return;
    setStatus(null);
    setRootView(viewFromNavItem(selectedNav));
  }, [focus, selectedNav?.id, setRootView]);

  // Config keys from active scope (profile or harness)
  const configKeys = summary?.config?.settingsKeys ?? [];

  const detailList = useMemo(() => {
    if (view.kind === "section" && view.section === "config") {
      return {
        mode: "config" as const,
        plugins: [] as PluginSummary[],
        groups: [] as ArtifactGroup[],
        locations: [] as ArtifactEntry[],
        configKeys,
        pickOptions: [] as string[],
      };
    }
    if (view.kind === "config-pick") {
      return {
        mode: "pick" as const,
        plugins: [] as PluginSummary[],
        groups: [] as ArtifactGroup[],
        locations: [] as ArtifactEntry[],
        configKeys: [],
        pickOptions: [...view.options],
      };
    }
    if (view.kind === "section" && view.section === "plugins" && summary && !activeScope) {
      return {
        mode: "plugins" as const,
        plugins: summary.plugins,
        groups: [] as ArtifactGroup[],
        locations: [] as ArtifactEntry[],
        configKeys: [],
        pickOptions: [] as string[],
      };
    }
    if (view.kind === "section") {
      return {
        mode: "groups" as const,
        plugins: [] as PluginSummary[],
        groups: groupsForSection(groups, view.section),
        locations: [] as ArtifactEntry[],
        configKeys: [],
        pickOptions: [] as string[],
      };
    }
    if (view.kind === "plugin") {
      return {
        mode: "groups" as const,
        plugins: [] as PluginSummary[],
        groups: groupsForPlugin(groups, view.plugin),
        locations: [] as ArtifactEntry[],
        configKeys: [],
        pickOptions: [] as string[],
      };
    }
    if (view.kind === "group") {
      const g = findGroup(groups, view.groupId);
      return {
        mode: "locations" as const,
        plugins: [] as PluginSummary[],
        groups: [] as ArtifactGroup[],
        locations: g?.locations ?? [],
        configKeys: [],
        pickOptions: [] as string[],
      };
    }
    return {
      mode: "none" as const,
      plugins: [] as PluginSummary[],
      groups: [] as ArtifactGroup[],
      locations: [] as ArtifactEntry[],
      configKeys: [],
      pickOptions: [] as string[],
    };
  }, [view, groups, summary, configKeys, activeScope]);

  const memoriesFallback =
    view.kind === "section" &&
    view.section === "memories" &&
    detailList.mode === "groups" &&
    detailList.groups.length === 0 &&
    memoryFiles.length > 0;

  const detailLen =
    memoriesFallback
      ? memoryFiles.length
      : detailList.mode === "plugins"
        ? detailList.plugins.length
        : detailList.mode === "groups"
          ? detailList.groups.length
          : detailList.mode === "locations"
            ? detailList.locations.length
            : detailList.mode === "config"
              ? detailList.configKeys.length
              : detailList.mode === "pick"
                ? detailList.pickOptions.length
                : 0;

  const viewKey =
    view.kind === "section"
      ? view.section
      : view.kind === "plugin"
        ? view.plugin
        : view.kind === "group"
          ? view.groupId
          : view.kind === "artifact"
            ? view.artifactId
            : "summary";

  useEffect(() => {
    setDetailCursor((c) => clamp(c, 0, Math.max(0, detailLen - 1)));
  }, [detailLen, viewKey]);

  const selectedDetailArtifact = useMemo((): ArtifactEntry | undefined => {
    if (view.kind === "artifact") return findArtifact(artifacts, view.artifactId);
    if (view.kind === "group" && detailList.mode === "locations" && detailList.locations.length > 0) {
      return detailList.locations[clamp(detailCursor, 0, detailList.locations.length - 1)];
    }
    return undefined;
  }, [view, artifacts, detailList, detailCursor]);

  const selectedPluginName = useMemo((): string | undefined => {
    if (view.kind === "plugin") return view.plugin;
    if (view.kind === "artifact") return findArtifact(artifacts, view.artifactId)?.plugin;
    if (view.kind === "group") {
      const g = findGroup(groups, view.groupId);
      if (g?.plugins.length === 1) return g.plugins[0];
    }
    if (detailList.mode === "plugins" && detailList.plugins.length > 0) {
      return detailList.plugins[clamp(detailCursor, 0, detailList.plugins.length - 1)]?.name;
    }
    if (selectedDetailArtifact?.plugin) return selectedDetailArtifact.plugin;
    if (selectedNav?.kind === "plugin") return selectedNav.plugin;
    return undefined;
  }, [view, artifacts, groups, detailList, detailCursor, selectedDetailArtifact, selectedNav]);

  const beginUninstall = (): void => {
    const name = selectedPluginName;
    if (!name) {
      setError("No plugin selected — open Plugins or an artifact with a plugin.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    void planUninstallPlugin({ pluginName: name, harness: activeHarnessId, dryRun: true })
      .then((result) => {
        setBusy(false);
        if (result.plan.blocked.length > 0 && result.plan.ops.length === 0) {
          setError(result.plan.blocked[0] ?? "Uninstall blocked");
          return;
        }
        setConfirm({ kind: "uninstall", plugin: name, plan: result.plan });
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(errMsg(cause));
      });
  };

  const beginDelete = (): void => {
    let art = selectedDetailArtifact;
    // On a group list row, delete the first primary/prism-owned location of that group.
    if (!art && detailList.mode === "groups" && detailList.groups[detailCursor]) {
      const g = detailList.groups[detailCursor]!;
      art =
        g.primaryLocations.find((l) => l.ownership === "prism-owned" || l.ownership === "prism-namespace") ??
        g.primaryLocations[0] ??
        g.locations[0];
    }
    if (!art) {
      setError("No artifact selected — open a group location, or select a group row.");
      return;
    }
    if (art.ownership === "foreign") {
      setError("Foreign paths are not Prism-owned — refuse delete.");
      return;
    }
    if (art.ownership === "prism-region") {
      setError("Regions need plugin uninstall (or a region-aware delete). Use u.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    const run =
      art.ownership === "prism-owned"
        ? planDeleteOwnedFile({ targetPath: art.targetPath, harness: activeHarnessId, dryRun: true })
        : planDeleteStrayPath({
            targetPath: art.targetPath,
            harnessRoot: summary?.globalRoot ?? "",
            dryRun: true,
          });
    void run
      .then((result) => {
        setBusy(false);
        if (result.plan.blocked.length > 0 && result.plan.ops.length === 0) {
          setError(result.plan.blocked[0] ?? "Delete blocked");
          return;
        }
        setConfirm({
          kind: "delete",
          targetPath: art.targetPath,
          ownership: art.ownership,
          plan: result.plan,
        });
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(errMsg(cause));
      });
  };

  const applyConfirm = (): void => {
    if (!confirm) return;
    const action = confirm;
    setConfirm(null);
    setBusy(true);
    setError(null);

    if (action.kind === "set-setting") {
      void planSetSetting({
        harness: activeHarnessId,
        root: summary?.globalRoot,
        key: action.key,
        value: action.value,
        dryRun: false,
      })
        .then((result) => {
          setBusy(false);
          if (!result.ok) {
            setError(result.blocked ?? result.message);
          } else {
            setStatus(result.message);
            setView({ kind: "section", section: "config" });
            setReloadKey((k) => k + 1);
          }
        })
        .catch((cause: unknown) => {
          setBusy(false);
          setError(errMsg(cause));
        });
      return;
    }

    const run =
      action.kind === "uninstall"
        ? planUninstallPlugin({ pluginName: action.plugin, harness: activeHarnessId, dryRun: false })
        : action.ownership === "prism-owned"
          ? planDeleteOwnedFile({
              targetPath: action.targetPath,
              harness: activeHarnessId,
              dryRun: false,
            })
          : planDeleteStrayPath({
              targetPath: action.targetPath,
              harnessRoot: summary?.globalRoot ?? "",
              dryRun: false,
            });
    void run
      .then((result) => {
        setBusy(false);
        if (result.failures.length > 0) {
          setError(result.failures[0] ?? "Mutation failed");
        } else if (result.plan.blocked.length > 0 && !result.applied) {
          setError(result.plan.blocked[0] ?? "Blocked");
        } else {
          setStatus(result.applied ? `applied · ${result.plan.title}` : `done · ${result.plan.title}`);
        }
        setReloadKey((k) => k + 1);
        if (action.kind === "delete" && view.kind === "artifact") {
          setView({ kind: "summary" });
          setFocus("nav");
        }
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(errMsg(cause));
      });
  };

  const openReader = (path: string, title: string): void => {
    setBusy(true);
    void loadTextForReader(path)
      .then((doc) => {
        setBusy(false);
        if (doc.error) {
          setError(doc.error);
          return;
        }
        drillTo({
          kind: "reader",
          path: doc.path,
          title,
          text: doc.text,
          truncated: doc.truncated,
          scroll: 0,
          editing: false,
        });
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(errMsg(cause));
      });
  };

  const beginEditReader = (): void => {
    if (view.kind !== "reader") return;
    const { path, title } = view;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        if (!(await exists(path))) {
          setBusy(false);
          setError(`Missing file: ${path}`);
          return;
        }
        const raw = await readFile(path);
        const bytes = Buffer.byteLength(raw, "utf8");
        if (bytes > EDIT_MAX_BYTES) {
          setBusy(false);
          setError(
            `File too large to edit inline (${bytes} bytes; max ${EDIT_MAX_BYTES}). Use an external editor.`,
          );
          return;
        }
        setBusy(false);
        setView({
          kind: "reader",
          path,
          title,
          text: raw,
          truncated: false,
          scroll: view.scroll,
          editing: true,
        });
        setFocus("detail");
        setStatus(null);
      } catch (cause: unknown) {
        setBusy(false);
        setError(errMsg(cause));
      }
    })();
  };

  const saveEditor = (next: string): void => {
    if (view.kind !== "reader" || !view.editing) return;
    const { path, title } = view;
    setBusy(true);
    setError(null);
    void writeFile(path, next)
      .then(() => {
        setBusy(false);
        setView({
          kind: "reader",
          path,
          title,
          text: next,
          truncated: false,
          scroll: 0,
          editing: false,
        });
        setStatus(`saved · ${path}`);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(errMsg(cause));
      });
  };

  const cancelEditor = (): void => {
    if (view.kind !== "reader" || !view.editing) return;
    setView({ ...view, editing: false });
    setStatus("edit cancelled");
  };

  const openConfigKey = (key: string): void => {
    const cat = getHarnessCatalog(activeHarnessId as never);
    const field = cat.fields.find((f) => f.key === key);
    const sk = configKeys.find((k) => k.key === key);
    if (!field) {
      setError(`Unknown catalogue key: ${key}`);
      return;
    }
    if (field.type === "boolean") {
      const cur = sk?.preview === "true";
      const next = !cur;
      setConfirm({
        kind: "set-setting",
        key,
        value: next,
        message: `Set ${key} = ${next} on ${activeHarnessId}?`,
      });
      return;
    }
    if (field.type === "enum" && field.enumValues && field.enumValues.length > 0) {
      drillTo({
        kind: "config-pick",
        key,
        options: [...field.enumValues],
        current: sk?.preview,
      });
      setDetailCursor(Math.max(0, field.enumValues.findIndex((v) => v === sk?.preview)));
      return;
    }
    setStatus(null);
    drillTo({ kind: "config-key", key });
  };

  const moveNavToId = (id: string): void => {
    setNavCursor(findNavIndex(navItems, id));
    setFocus("nav");
  };

  const drillIn = (): void => {
    if (focus === "nav") {
      if (!selectedNav) return;
      if (selectedNav.kind === "harness") {
        const id = selectedNav.id.replace(/^harness:/u, "");
        // Expand in place — stay on nav so j/k continues the tree
        setExpandedHarness(id);
        setFocusedHarness(id);
        setExpandedProfile(null);
        setExpandedProject(null);
        setPluginsExpanded(false);
        setRootView({ kind: "summary" });
        return;
      }
      if (selectedNav.kind === "profile") {
        const id = selectedNav.profileId;
        // Toggle expand; stay on nav
        setExpandedProfile((prev) => (prev === id ? null : id));
        setFocusedHarness("hermes");
        setRootView({ kind: "summary" });
        return;
      }
      if (selectedNav.kind === "project") {
        const id = selectedNav.projectId;
        setExpandedProject((prev) => (prev === id ? null : id));
        setRootView({ kind: "summary" });
        return;
      }
      if (selectedNav.kind === "section" && selectedNav.section === "plugins") {
        setPluginsExpanded(true);
        setRootView({ kind: "section", section: "plugins" });
        setFocus("detail");
        return;
      }
      // Any other section / plugin: enter detail on the already-synced root view
      setRootView(viewFromNavItem(selectedNav));
      setFocus("detail");
      return;
    }

    // ── detail focus ────────────────────────────────────────────────────────
    if (view.kind === "config-pick") {
      const opt = view.options[detailCursor];
      if (opt === undefined) return;
      setConfirm({
        kind: "set-setting",
        key: view.key,
        value: opt,
        message: `Set ${view.key} = ${opt} on ${activeHarnessId}?`,
      });
      return;
    }
    if (detailList.mode === "config" && detailList.configKeys[detailCursor]) {
      openConfigKey(detailList.configKeys[detailCursor]!.key);
      return;
    }
    if (memoriesFallback && memoryFiles[detailCursor]) {
      const file = memoryFiles[detailCursor]!;
      if (file.exists) openReader(file.path, file.label);
      else setError(`Missing file: ${file.path}`);
      return;
    }
    if (detailList.mode === "plugins" && detailList.plugins[detailCursor]) {
      const p = detailList.plugins[detailCursor]!;
      setPluginsExpanded(true);
      drillTo({ kind: "plugin", plugin: p.name });
      return;
    }
    // List of groups → group location list (never skip to file)
    if (detailList.mode === "groups" && detailList.groups[detailCursor]) {
      const g = detailList.groups[detailCursor]!;
      setStatus(null);
      drillTo({ kind: "group", groupId: g.id });
      return;
    }
    // Locations → reader or artifact meta
    if (detailList.mode === "locations" && detailList.locations[detailCursor]) {
      const loc = detailList.locations[detailCursor]!;
      if (
        loc.relativePath.endsWith(".md") ||
        loc.relativePath.endsWith(".txt") ||
        loc.relativePath.endsWith(".json") ||
        loc.relativePath.endsWith(".toml") ||
        loc.relativePath.endsWith(".yaml") ||
        loc.relativePath.endsWith(".yml") ||
        loc.relativePath.endsWith("SKILL.md")
      ) {
        openReader(loc.targetPath, loc.label);
        return;
      }
      drillTo({ kind: "artifact", artifactId: loc.id });
      return;
    }
    if (view.kind === "artifact") {
      const art = findArtifact(artifacts, view.artifactId);
      if (art) openReader(art.targetPath, art.label);
    }
  };

  const goBack = (): void => {
    if (confirm) {
      setConfirm(null);
      return;
    }
    // Editor first: esc exits edit, not the reader
    if (view.kind === "reader" && view.editing) {
      cancelEditor();
      return;
    }
    setStatus(null);

    // 1) Pop detail trail first (reader → group → section, never a hard-coded section)
    if (trail.length > 0) {
      const { trail: nextTrail, view: prev } = popTrail(trail);
      setTrail(nextTrail);
      if (prev) {
        setView(prev);
        setDetailCursor(0);
        setFocus("detail");
      }
      return;
    }

    // 2) At trail root with detail focus → return to nav (same row)
    if (focus === "detail") {
      setFocus("nav");
      // Re-sync root view from nav so detail matches selection
      if (selectedNav) setRootView(viewFromNavItem(selectedNav));
      return;
    }

    // 3) Nav focus: one tree level up (collapse or move to parent row)
    const result = navBackFromNavFocus(selectedNav, {
      expandedHarness,
      expandedProfile,
      expandedProject,
      pluginsExpanded,
    });
    switch (result.action) {
      case "noop":
        return;
      case "move":
        moveNavToId(result.navId);
        return;
      case "collapse-profile":
        setExpandedProfile(null);
        return;
      case "collapse-project":
        setExpandedProject(null);
        return;
      case "collapse-plugins":
        setPluginsExpanded(false);
        moveNavToId(result.navId);
        return;
      case "collapse-harness":
        setExpandedHarness(null);
        setExpandedProfile(null);
        setExpandedProject(null);
        setPluginsExpanded(false);
        return;
    }
  };

  useKeyboard((key) => {
    // While editing, textarea owns keys (save/cancel via its onKeyDown).
    // Only allow quit / force-cancel if textarea missed esc.
    if (view.kind === "reader" && view.editing) {
      if (key.name === "q" && (key.ctrl || key.meta)) {
        renderer?.destroy();
        exitWith(0);
      }
      return;
    }

    if (confirm !== null) {
      if (key.name === "escape") setConfirm(null);
      if (key.name === "return") applyConfirm();
      return;
    }
    if (key.name === "q") {
      renderer?.destroy();
      exitWith(0);
    }
    if (key.name === "r") {
      setStatus(null);
      setReloadKey((k) => k + 1);
      return;
    }
    if (key.name === "u" && view.kind !== "reader" && view.kind !== "config-pick") {
      beginUninstall();
      return;
    }
    if (key.name === "d" && view.kind !== "reader" && view.kind !== "config-pick") {
      beginDelete();
      return;
    }
    // Reader: e → edit
    if (
      key.name === "e" &&
      !key.ctrl &&
      !key.meta &&
      view.kind === "reader" &&
      !view.editing &&
      focus === "detail"
    ) {
      beginEditReader();
      return;
    }
    if (key.name === "tab") {
      setFocus((f) => (f === "nav" ? "detail" : "nav"));
      return;
    }

    const move = key.name === "up" || key.name === "k" ? -1 : key.name === "down" || key.name === "j" ? 1 : 0;

    if (key.name === "return" || key.name === "right" || key.name === "l") {
      drillIn();
      return;
    }
    if (key.name === "escape" || key.name === "left" || key.name === "h") {
      goBack();
      return;
    }

    if (move !== 0) {
      if (view.kind === "reader" && !view.editing) {
        setView((v) =>
          v.kind === "reader"
            ? { ...v, scroll: Math.max(0, v.scroll + move * 3) }
            : v,
        );
        return;
      }
      if (focus === "nav") {
        setNavCursor((c) => clamp(c + move, 0, Math.max(0, navItems.length - 1)));
      } else if (view.kind !== "summary" && view.kind !== "artifact" && view.kind !== "config-key") {
        setDetailCursor((c) => clamp(c + move, 0, Math.max(0, detailLen - 1)));
      }
    }
  });

  const title =
    view.kind === "summary"
      ? activeProfile
        ? `Profile · ${activeProfile.summary.id}`
        : activeProject
          ? `Project · ${activeProject.summary.id}`
          : "Summary"
      : view.kind === "section"
        ? `${
            activeProfile
              ? `${activeProfile.summary.id} · `
              : activeProject
                ? `${activeProject.summary.id} · `
                : ""
          }${
            [...SECTIONS, ...PROFILE_SECTIONS, ...PROJECT_SECTIONS].find((s) => s.id === view.section)
              ?.label ?? view.section
          }`
        : view.kind === "plugin"
          ? `Plugin · ${view.plugin}`
          : view.kind === "group"
            ? `Group · ${findGroup(groups, view.groupId)?.label ?? "…"}`
            : view.kind === "config-pick"
              ? `Set · ${view.key}`
              : view.kind === "config-key"
                ? `Key · ${view.key}`
                : view.kind === "reader"
                  ? view.editing
                    ? `Edit · ${view.title}`
                    : `Read · ${view.title}`
                  : "Artifact";

  // Explicit column budget so status/paths always wrap (never ellipsis).
  const detailWrapWidth = Math.max(24, termWidth - navWidth - 6);

  return (
    <WrapWidthContext.Provider value={detailWrapWidth}>
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: PALETTE.bg }}>
      <box style={{ width: "100%", flexGrow: 1, flexDirection: "row" }}>
        <NavList
          items={navItems}
          selectedIndex={navCursor}
          focused={focus === "nav"}
          windowSize={listWindow}
          width={navWidth}
          onSelect={(index) => {
            setNavCursor(clamp(index, 0, Math.max(0, navItems.length - 1)));
            setFocus("nav");
          }}
        />
        <box
          title={loading ? `Loading ${spinner}` : title}
          style={{
            flexGrow: 1,
            height: "100%",
            border: true,
            borderColor: focus === "detail" ? PALETTE.borderActive : PALETTE.borderInactive,
            flexDirection: "column",
            paddingLeft: 1,
            paddingRight: 1,
            backgroundColor: PALETTE.bg,
          }}
        >
          {loading && !inventory ? (
            <text content={`${spinner} loading inventory…`} style={{ fg: PALETTE.fgDim }} />
          ) : !summary ? (
            <text content="No harness data" style={{ fg: PALETTE.danger }} />
          ) : confirm !== null ? (
            <box style={{ flexDirection: "column" }}>
              <text content="Confirm mutation" style={{ fg: PALETTE.danger, attributes: ATTR.bold }} />
              {confirm.kind === "set-setting" ? (
                <Row content={confirm.message} fg={PALETTE.fg} />
              ) : (
                <PlanPreview plan={confirm.plan} />
              )}
            </box>
          ) : view.kind === "summary" && activeScope ? (
            <ScopeSummaryDetail
              scope={activeScope}
              variant={activeProfile ? "profile" : "project"}
              duplicateCount={duplicateCount}
              onOpenFile={openReader}
            />
          ) : view.kind === "summary" && harnessSummary ? (
            <SummaryDetail
              summary={harnessSummary}
              duplicateCount={
                // shared-root dedup only
                (harnessDetail?.groups ?? []).filter((g) => g.isDuplicate).length
              }
              profileCount={harnessSummary.profileCount ?? profiles.length}
              profiles={profiles}
              projectCount={harnessSummary.projectCount ?? (harnessDetail?.projects?.length ?? 0)}
              projects={harnessDetail?.projects}
            />
          ) : view.kind === "summary" ? (
            <SummaryDetail summary={summary} duplicateCount={duplicateCount} />
          ) : view.kind === "section" && view.section === "config" ? (
            <ConfigDetail
              summary={summary}
              cursor={detailCursor}
              windowSize={listWindow}
              focused={focus === "detail"}
              onSelect={(i) => {
                setDetailCursor(i);
                setFocus("detail");
              }}
              onScroll={(d) => {
                setFocus("detail");
                setDetailCursor((c) => clamp(c + d, 0, Math.max(0, configKeys.length - 1)));
              }}
            />
          ) : view.kind === "config-pick" ? (
            <ConfigPickDetail
              keyName={view.key}
              options={view.options}
              current={view.current}
              cursor={detailCursor}
              onSelect={(i) => setDetailCursor(i)}
            />
          ) : view.kind === "reader" ? (
            (() => {
              const readerW = Math.max(20, termWidth - navWidth - 6);
              if (view.editing) {
                return (
                  <TextFileEditor
                    title={view.title}
                    path={view.path}
                    text={view.text}
                    height={listWindow}
                    width={readerW}
                    focused={focus === "detail"}
                    saving={busy}
                    onSave={saveEditor}
                    onCancel={cancelEditor}
                  />
                );
              }
              const visualCount = wrapReaderLines(view.text, Math.max(8, readerW - 2)).length;
              return (
                <TextReader
                  title={view.title}
                  path={view.path}
                  text={view.text}
                  truncated={view.truncated}
                  scroll={clampReaderScroll(view.scroll, visualCount, listWindow)}
                  height={listWindow}
                  width={readerW}
                  focused={focus === "detail"}
                  onEdit={beginEditReader}
                />
              );
            })()
          ) : view.kind === "config-key" ? (
            (() => {
              const cat = getHarnessCatalog(activeHarnessId as never);
              const field = cat.fields.find((f) => f.key === view.key);
              const sk = configKeys.find((k) => k.key === view.key);
              return (
                <box style={{ flexDirection: "column", width: "100%" }}>
                  <Row content={view.key} fg={PALETTE.fgBright} />
                  <Row content={`type     ${field?.type ?? "?"}`} />
                  <Row content={`value    ${sk?.preview ?? "—"}`} />
                  <Row content={`touch    ${field?.prismTouch ?? "?"}`} fg={PALETTE.fgDim} />
                  <Row content="" />
                  <WrapText
                    content={field?.description ?? "No description in catalogue."}
                    fg={PALETTE.fg}
                  />
                  <Row content="" />
                  <WrapText
                    content="esc back · enum/bool: enter from key list to edit"
                    fg={PALETTE.fgDim}
                  />
                </box>
              );
            })()
          ) : view.kind === "artifact" ? (
            (() => {
              const art = findArtifact(artifacts, view.artifactId);
              return art ? (
                <ArtifactDetail artifact={art} />
              ) : (
                <text content="Artifact not found (reloaded?)" style={{ fg: PALETTE.fgDim }} />
              );
            })()
          ) : view.kind === "group" ? (
            (() => {
              const g = findGroup(groups, view.groupId);
              return g ? (
                <GroupDetail
                  group={g}
                  cursor={detailCursor}
                  windowSize={listWindow}
                  focused={focus === "detail"}
                  onSelect={(i) => {
                    setDetailCursor(i);
                    setFocus("detail");
                  }}
                  onScroll={(d) => {
                    setFocus("detail");
                    setDetailCursor((c) => clamp(c + d, 0, Math.max(0, g.locations.length - 1)));
                  }}
                />
              ) : (
                <text content="Group not found (reloaded?)" style={{ fg: PALETTE.fgDim }} />
              );
            })()
          ) : view.kind === "section" && view.section === "plugins" ? (
            <PluginRows
              plugins={summary.plugins}
              cursor={detailCursor}
              windowSize={listWindow}
              focused={focus === "detail"}
              onSelect={(i) => {
                setDetailCursor(i);
                setFocus("detail");
              }}
              onScroll={(d) => {
                setFocus("detail");
                setDetailCursor((c) => clamp(c + d, 0, Math.max(0, summary.plugins.length - 1)));
              }}
            />
          ) : memoriesFallback ? (
            <MemoryFileRows
              files={memoryFiles}
              cursor={detailCursor}
              windowSize={listWindow}
              focused={focus === "detail"}
              onSelect={(i) => {
                setDetailCursor(i);
                setFocus("detail");
                const file = memoryFiles[i];
                if (file?.exists) openReader(file.path, file.label);
              }}
              onScroll={(d) => {
                setFocus("detail");
                setDetailCursor((c) => clamp(c + d, 0, Math.max(0, memoryFiles.length - 1)));
              }}
            />
          ) : (
            <GroupRows
              items={detailList.groups}
              cursor={detailCursor}
              windowSize={listWindow}
              focused={focus === "detail"}
              onSelect={(i) => {
                setDetailCursor(i);
                setFocus("detail");
              }}
              onScroll={(d) => {
                setFocus("detail");
                setDetailCursor((c) => clamp(c + d, 0, Math.max(0, detailList.groups.length - 1)));
              }}
            />
          )}
        </box>
      </box>
      <Footer
        focus={focus}
        view={view}
        busy={busy || loading}
        confirm={confirm}
        error={error}
        status={status}
        width={termWidth}
        viewingMemories={
          (view.kind === "section" && view.section === "memories") ||
          (selectedNav?.kind === "section" && selectedNav.section === "memories")
        }
      />
    </box>
    </WrapWidthContext.Provider>
  );
}

export const runConfigureTui = async (options: ConfigureTuiOptions = {}): Promise<void> => {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(
    <ConfigureApp {...(options.projectPath ? { projectPath: options.projectPath } : {})} />,
  );
};
