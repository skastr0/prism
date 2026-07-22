import { expect, test } from "bun:test";
import { computeContentHash } from "./content-hash.js";

test("computeContentHash is stable for the same content", () => {
  expect(computeContentHash("hello")).toBe(computeContentHash("hello"));
  expect(computeContentHash("hello")).not.toBe(computeContentHash("world"));
});

test("computeContentHash accepts Uint8Array", () => {
  expect(computeContentHash(new TextEncoder().encode("hello"))).toBe(computeContentHash("hello"));
});
