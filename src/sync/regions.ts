/**
 * Format-preserving region editors — the only way Prism touches shared user
 * files. Never a whole-document parse/re-serialize round-trip (the codex
 * config.toml indentation/comma/last_updated churn class).
 *
 * Marker regions: a comment-fenced block
 *     <prefix> --- prism:<key> begin ---
 *     ...content...
 *     <prefix> --- prism:<key> end ---
 * replaced or appended textually; everything outside the fence is preserved
 * byte-for-byte. Works for TOML (#), YAML (#), and Markdown (<!-- -->-free
 * prefix variants are the caller's choice via commentPrefix).
 *
 * JSON-key regions: jsonc-parser `modify` + `applyEdits` — minimal text
 * edits that preserve comments, key order, and indentation of everything
 * Prism does not own. Value `undefined` removes the key.
 */

import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import type { DesiredRegion } from "./desired.js";

const markerLine = (prefix: string, key: string, edge: "begin" | "end"): string =>
  `${prefix} --- prism:${key} ${edge} ---`;

const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");

export interface RegionPatchOutcome {
  readonly content: string;
  readonly changed: boolean;
}

export const renderMarkerRegion = (region: Extract<DesiredRegion, { kind: "marker" }>): string =>
  [
    markerLine(region.commentPrefix, region.regionKey, "begin"),
    region.content.replace(/\n+$/, ""),
    markerLine(region.commentPrefix, region.regionKey, "end"),
  ].join("\n");

export const applyMarkerRegion = (
  fileContent: string,
  region: Extract<DesiredRegion, { kind: "marker" }>,
): RegionPatchOutcome => {
  const rendered = renderMarkerRegion(region);
  const begin = markerLine(region.commentPrefix, region.regionKey, "begin");
  const end = markerLine(region.commentPrefix, region.regionKey, "end");
  const fence = new RegExp(`${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}`);

  if (fence.test(fileContent)) {
    const next = fileContent.replace(fence, rendered);
    return { content: next, changed: next !== fileContent };
  }

  if (region.anchor !== undefined) {
    const lines = fileContent.split("\n");
    const anchorIndex = lines.findIndex((line) => line.trim() === region.anchor!.trim());
    if (anchorIndex >= 0) {
      lines.splice(anchorIndex + 1, 0, rendered);
      return { content: lines.join("\n"), changed: true };
    }
    const separator = fileContent.length === 0 || fileContent.endsWith("\n\n")
      ? ""
      : fileContent.endsWith("\n")
        ? "\n"
        : "\n\n";
    return {
      content: `${fileContent}${separator}${region.anchor}\n${rendered}\n`,
      changed: true,
    };
  }

  const separator = fileContent.length === 0 || fileContent.endsWith("\n\n")
    ? ""
    : fileContent.endsWith("\n")
      ? "\n"
      : "\n\n";
  return { content: `${fileContent}${separator}${rendered}\n`, changed: true };
};

export const removeMarkerRegion = (
  fileContent: string,
  options: { readonly commentPrefix: string; readonly regionKey: string },
): RegionPatchOutcome => {
  const begin = markerLine(options.commentPrefix, options.regionKey, "begin");
  const end = markerLine(options.commentPrefix, options.regionKey, "end");
  const fence = new RegExp(`\\n?${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}\\n?`);
  if (!fence.test(fileContent)) return { content: fileContent, changed: false };
  return { content: fileContent.replace(fence, "\n"), changed: true };
};

const JSONC_FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

export const applyJsonKeyRegion = (
  fileContent: string,
  region: Extract<DesiredRegion, { kind: "json-key" }>,
): RegionPatchOutcome => {
  const base = fileContent.trim().length === 0 ? "{}\n" : fileContent;
  const edits = modify(base, [...region.jsonPath], region.value, {
    formattingOptions: JSONC_FORMAT,
  });
  const next = applyEdits(base, edits);
  return { content: next, changed: next !== fileContent };
};

export const removeJsonKeyRegion = (
  fileContent: string,
  jsonPath: ReadonlyArray<string | number>,
): RegionPatchOutcome => {
  if (fileContent.trim().length === 0) return { content: fileContent, changed: false };
  const edits = modify(fileContent, [...jsonPath], undefined, {
    formattingOptions: JSONC_FORMAT,
  });
  const next = applyEdits(fileContent, edits);
  return { content: next, changed: next !== fileContent };
};

const deepEquals = (left: unknown, right: unknown): boolean =>
  left === right || JSON.stringify(left) === JSON.stringify(right);

const memberIdentity = (
  value: unknown,
  memberKey: ReadonlyArray<string> | undefined,
): unknown => {
  if (memberKey === undefined) return value;
  let cursor: unknown = value;
  for (const segment of memberKey) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

const findArrayMemberIndex = (
  fileContent: string,
  jsonPath: ReadonlyArray<string | number>,
  identity: unknown,
  memberKey: ReadonlyArray<string> | undefined,
): { readonly index: number; readonly length: number } => {
  const current = readJsonKeyRegion(fileContent, jsonPath);
  if (current === undefined || current === null) return { index: -1, length: 0 };
  if (!Array.isArray(current)) {
    throw new Error(
      `region expects a JSON array at [${jsonPath.join(".")}] but found ${typeof current}`,
    );
  }
  const index = current.findIndex((element) =>
    deepEquals(memberIdentity(element, memberKey), identity),
  );
  return { index, length: current.length };
};

export const applyJsonArrayMemberRegion = (
  fileContent: string,
  region: Extract<DesiredRegion, { kind: "json-array-member" }>,
): RegionPatchOutcome => {
  const base = fileContent.trim().length === 0 ? "{}\n" : fileContent;
  const identity = memberIdentity(region.value, region.memberKey);
  const { index, length } = findArrayMemberIndex(
    base,
    region.jsonPath,
    identity,
    region.memberKey,
  );

  const path = [...region.jsonPath, index >= 0 ? index : length];
  const edits = modify(base, path, region.value, {
    formattingOptions: JSONC_FORMAT,
    isArrayInsertion: index < 0,
  });
  const next = applyEdits(base, edits);
  return { content: next, changed: next !== fileContent };
};

export const removeJsonArrayMemberRegion = (
  fileContent: string,
  options: {
    readonly jsonPath: ReadonlyArray<string | number>;
    readonly identity: unknown;
    readonly memberKey?: ReadonlyArray<string>;
  },
): RegionPatchOutcome => {
  if (fileContent.trim().length === 0) return { content: fileContent, changed: false };
  let located: { readonly index: number; readonly length: number };
  try {
    located = findArrayMemberIndex(
      fileContent,
      options.jsonPath,
      options.identity,
      options.memberKey,
    );
  } catch {
    return { content: fileContent, changed: false };
  }
  if (located.index < 0) return { content: fileContent, changed: false };
  const edits = modify(fileContent, [...options.jsonPath, located.index], undefined, {
    formattingOptions: JSONC_FORMAT,
  });
  const next = applyEdits(fileContent, edits);
  return { content: next, changed: next !== fileContent };
};

/** Current value at a region's JSON path (undefined when absent/unparseable). */
export const readJsonKeyRegion = (
  fileContent: string,
  jsonPath: ReadonlyArray<string | number>,
): unknown => {
  const parsed: unknown = parseJsonc(fileContent, [], { allowTrailingComma: true });
  let cursor: unknown = parsed;
  for (const segment of jsonPath) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  return cursor;
};

/** Apply one region of any kind to file content. */
export const applyRegion = (
  fileContent: string,
  region: DesiredRegion,
): RegionPatchOutcome => {
  switch (region.kind) {
    case "marker":
      return applyMarkerRegion(fileContent, region);
    case "json-key":
      return applyJsonKeyRegion(fileContent, region);
    case "json-array-member":
      return applyJsonArrayMemberRegion(fileContent, region);
  }
};
