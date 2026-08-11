/**
 * Configure TUI (POC: claude-code) — inspect Prism-managed harness inventory
 * and uninstall plugins / delete owned or stray paths.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { exitWith } from "../../exit.js";
import { harnessMark } from "../../plugins-tui/harness-meta.js";
import { ATTR, PALETTE, clamp, spinnerFrame, truncate } from "../../plugins-tui/theme.js";
import {
  artifactsForPlugin,
  groupsForPlugin,
  groupsForSection,
  loadConfigureInventory,
} from "../inventory.js";
import type {
  ArtifactEntry,
  ArtifactGroup,
  ConfigureInventory,
  HarnessPresence,
  HarnessSummary,
  MutationPlan,
  OwnershipKind,
  PluginSummary,
  SectionId,
} from "../model.js";
import {
  planDeleteOwnedFile,
  planDeleteStrayPath,
  planUninstallPlugin,
} from "../mutations.js";

export interface ConfigureTuiOptions {
  readonly projectPath?: string;
}

type Focus = "nav" | "detail";

type View =
  | { readonly kind: "summary" }
  | { readonly kind: "section"; readonly section: SectionId }
  | { readonly kind: "plugin"; readonly plugin: string }
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "artifact"; readonly artifactId: string };

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
    };

type NavItem =
  | { readonly id: string; readonly kind: "harness"; readonly label: string }
  | {
      readonly id: string;
      readonly kind: "section";
      readonly section: SectionId;
      readonly label: string;
      readonly count?: number;
    }
  | { readonly id: string; readonly kind: "plugin"; readonly plugin: string; readonly label: string };

const SEL_BG = PALETTE.selBg;

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "plugins", label: "Plugins" },
  { id: "skills", label: "Skills" },
  { id: "commands", label: "Commands" },
  { id: "agents", label: "Agents" },
  { id: "hooks", label: "Hooks" },
  { id: "rules", label: "Rules" },
  { id: "bundles", label: "Bundles" },
  { id: "other", label: "Other" },
];

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

const sectionCount = (summary: HarnessSummary, section: SectionId): number => {
  if (section === "summary") return 0;
  if (section === "plugins") return summary.plugins.length;
  if (section === "skills") return summary.counts.skill;
  if (section === "commands") return summary.counts.command;
  if (section === "agents") return summary.counts.agent;
  if (section === "hooks") return summary.counts.hook;
  if (section === "rules") return summary.counts.rules;
  if (section === "bundles") return summary.counts.bundle;
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
        const indent = item.kind === "harness" ? "" : item.kind === "plugin" ? "    " : "  ";
        const color =
          item.kind === "harness"
            ? selected
              ? PALETTE.fgBright
              : PALETTE.accentBright
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

function SummaryDetail({
  summary,
  duplicateCount,
}: {
  readonly summary: HarnessSummary;
  readonly duplicateCount: number;
}) {
  const mark = harnessMark(summary.harness);
  return (
    <box style={{ flexDirection: "column" }}>
      <text>
        <span fg={mark.color}>{`${mark.glyph} `}</span>
        <span fg={PALETTE.fgBright} attributes={ATTR.bold}>
          {summary.displayName}
        </span>
        <span fg={presenceColor(summary.presence)}>{`  ${summary.presence}`}</span>
      </text>
      <box style={{ height: 1 }} />
      <text>
        <span fg={PALETTE.fgMuted}>{"root  "}</span>
        <span fg={PALETTE.fg}>{truncate(summary.globalRoot, 72)}</span>
      </text>
      <text>
        <span fg={PALETTE.fgMuted}>{"exists "}</span>
        <span fg={summary.rootExists ? PALETTE.ok : PALETTE.danger}>{summary.rootExists ? "yes" : "no"}</span>
      </text>
      {summary.binaryPath ? (
        <text>
          <span fg={PALETTE.fgMuted}>{"bin   "}</span>
          <span fg={PALETTE.fg}>{truncate(summary.binaryPath, 72)}</span>
        </text>
      ) : (
        <text>
          <span fg={PALETTE.fgMuted}>{"bin   "}</span>
          <span fg={PALETTE.fgDim}>{"(not found)"}</span>
        </text>
      )}
      <text>
        <span fg={PALETTE.fgMuted}>{"snap  "}</span>
        <span fg={PALETTE.fg}>{`${summary.snapshotEntryCount} entries`}</span>
      </text>
      <text>
        <span fg={PALETTE.fgMuted}>{"dedup  "}</span>
        <span fg={duplicateCount > 0 ? PALETTE.yellow : PALETTE.fg}>
          {duplicateCount > 0
            ? `${duplicateCount} items in multiple install sites (⊞)`
            : "no multi-site duplicates"}
        </span>
      </text>
      <box style={{ height: 1 }} />
      <text>
        <span fg={PALETTE.fgMuted} attributes={ATTR.bold}>
          {"COUNTS (unique)"}
        </span>
      </text>
      {(
        [
          ["plugins", summary.plugins.length],
          ["skills", summary.counts.skill],
          ["commands", summary.counts.command],
          ["agents", summary.counts.agent],
          ["hooks", summary.counts.hook],
          ["rules", summary.counts.rules],
          ["bundles", summary.counts.bundle],
          ["other", summary.counts.other + summary.counts["tool-runtime"]],
        ] as const
      ).map(([label, n]) => (
        <text key={label}>
          <span fg={PALETTE.fgDim}>{`  ${label.padEnd(10)}`}</span>
          <span fg={PALETTE.fg}>{String(n)}</span>
        </text>
      ))}
      <box style={{ height: 1 }} />
      <text>
        <span fg={PALETTE.fgMuted} attributes={ATTR.bold}>
          {`PLUGINS (${summary.plugins.length})`}
        </span>
      </text>
      {summary.plugins.length === 0 ? (
        <text content="  (none)" style={{ fg: PALETTE.fgDim }} />
      ) : (
        summary.plugins.slice(0, 20).map((p) => (
          <text key={p.name}>
            <span fg={PALETTE.fg}>{`  ${p.name}`}</span>
            <span fg={PALETTE.fgDim}>{`  ${p.entryCount} entries`}</span>
            {p.hasToolRuntime ? <span fg={PALETTE.cyan}>{"  tools"}</span> : null}
          </text>
        ))
      )}
      {summary.plugins.length > 20 ? (
        <text content={`  +${summary.plugins.length - 20} more`} style={{ fg: PALETTE.fgDim }} />
      ) : null}
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
    <box style={{ flexDirection: "column" }}>
      <text>
        <span fg={PALETTE.fgBright} attributes={ATTR.bold}>
          {artifact.label}
        </span>
      </text>
      <box style={{ height: 1 }} />
      <text>
        <span fg={PALETTE.fgMuted}>{"path     "}</span>
        <span fg={PALETTE.fg}>{truncate(artifact.targetPath, 70)}</span>
      </text>
      <text>
        <span fg={PALETTE.fgMuted}>{"relative "}</span>
        <span fg={PALETTE.fg}>{truncate(artifact.relativePath, 70)}</span>
      </text>
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
        <text>
          <span fg={PALETTE.fgMuted}>{"plugins  "}</span>
          <span fg={PALETTE.fg}>{truncate(group.plugins.join(", "), 60)}</span>
        </text>
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
    <box style={{ flexDirection: "column", marginTop: 1 }}>
      <text>
        <span fg={PALETTE.fgMuted} attributes={ATTR.bold}>
          {plan.title}
        </span>
        <span fg={PALETTE.fgDim}>{plan.dryRun ? "  (dry-run)" : "  (apply)"}</span>
      </text>
      {plan.ops.length === 0 ? (
        <text content="  (no ops)" style={{ fg: PALETTE.fgDim }} />
      ) : (
        plan.ops.slice(0, 12).map((op, i) => (
          <text key={`${op.kind}-${i}`}>
            <span fg={PALETTE.yellow}>{`  ${op.kind.padEnd(18)}`}</span>
            <span fg={PALETTE.fg}>{truncate(op.targetPath, 52)}</span>
            {op.detail ? <span fg={PALETTE.fgDim}>{`  ${truncate(op.detail, 24)}`}</span> : null}
          </text>
        ))
      )}
      {plan.ops.length > 12 ? (
        <text content={`  +${plan.ops.length - 12} more ops`} style={{ fg: PALETTE.fgDim }} />
      ) : null}
      {plan.blocked.map((b, i) => (
        <text key={`b-${i}`} content={`  ! ${truncate(b, 80)}`} style={{ fg: PALETTE.danger }} />
      ))}
      {plan.notes.map((n, i) => (
        <text key={`n-${i}`} content={`  · ${truncate(n, 80)}`} style={{ fg: PALETTE.fgDim }} />
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
}: {
  readonly focus: Focus;
  readonly view: View;
  readonly busy: boolean;
  readonly confirm: ConfirmAction | null;
  readonly error: string | null;
  readonly status: string | null;
}) {
  const hints: ReadonlyArray<readonly [string, string]> =
    focus === "detail"
      ? view.kind === "artifact"
        ? [["j/k", "—"], ["u", "uninstall"], ["d", "delete"], ["esc", "back"], ["r", "reload"], ["q", "quit"]]
        : view.kind === "group"
          ? [["j/k", "location"], ["enter", "open"], ["d", "delete"], ["u", "uninstall"], ["esc", "back"], ["r", "reload"], ["q", "quit"]]
        : view.kind === "plugin"
          ? [["j/k", "item"], ["enter", "open"], ["u", "uninstall"], ["esc", "back"], ["r", "reload"], ["q", "quit"]]
          : view.kind === "section"
            ? [["j/k", "row"], ["enter", "open"], ["esc", "nav"], ["u", "uninstall"], ["d", "delete"], ["r", "reload"], ["q", "quit"]]
            : [["tab", "detail"], ["r", "reload"], ["q", "quit"]]
      : [
          ["j/k", "nav"],
          ["enter", "open"],
          ["tab", "detail"],
          ["u", "uninstall"],
          ["d", "delete"],
          ["r", "reload"],
          ["q", "quit"],
        ];

  const content =
    confirm !== null ? (
      <text
        content={`${confirm.plan.title}  ·  ${confirm.plan.ops.length} ops · enter apply · esc cancel`}
        style={{ width: "100%", fg: PALETTE.danger, wrapMode: "none", truncate: true }}
      />
    ) : error !== null ? (
      <text
        content={`error · ${truncate(error, 110)}`}
        style={{ width: "100%", fg: PALETTE.danger, wrapMode: "none", truncate: true }}
      />
    ) : status !== null ? (
      <text content={truncate(status, 110)} style={{ width: "100%", fg: PALETTE.ok, wrapMode: "none", truncate: true }} />
    ) : (
      <box style={{ flexDirection: "row" }}>
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
    );

  return (
    <box style={{ height: 2, width: "100%", border: ["top"], borderColor: PALETTE.borderInactive, paddingLeft: 1 }}>
      {content}
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
  const [navCursor, setNavCursor] = useState(1); // default Summary under harness
  const [detailCursor, setDetailCursor] = useState(0);
  const [view, setView] = useState<View>({ kind: "summary" });
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [pluginsExpanded, setPluginsExpanded] = useState(false);

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

  const summary = inventory?.harnesses[0] ?? null;
  const artifacts = inventory?.artifacts ?? [];
  const groups = inventory?.groups ?? [];
  const duplicateCount = useMemo(
    () => groups.filter((g) => g.isDuplicate).length,
    [groups],
  );

  const navItems = useMemo<ReadonlyArray<NavItem>>(() => {
    if (!summary) {
      return [{ id: "harness", kind: "harness", label: "Claude Code …" }];
    }
    const mark = harnessMark(summary.harness);
    const items: NavItem[] = [
      {
        id: "harness",
        kind: "harness",
        label: `${mark.glyph} ${summary.displayName}  [${summary.presence}]`,
      },
    ];
    for (const s of SECTIONS) {
      const count = sectionCount(summary, s.id);
      items.push({
        id: `section:${s.id}`,
        kind: "section",
        section: s.id,
        label: s.id === "summary" ? s.label : `${s.label} (${count})`,
        ...(s.id !== "summary" ? { count } : {}),
      });
      if (s.id === "plugins" && pluginsExpanded) {
        for (const p of summary.plugins) {
          items.push({
            id: `plugin:${p.name}`,
            kind: "plugin",
            plugin: p.name,
            label: p.name,
          });
        }
      }
    }
    return items;
  }, [summary, pluginsExpanded]);

  // Keep nav cursor in range when items change
  useEffect(() => {
    setNavCursor((c) => clamp(c, 0, Math.max(0, navItems.length - 1)));
  }, [navItems.length]);

  const selectedNav = navItems[navCursor];

  // Sync view from nav when focus is nav (and not mid-confirm / deep artifact from detail)
  useEffect(() => {
    if (focus !== "nav" || !selectedNav) return;
    if (selectedNav.kind === "harness" || (selectedNav.kind === "section" && selectedNav.section === "summary")) {
      setView({ kind: "summary" });
      setDetailCursor(0);
    } else if (selectedNav.kind === "section") {
      setView({ kind: "section", section: selectedNav.section });
      setDetailCursor(0);
    } else if (selectedNav.kind === "plugin") {
      setView({ kind: "plugin", plugin: selectedNav.plugin });
      setDetailCursor(0);
    }
  }, [focus, selectedNav?.id]);

  const detailList = useMemo(() => {
    if (view.kind === "section" && view.section === "plugins" && summary) {
      return {
        mode: "plugins" as const,
        plugins: summary.plugins,
        groups: [] as ArtifactGroup[],
        locations: [] as ArtifactEntry[],
      };
    }
    if (view.kind === "section") {
      return {
        mode: "groups" as const,
        plugins: [] as PluginSummary[],
        groups: groupsForSection(groups, view.section),
        locations: [] as ArtifactEntry[],
      };
    }
    if (view.kind === "plugin") {
      return {
        mode: "groups" as const,
        plugins: [] as PluginSummary[],
        groups: groupsForPlugin(groups, view.plugin),
        locations: [] as ArtifactEntry[],
      };
    }
    if (view.kind === "group") {
      const g = findGroup(groups, view.groupId);
      return {
        mode: "locations" as const,
        plugins: [] as PluginSummary[],
        groups: [] as ArtifactGroup[],
        locations: g?.locations ?? [],
      };
    }
    return {
      mode: "none" as const,
      plugins: [] as PluginSummary[],
      groups: [] as ArtifactGroup[],
      locations: [] as ArtifactEntry[],
    };
  }, [view, groups, summary]);

  const detailLen =
    detailList.mode === "plugins"
      ? detailList.plugins.length
      : detailList.mode === "groups"
        ? detailList.groups.length
        : detailList.mode === "locations"
          ? detailList.locations.length
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
    void planUninstallPlugin({ pluginName: name, dryRun: true })
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
        ? planDeleteOwnedFile({ targetPath: art.targetPath, dryRun: true })
        : planDeleteStrayPath({
            targetPath: art.targetPath,
            claudeRoot: summary?.globalRoot ?? "",
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
    const run =
      action.kind === "uninstall"
        ? planUninstallPlugin({ pluginName: action.plugin, dryRun: false })
        : action.ownership === "prism-owned"
          ? planDeleteOwnedFile({ targetPath: action.targetPath, dryRun: false })
          : planDeleteStrayPath({
              targetPath: action.targetPath,
              claudeRoot: summary?.globalRoot ?? "",
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
        // After delete, pop artifact view
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

  const drillIn = (): void => {
    if (focus === "nav") {
      if (!selectedNav) return;
      if (selectedNav.kind === "section" && selectedNav.section === "plugins") {
        setPluginsExpanded(true);
        setView({ kind: "section", section: "plugins" });
        setFocus("detail");
        setDetailCursor(0);
        return;
      }
      if (selectedNav.kind === "section" && selectedNav.section !== "summary") {
        setView({ kind: "section", section: selectedNav.section });
        setFocus("detail");
        setDetailCursor(0);
        return;
      }
      if (selectedNav.kind === "plugin") {
        setView({ kind: "plugin", plugin: selectedNav.plugin });
        setFocus("detail");
        setDetailCursor(0);
        return;
      }
      if (selectedNav.kind === "harness" || (selectedNav.kind === "section" && selectedNav.section === "summary")) {
        setView({ kind: "summary" });
        setFocus("detail");
      }
      return;
    }

    // detail focus
    if (detailList.mode === "plugins" && detailList.plugins[detailCursor]) {
      const p = detailList.plugins[detailCursor]!;
      setPluginsExpanded(true);
      setView({ kind: "plugin", plugin: p.name });
      setDetailCursor(0);
      return;
    }
    if (detailList.mode === "groups" && detailList.groups[detailCursor]) {
      const g = detailList.groups[detailCursor]!;
      // Always open group so multi-site locations are visible
      setView({ kind: "group", groupId: g.id });
      setDetailCursor(0);
      return;
    }
    if (detailList.mode === "locations" && detailList.locations[detailCursor]) {
      setView({ kind: "artifact", artifactId: detailList.locations[detailCursor]!.id });
    }
  };

  const goBack = (): void => {
    if (confirm) {
      setConfirm(null);
      return;
    }
    if (view.kind === "artifact") {
      // Prefer returning to group if this artifact belongs to one
      const art = findArtifact(artifacts, view.artifactId);
      const group = art?.logicalKey
        ? groups.find((g) => g.noun === art.noun && g.logicalKey === art.logicalKey)
        : undefined;
      if (group) {
        setView({ kind: "group", groupId: group.id });
      } else if (art?.plugin) {
        setView({ kind: "plugin", plugin: art.plugin });
      } else if (selectedNav?.kind === "section") {
        setView({ kind: "section", section: selectedNav.section });
      } else {
        setView({ kind: "summary" });
      }
      setFocus("detail");
      return;
    }
    if (view.kind === "group") {
      if (selectedNav?.kind === "plugin") {
        setView({ kind: "plugin", plugin: selectedNav.plugin });
      } else if (selectedNav?.kind === "section") {
        setView({ kind: "section", section: selectedNav.section });
      } else {
        setView({ kind: "summary" });
      }
      setFocus("detail");
      setDetailCursor(0);
      return;
    }
    if (view.kind === "plugin") {
      setView({ kind: "section", section: "plugins" });
      setFocus("detail");
      setDetailCursor(0);
      return;
    }
    if (focus === "detail") {
      setFocus("nav");
      return;
    }
    if (pluginsExpanded) setPluginsExpanded(false);
  };

  useKeyboard((key) => {
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
    if (key.name === "u") {
      beginUninstall();
      return;
    }
    if (key.name === "d") {
      beginDelete();
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
      if (focus === "nav") {
        setNavCursor((c) => clamp(c + move, 0, Math.max(0, navItems.length - 1)));
      } else if (view.kind !== "summary" && view.kind !== "artifact") {
        setDetailCursor((c) => clamp(c + move, 0, Math.max(0, detailLen - 1)));
      }
    }
  });

  const title =
    view.kind === "summary"
      ? "Summary"
      : view.kind === "section"
        ? SECTIONS.find((s) => s.id === view.section)?.label ?? view.section
        : view.kind === "plugin"
          ? `Plugin · ${view.plugin}`
          : view.kind === "group"
            ? `Group · ${findGroup(groups, view.groupId)?.label ?? "…"}`
            : "Artifact";

  return (
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
              <PlanPreview plan={confirm.plan} />
            </box>
          ) : view.kind === "summary" ? (
            <SummaryDetail summary={summary} duplicateCount={duplicateCount} />
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
      <Footer focus={focus} view={view} busy={busy || loading} confirm={confirm} error={error} status={status} />
    </box>
  );
}

export const runConfigureTui = async (options: ConfigureTuiOptions = {}): Promise<void> => {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(
    <ConfigureApp {...(options.projectPath ? { projectPath: options.projectPath } : {})} />,
  );
};
