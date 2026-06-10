import { expect, test } from "bun:test";
import { Effect } from "effect";
import { resolvePrismHome } from "../prism-home.js";
import { PrismHome, PrismHomeLive, PrismHomeTest } from "./prism-env.js";

test("PrismHomeTest provides an in-memory home without touching the environment", async () => {
  const home = await Effect.runPromise(
    Effect.gen(function* () {
      const env = yield* PrismHome;
      return env.home;
    }).pipe(Effect.provide(PrismHomeTest("/virtual/prism-home"))),
  );

  expect(home).toBe("/virtual/prism-home");
});

test("PrismHomeLive resolves the (sandboxed) environment exactly once per runtime", async () => {
  const program = Effect.gen(function* () {
    const first = yield* PrismHome;
    const second = yield* PrismHome;
    return [first, second] as const;
  }).pipe(Effect.provide(PrismHomeLive));

  const [first, second] = await Effect.runPromise(program);

  // The test preload sandboxes PRISM_HOME before any module loads.
  expect(first.home).toBe(resolvePrismHome());
  expect(first).toBe(second);
});
