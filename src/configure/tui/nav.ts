/**
 * Pure navigation helpers for prism configure TUI.
 * One level up / one level down — no heuristics that jump to the wrong section.
 */

import type { SectionId } from "../model.js";

/** Detail-pane views that participate in the drill trail. */
export type ConfigureView =
  | { readonly kind: "summary" }
  | { readonly kind: "section"; readonly section: SectionId }
  | { readonly kind: "plugin"; readonly plugin: string }
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "artifact"; readonly artifactId: string }
  | { readonly kind: "config-key"; readonly key: string }
  | {
      readonly kind: "config-pick";
      readonly key: string;
      readonly options: ReadonlyArray<string>;
      readonly current?: string;
    }
  | {
      readonly kind: "reader";
      readonly path: string;
      readonly title: string;
      readonly text: string;
      readonly truncated: boolean;
      readonly scroll: number;
    };

export type NavItemKind = "harness" | "section" | "profile" | "plugin";

export type ConfigureNavItem =
  | { readonly id: string; readonly kind: "harness"; readonly label: string }
  | {
      readonly id: string;
      readonly kind: "section";
      readonly section: SectionId;
      readonly label: string;
      readonly count?: number;
      readonly profileId?: string;
    }
  | {
      readonly id: string;
      readonly kind: "profile";
      readonly profileId: string;
      readonly label: string;
    }
  | { readonly id: string; readonly kind: "plugin"; readonly plugin: string; readonly label: string };

/** Map a left-nav item to the root detail view for that selection. */
export const viewFromNavItem = (item: ConfigureNavItem): ConfigureView => {
  switch (item.kind) {
    case "harness":
      return { kind: "summary" };
    case "profile":
      return { kind: "summary" };
    case "section":
      return item.section === "summary"
        ? { kind: "summary" }
        : { kind: "section", section: item.section };
    case "plugin":
      return { kind: "plugin", plugin: item.plugin };
  }
};

/**
 * Parent nav id when leaving a nav row (one level up in the tree).
 * Returns null at forest root (harness list, nothing to climb).
 */
export const parentNavId = (
  item: ConfigureNavItem,
  options: {
    readonly expandedHarness: string | null;
  },
): string | null => {
  switch (item.kind) {
    case "harness":
      return null;
    case "profile":
      return options.expandedHarness ? `harness:${options.expandedHarness}` : "harness:hermes";
    case "section":
      if (item.profileId) {
        return `profile:hermes:${item.profileId}`;
      }
      return options.expandedHarness ? `harness:${options.expandedHarness}` : null;
    case "plugin":
      return options.expandedHarness
        ? `section:${options.expandedHarness}:plugins`
        : null;
  }
};

export const findNavIndex = (
  items: ReadonlyArray<ConfigureNavItem>,
  id: string,
): number => {
  const i = items.findIndex((it) => it.id === id);
  return i === -1 ? 0 : i;
};

/** Whether this view is a "leaf" depth that should pop trail on back. */
export const isDrilledView = (view: ConfigureView): boolean =>
  view.kind === "group" ||
  view.kind === "artifact" ||
  view.kind === "reader" ||
  view.kind === "config-key" ||
  view.kind === "config-pick" ||
  view.kind === "plugin";

/**
 * Back from nav focus: collapse expanders or move cursor to parent row.
 * Returns next state patches; caller applies.
 */
export type NavBackResult =
  | { readonly action: "noop" }
  | { readonly action: "move"; readonly navId: string }
  | { readonly action: "collapse-profile" }
  | { readonly action: "collapse-harness" }
  | { readonly action: "collapse-plugins"; readonly navId: string };

export const navBackFromNavFocus = (
  item: ConfigureNavItem | undefined,
  options: {
    readonly expandedHarness: string | null;
    readonly expandedProfile: string | null;
    readonly pluginsExpanded: boolean;
  },
): NavBackResult => {
  if (!item) return { action: "noop" };

  // On an expanded profile row → collapse that profile
  if (item.kind === "profile" && options.expandedProfile === item.profileId) {
    return { action: "collapse-profile" };
  }

  // On a profile section → move to profile row (keep profile expanded)
  if (item.kind === "section" && item.profileId) {
    return { action: "move", navId: `profile:hermes:${item.profileId}` };
  }

  // On a plugin child → plugins section
  if (item.kind === "plugin") {
    const hid = options.expandedHarness ?? "claude-code";
    return { action: "move", navId: `section:${hid}:plugins` };
  }

  // Plugins section with children expanded → collapse plugin list first
  if (
    item.kind === "section" &&
    item.section === "plugins" &&
    options.pluginsExpanded
  ) {
    return {
      action: "collapse-plugins",
      navId: options.expandedHarness
        ? `section:${options.expandedHarness}:plugins`
        : item.id,
    };
  }

  // On a harness section → move to harness row
  if (item.kind === "section") {
    const parent = parentNavId(item, { expandedHarness: options.expandedHarness });
    if (parent) return { action: "move", navId: parent };
  }

  // On expanded harness row → collapse
  if (item.kind === "harness" && options.expandedHarness) {
    const id = item.id.replace(/^harness:/u, "");
    if (id === options.expandedHarness) {
      return { action: "collapse-harness" };
    }
  }

  // Profile row already collapsed — climb to hermes harness
  if (item.kind === "profile") {
    return { action: "move", navId: "harness:hermes" };
  }

  return { action: "noop" };
};

/** Push current onto trail, return new trail + next view. */
export const pushTrail = (
  trail: ReadonlyArray<ConfigureView>,
  current: ConfigureView,
  next: ConfigureView,
): { readonly trail: ReadonlyArray<ConfigureView>; readonly view: ConfigureView } => ({
  trail: [...trail, current],
  view: next,
});

/** Pop trail; if empty, null (caller should leave detail for nav). */
export const popTrail = (
  trail: ReadonlyArray<ConfigureView>,
): {
  readonly trail: ReadonlyArray<ConfigureView>;
  readonly view: ConfigureView | null;
} => {
  if (trail.length === 0) return { trail, view: null };
  const view = trail[trail.length - 1]!;
  return { trail: trail.slice(0, -1), view };
};
