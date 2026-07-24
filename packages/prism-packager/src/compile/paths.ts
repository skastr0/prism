import { relative } from "node:path";

export const normalizeRelativePath = (from: string, to: string): string => {
  const path = relative(from, to).replace(/\\/g, "/");
  return path.length > 0 ? path : ".";
};

export const compareByStringKeys =
  <T>(
    first: (value: T) => string,
    second: (value: T) => string,
  ) =>
  (left: T, right: T): number => {
    const firstOrder = first(left).localeCompare(first(right));
    if (firstOrder !== 0) return firstOrder;
    return second(left).localeCompare(second(right));
  };
