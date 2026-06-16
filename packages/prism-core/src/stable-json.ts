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
    const sorted: Record<string, StableJsonValue> = {};
    for (const key of sortStableStrings(Object.keys(record))) {
      const entry = record[key];
      if (entry !== undefined) sorted[key] = stableJsonValue(entry);
    }
    return sorted;
  }
  return value;
};

export const stableJsonStringify = (value: StableJsonValue): string =>
  JSON.stringify(stableJsonValue(value));

export const stableJsonHash = (value: StableJsonValue): string =>
  createHash("sha256").update(stableJsonStringify(value)).digest("hex");
