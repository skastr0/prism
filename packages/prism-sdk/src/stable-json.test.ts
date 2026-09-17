import { expect, test } from "bun:test";
import {
  stableJsonHash,
  stableJsonStringify,
  stableJsonValue,
} from "@skastr0/prism-sdk/stable-json";

test("stableJsonStringify canonicalizes key order and drops undefined", () => {
  expect(stableJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  expect(stableJsonStringify({ b: undefined, a: 1 })).toBe('{"a":1}');
  expect(stableJsonStringify({ outer: { z: [3, 1], a: null } })).toBe(
    '{"outer":{"a":null,"z":[3,1]}}',
  );
});

test("an own __proto__ key (as produced by JSON.parse) stays serialized data", () => {
  // JSON.parse creates "__proto__" as an own enumerable data property;
  // assignment into `{}` would instead mutate the prototype and drop it.
  const parsed = JSON.parse('{"__proto__":{"risk":"high"},"a":1}') as Record<string, unknown>;
  expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);

  const serialized = stableJsonStringify(parsed as never);
  expect(serialized).toBe('{"__proto__":{"risk":"high"},"a":1}');
  // The serialized form must round-trip with the key intact.
  const roundTripped = JSON.parse(serialized) as Record<string, unknown>;
  expect(Object.prototype.hasOwnProperty.call(roundTripped, "__proto__")).toBe(true);
});

test("payloads differing only by an own __proto__ key hash differently", () => {
  const withProto = JSON.parse('{"__proto__":{"risk":"high"}}') as Record<string, unknown>;
  expect(stableJsonStringify(withProto as never)).not.toBe(stableJsonStringify({}));
  expect(stableJsonHash(withProto as never)).not.toBe(stableJsonHash({}));
});

test("stableJsonValue keeps arrays as arrays and recurses into __proto__ values", () => {
  const parsed = JSON.parse('{"list":[{"__proto__":{"x":1}}]}') as never;
  expect(stableJsonStringify(parsed)).toBe('{"list":[{"__proto__":{"x":1}}]}');
});
