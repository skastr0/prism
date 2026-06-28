import { describe, it, expect } from "bun:test";
import { buildIntrospection } from "./introspect.js";
import { emptyRegistry } from "../compile/registry.js";

describe("buildIntrospection", () => {
  it("builds introspection from populated registry", () => {
    const registry = emptyRegistry(
      "/test/plugin",
      "test-plugin",
      "1.0.0",
    );

    // Populate some maps with test data
    registry.agents.set("agent-a", {
      name: "agent-a",
      description: "First agent",
    } as never);
    registry.agents.set("agent-b", {
      name: "agent-b",
      description: "Second agent",
    } as never);

    registry.orbits.set("orbit-x", {
      name: "orbit-x",
      description: "Test orbit",
    } as never);

    registry.tools.set("tool-1", {
      name: "tool-1",
      description: "A tool",
    } as never);

    // Don't populate skills, hooks, etc. to test the count=0 case

    const result = buildIntrospection(registry);

    expect(result.pluginName).toBe("test-plugin");
    expect(result.orbitSkillCount).toBe(1); // 1 orbit
    expect(result.groups).toHaveLength(3); // agents, orbits, tools (skipping empty ones)

    // Check agents group
    const agentGroup = result.groups.find((g) => g.noun === "agent");
    expect(agentGroup).toBeDefined();
    expect(agentGroup!.noun).toBe("agent");
    expect(agentGroup!.count).toBe(2);
    expect(agentGroup!.entries).toHaveLength(2);
    expect(agentGroup!.entries[0]!.name).toBe("agent-a");
    expect(agentGroup!.entries[0]!.summary).toBe("First agent");
    expect(agentGroup!.entries[1]!.name).toBe("agent-b");
    expect(agentGroup!.entries[1]!.summary).toBe("Second agent");

    // Check orbits group
    const orbitGroup = result.groups.find((g) => g.noun === "orbit");
    expect(orbitGroup).toBeDefined();
    expect(orbitGroup!.count).toBe(1);
    expect(orbitGroup!.entries[0]!.name).toBe("orbit-x");
    expect(orbitGroup!.entries[0]!.summary).toBe("Test orbit");

    // Check tools group
    const toolGroup = result.groups.find((g) => g.noun === "tool");
    expect(toolGroup).toBeDefined();
    expect(toolGroup!.count).toBe(1);
    expect(toolGroup!.entries[0]!.name).toBe("tool-1");
    expect(toolGroup!.entries[0]!.summary).toBe("A tool");
  });

  it("handles entries without description", () => {
    const registry = emptyRegistry(
      "/test/plugin",
      "test-plugin-2",
      "1.0.0",
    );

    registry.skills.set("skill-no-desc", {
      name: "skill-no-desc",
      // no description property
    } as never);

    const result = buildIntrospection(registry);

    expect(result.groups).toHaveLength(1);
    const skillGroup = result.groups[0]!;
    expect(skillGroup.noun).toBe("skill");
    expect(skillGroup.entries[0]!.summary).toBeUndefined();
    expect(skillGroup.entries[0]!.json).toBeDefined();
  });

  it("sorts entries by name", () => {
    const registry = emptyRegistry(
      "/test/plugin",
      "test-plugin-3",
      "1.0.0",
    );

    // Add in non-alphabetical order
    registry.hooks.set("zebra", { name: "zebra", description: "Z" } as never);
    registry.hooks.set("apple", { name: "apple", description: "A" } as never);
    registry.hooks.set("mango", { name: "mango", description: "M" } as never);

    const result = buildIntrospection(registry);

    const hookGroup = result.groups.find((g) => g.noun === "hook")!;
    expect(hookGroup.entries[0]!.name).toBe("apple");
    expect(hookGroup.entries[1]!.name).toBe("mango");
    expect(hookGroup.entries[2]!.name).toBe("zebra");
  });

  it("returns empty groups array for empty registry", () => {
    const registry = emptyRegistry(
      "/test/plugin",
      "empty-plugin",
      "1.0.0",
    );

    const result = buildIntrospection(registry);

    expect(result.pluginName).toBe("empty-plugin");
    expect(result.orbitSkillCount).toBe(0);
    expect(result.groups).toHaveLength(0);
  });

  it("preserves full value in json field", () => {
    const registry = emptyRegistry(
      "/test/plugin",
      "test-plugin-4",
      "1.0.0",
    );

    const complexValue = {
      name: "complex",
      description: "A complex entry",
      extra: { nested: { data: 123 } },
      array: [1, 2, 3],
    };

    registry.identities.set("complex", complexValue as never);

    const result = buildIntrospection(registry);

    const identityGroup = result.groups[0]!;
    expect(identityGroup.entries[0]!.json).toEqual(complexValue);
  });
});
