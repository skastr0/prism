import { describe, expect, test } from "bun:test";
import {
  findNavIndex,
  navBackFromNavFocus,
  parentNavId,
  popTrail,
  pushTrail,
  viewFromNavItem,
  type ConfigureNavItem,
  type ConfigureView,
} from "./nav.js";

describe("viewFromNavItem", () => {
  test("harness and profile → summary", () => {
    expect(viewFromNavItem({ id: "harness:x", kind: "harness", label: "x" })).toEqual({
      kind: "summary",
    });
    expect(
      viewFromNavItem({ id: "profile:hermes:ada", kind: "profile", profileId: "ada", label: "ada" }),
    ).toEqual({ kind: "summary" });
    expect(
      viewFromNavItem({
        id: "project:claude-code:app",
        kind: "project",
        projectId: "app",
        label: "app",
      }),
    ).toEqual({ kind: "summary" });
  });

  test("section summary vs other", () => {
    expect(
      viewFromNavItem({
        id: "s",
        kind: "section",
        section: "summary",
        label: "Summary",
      }),
    ).toEqual({ kind: "summary" });
    expect(
      viewFromNavItem({
        id: "s",
        kind: "section",
        section: "skills",
        label: "Skills",
      }),
    ).toEqual({ kind: "section", section: "skills" });
    expect(
      viewFromNavItem({
        id: "s",
        kind: "section",
        section: "memories",
        label: "Memories",
      }),
    ).toEqual({ kind: "section", section: "memories" });
  });
});

describe("parentNavId", () => {
  test("profile section → profile row", () => {
    expect(
      parentNavId(
        {
          id: "section:hermes:profile:ada:skills",
          kind: "section",
          section: "skills",
          profileId: "ada",
          label: "Skills",
        },
        { expandedHarness: "hermes" },
      ),
    ).toBe("profile:hermes:ada");
  });

  test("shared section → harness", () => {
    expect(
      parentNavId(
        { id: "section:codex-cli:skills", kind: "section", section: "skills", label: "Skills" },
        { expandedHarness: "codex-cli" },
      ),
    ).toBe("harness:codex-cli");
  });

  test("plugin → plugins section", () => {
    expect(
      parentNavId(
        { id: "plugin:claude-code:tower", kind: "plugin", plugin: "tower", label: "tower" },
        { expandedHarness: "claude-code" },
      ),
    ).toBe("section:claude-code:plugins");
  });

  test("project section → project row", () => {
    expect(
      parentNavId(
        {
          id: "section:claude-code:project:app:memories",
          kind: "section",
          section: "memories",
          projectId: "app",
          label: "Memories",
        },
        { expandedHarness: "claude-code" },
      ),
    ).toBe("project:claude-code:app");
  });

  test("project row → harness", () => {
    expect(
      parentNavId(
        { id: "project:claude-code:app", kind: "project", projectId: "app", label: "app" },
        { expandedHarness: "claude-code" },
      ),
    ).toBe("harness:claude-code");
  });
});

describe("navBackFromNavFocus", () => {
  const harness: ConfigureNavItem = {
    id: "harness:hermes",
    kind: "harness",
    label: "Hermes",
  };
  const profile: ConfigureNavItem = {
    id: "profile:hermes:ada07",
    kind: "profile",
    profileId: "ada07",
    label: "ada07",
  };
  const profileSkills: ConfigureNavItem = {
    id: "section:hermes:profile:ada07:skills",
    kind: "section",
    section: "skills",
    profileId: "ada07",
    label: "Skills",
  };
  const sharedSkills: ConfigureNavItem = {
    id: "section:hermes:skills",
    kind: "section",
    section: "skills",
    label: "Skills",
  };
  const project: ConfigureNavItem = {
    id: "project:claude-code:app",
    kind: "project",
    projectId: "app",
    label: "app",
  };
  const projectMemories: ConfigureNavItem = {
    id: "section:claude-code:project:app:memories",
    kind: "section",
    section: "memories",
    projectId: "app",
    label: "Memories",
  };

  test("profile section → move to profile", () => {
    expect(
      navBackFromNavFocus(profileSkills, {
        expandedHarness: "hermes",
        expandedProfile: "ada07",
        expandedProject: null,
        pluginsExpanded: false,
      }),
    ).toEqual({ action: "move", navId: "profile:hermes:ada07" });
  });

  test("expanded profile row → collapse profile", () => {
    expect(
      navBackFromNavFocus(profile, {
        expandedHarness: "hermes",
        expandedProfile: "ada07",
        expandedProject: null,
        pluginsExpanded: false,
      }),
    ).toEqual({ action: "collapse-profile" });
  });

  test("shared section → move to harness", () => {
    expect(
      navBackFromNavFocus(sharedSkills, {
        expandedHarness: "hermes",
        expandedProfile: null,
        expandedProject: null,
        pluginsExpanded: false,
      }),
    ).toEqual({ action: "move", navId: "harness:hermes" });
  });

  test("expanded harness → collapse", () => {
    expect(
      navBackFromNavFocus(harness, {
        expandedHarness: "hermes",
        expandedProfile: null,
        expandedProject: null,
        pluginsExpanded: false,
      }),
    ).toEqual({ action: "collapse-harness" });
  });

  test("project section → move to project", () => {
    expect(
      navBackFromNavFocus(projectMemories, {
        expandedHarness: "claude-code",
        expandedProfile: null,
        expandedProject: "app",
        pluginsExpanded: false,
      }),
    ).toEqual({ action: "move", navId: "project:claude-code:app" });
  });

  test("expanded project row → collapse project", () => {
    expect(
      navBackFromNavFocus(project, {
        expandedHarness: "claude-code",
        expandedProfile: null,
        expandedProject: "app",
        pluginsExpanded: false,
      }),
    ).toEqual({ action: "collapse-project" });
  });

  test("collapsed project row → harness", () => {
    expect(
      navBackFromNavFocus(project, {
        expandedHarness: "claude-code",
        expandedProfile: null,
        expandedProject: null,
        pluginsExpanded: false,
      }),
    ).toEqual({ action: "move", navId: "harness:claude-code" });
  });
});

describe("trail stack", () => {
  test("push and pop restore parent", () => {
    const root: ConfigureView = { kind: "section", section: "skills" };
    const group: ConfigureView = { kind: "group", groupId: "skill:foo" };
    const afterPush = pushTrail([], root, group);
    expect(afterPush.trail).toHaveLength(1);
    expect(afterPush.view).toEqual(group);
    const afterPop = popTrail(afterPush.trail);
    expect(afterPop.view).toEqual(root);
    expect(afterPop.trail).toHaveLength(0);
    expect(popTrail([]).view).toBeNull();
  });

  test("reader back is not hardcoded to skills", () => {
    const identity: ConfigureView = { kind: "section", section: "identity" };
    const group: ConfigureView = { kind: "group", groupId: "soul" };
    const reader: ConfigureView = {
      kind: "reader",
      path: "/x/SOUL.md",
      title: "SOUL",
      text: "hi",
      truncated: false,
      scroll: 0,
    };
    let trail: ReadonlyArray<ConfigureView> = [];
    let view: ConfigureView = identity;
    ({ trail, view } = pushTrail(trail, view, group));
    ({ trail, view } = pushTrail(trail, view, reader));
    let popped = popTrail(trail);
    expect(popped.view?.kind).toBe("group");
    popped = popTrail(popped.trail);
    expect(popped.view).toEqual(identity);
  });
});

describe("findNavIndex", () => {
  test("finds id or 0", () => {
    const items: ConfigureNavItem[] = [
      { id: "a", kind: "harness", label: "a" },
      { id: "b", kind: "harness", label: "b" },
    ];
    expect(findNavIndex(items, "b")).toBe(1);
    expect(findNavIndex(items, "missing")).toBe(0);
  });
});
