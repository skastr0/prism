import { expect, test } from "bun:test";
import type { DiscoveredPlugin } from "./plugin-order.js";
import { topologicallySortedPlugins } from "./plugin-order.js";

const makePlugin = (
  name: string,
  pluginPath: string,
  deps: Record<string, string> = {},
): DiscoveredPlugin => ({
  pluginPath,
  manifest: {
    name,
    version: "0.1.0",
    targets: {},
    deps,
  },
});

test("empty plugin list returns empty array", () => {
  expect(topologicallySortedPlugins([])).toEqual([]);
});

test("single plugin returns itself", () => {
  const plugin = makePlugin("solo", "/plugins/solo");
  expect(topologicallySortedPlugins([plugin])).toEqual([plugin]);
});

test("orders owner before consumer", () => {
  const owner = makePlugin("owner", "/plugins/owner");
  const consumer = makePlugin("consumer", "/plugins/consumer", {
    core: "../owner",
  });

  expect(topologicallySortedPlugins([consumer, owner])).toEqual([owner, consumer]);
});

test("orders transitive dependencies", () => {
  const base = makePlugin("base", "/plugins/base");
  const middle = makePlugin("middle", "/plugins/middle", {
    base: "../base",
  });
  const top = makePlugin("top", "/plugins/top", {
    middle: "../middle",
  });

  const input = [top, base, middle];
  const sorted = topologicallySortedPlugins(input);
  expect(sorted).toEqual([base, middle, top]);
});

test("sorts by name when no dependencies", () => {
  const alpha = makePlugin("alpha", "/plugins/alpha");
  const beta = makePlugin("beta", "/plugins/beta");
  const gamma = makePlugin("gamma", "/plugins/gamma");

  const input = [gamma, alpha, beta];
  expect(topologicallySortedPlugins(input)).toEqual([alpha, beta, gamma]);
});

test("ignores dependencies outside the discovered set", () => {
  const consumer = makePlugin("consumer", "/plugins/consumer", {
    external: "../external",
  });

  expect(topologicallySortedPlugins([consumer])).toEqual([consumer]);
});

test("detects dependency cycles", () => {
  const a = makePlugin("a", "/plugins/a", {
    b: "../b",
  });
  const b = makePlugin("b", "/plugins/b", {
    a: "../a",
  });

  expect(() => topologicallySortedPlugins([a, b])).toThrow(
    /Dependency cycle detected/,
  );
});

test("rejects duplicate plugin names", () => {
  const a = makePlugin("same", "/plugins/a");
  const b = makePlugin("same", "/plugins/b");

  expect(() => topologicallySortedPlugins([a, b])).toThrow(
    /Duplicate plugin name/,
  );
});
