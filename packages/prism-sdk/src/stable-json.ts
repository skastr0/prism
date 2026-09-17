import { createHash } from "node:crypto";

export type StableJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly StableJsonValue[]
  | { readonly [key: string]: StableJsonValue | undefined };

export const compareCodePoint = (left: string, right: string): number => {
  const normalizedLeft = left.normalize("NFC");
  const normalizedRight = right.normalize("NFC");
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
};

export const sortStableStrings = <T extends string>(values: Iterable<T>): T[] =>
  [...values].sort(compareCodePoint);

export const stableJsonValue = (value: StableJsonValue): StableJsonValue => {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item)) as StableJsonValue;
  }
  if (value && typeof value === "object") {
    const record = value as { readonly [key: string]: StableJsonValue | undefined };
    // Object.fromEntries defines own data properties: a "__proto__" key
    // (as produced by JSON.parse) must stay serialized data, not become a
    // prototype assignment that vanishes from JSON.stringify.
    const entries: Array<readonly [string, StableJsonValue]> = [];
    for (const key of sortStableStrings(Object.keys(record))) {
      const entry = record[key];
      if (entry !== undefined) entries.push([key, stableJsonValue(entry)]);
    }
    return Object.fromEntries(entries) as StableJsonValue;
  }
  return value;
};

export const stableJsonStringify = (value: StableJsonValue): string =>
  JSON.stringify(stableJsonValue(value));

export const stableJsonHash = (value: StableJsonValue): string =>
  createHash("sha256").update(stableJsonStringify(value)).digest("hex");
