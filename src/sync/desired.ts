/**
 * Desired state — what lowerers produce and the sync engine consumes
 * (docs/overhaul-one-writer-plan.md, WS5).
 *
 * Lowerers are pure: `(corpus, capabilities) → DesiredRoot`. They never touch
 * disk. The sync engine is the only code that writes harness roots.
 *
 * Two ownership shapes:
 *  - `files`: whole files Prism owns outright (generated skills, agents,
 *    hooks, commands). Full rebuild/prune authority.
 *  - `regions`: prism-named fragments inside shared user files (config.toml
 *    mcp_servers tables, opencode.json plugin arrays, mcp.json server keys).
 *    Only the fragment is Prism's; the rest of the file is never rewritten.
 */

export interface DesiredFile {
  readonly targetPath: string;
  readonly content: string;
  readonly mode?: number;
  /** Diagnostic attribution only — never identity. */
  readonly plugin: string;
}

/**
 * A fragment of a shared file. `regionKey` is unique per (targetPath, key)
 * and stable across runs; `kind` selects the editor:
 *  - `marker`: comment-fenced block (`<prefix> --- prism:<key> begin/end ---`).
 *  - `json-key`: a single JSON path owned by Prism inside a JSON/JSONC file
 *    (value replaced wholesale, formatting of the rest preserved).
 */
export type DesiredRegion =
  | {
      readonly kind: "marker";
      readonly targetPath: string;
      readonly regionKey: string;
      readonly commentPrefix: string;
      readonly commentSuffix?: string;
      readonly content: string;
      /**
       * Optional structural anchor line (exact, trim-compared). When a new
       * fence is inserted into a file that already contains the anchor line
       * (e.g. a user-owned `mcp_servers:` YAML key or `[features]` TOML
       * table header), the fence is placed directly after it so the region
       * content lands inside that structure instead of at EOF. When the
       * anchor is absent the anchor line itself is appended before the
       * fence. Without an anchor, new fences append at EOF.
       */
      readonly anchor?: string;
      readonly plugin: string;
    }
  | {
      readonly kind: "json-key";
      readonly targetPath: string;
      readonly regionKey: string;
      readonly jsonPath: ReadonlyArray<string | number>;
      readonly value: unknown;
      readonly plugin: string;
    }
  | {
      /**
       * Membership of one element in a JSON/JSONC array Prism does not own
       * wholesale (opencode.json `plugin`, kimi installed.json `plugins`,
       * pi settings.json `packages`). The region owns exactly one element,
       * identified by `memberKey` path inside the element (object members)
       * or by whole-value equality (string members). Other elements are
       * never rewritten.
       */
      readonly kind: "json-array-member";
      readonly targetPath: string;
      readonly regionKey: string;
      /** Path of the array itself. */
      readonly jsonPath: ReadonlyArray<string | number>;
      readonly value: unknown;
      /** Identity path within the element; omitted = whole-value equality. */
      readonly memberKey?: ReadonlyArray<string>;
      readonly plugin: string;
    };

export interface DesiredRoot {
  readonly harness: string;
  readonly root: string;
  readonly files: ReadonlyArray<DesiredFile>;
  readonly regions: ReadonlyArray<DesiredRegion>;
}
