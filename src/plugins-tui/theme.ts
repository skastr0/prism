/**
 * "Deep-Field Technical" palette + text helpers — instruments in a dark room.
 * Warm graphite near-black field (never pure #000), one identity hue (prism =
 * indigo), status mapped to signal colors not generic green/red. Sourced from
 * the guilhermecastro-dev design system (globals.css) + ether brand.
 * Pure module, no side effects.
 */

export const PALETTE = {
  // ── surfaces (warm graphite near-blacks) ──
  bg: "#1a1712", // root field
  surface: "#262118", // raised panels / info boxes
  surfaceInset: "#100d08", // recessed code/JSON blocks
  // ── foreground (warm off-whites → dim) ──
  fg: "#c8bfa6", // body / descriptions
  fgMuted: "#a59878", // structural labels, tags
  fgDim: "#7d7158", // metadata, captions, idle/na  (fgFaint)
  fgBright: "#ede6d4", // titles, selected, emphasis  (off-white, never #fff)
  detail: "#c8bfa6", // alias of fg, for detail copy
  // ── identity hue: indigo (prism) ──
  accent: "#8080ff", // focus / identity stroke
  accentBright: "#c0c0ff", // apex / active-tab label
  accentDim: "#4040ac", // subdued structure / breathing base
  // ── signal colors (status maps to these, not green/red) ──
  ok: "#f0b040", // amber — deterministic/proven baseline (synced)
  running: "#58ecff", // cyan — reference/calibration (in-flight, spinner)
  warnSoft: "#b850e8", // violet — soft warning / LLM findings
  drifted: "#ff9840", // orange — drifted / stale
  danger: "#f04858", // crimson — error/blocked (hue-independent)
  // ── borders ──
  borderActive: "#8080ff", // focused pane = identity indigo
  borderInactive: "#3a3226", // idle pane / dividers
  borderEmphasis: "#564a35", // headers / busy-pane base
  selBg: "#1e1c2a", // selected-row fill (indigo-tinted warm dark)
  // ── legacy role aliases (recolored to the design system) ──
  green: "#f0b040", // ok → amber (NOT green, per DESIGN.md §09)
  red: "#f04858", // danger → crimson
  yellow: "#ff9840", // stale → orange
  orange: "#ff9840",
  blue: "#8080ff",
  cyan: "#58ecff",
  purple: "#b850e8",
} as const;

/** Text attributes bitmask (opentui): the second hierarchy axis. Italic banned. */
export const ATTR = { bold: 1, dim: 2 } as const;

/** Quiet braille spinner (the canonical "scanning" working glyph). */
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const spinnerFrame = (tick: number): string => SPINNER[Math.abs(tick) % SPINNER.length]!;

/**
 * A marching "comet" scan row of `width` cells — a 2-cell bright pair gliding
 * left→right over a dim frame each tick. Reads as an instrument measuring, not a
 * spinner. Returns the per-cell lit mask so the caller colors it.
 */
export const marchMask = (width: number, tick: number, period = 8): ReadonlyArray<boolean> => {
  const offset = ((tick % period) + period) % period;
  // Comet travels left→right (increasing i as tick advances = forward/progress).
  return Array.from({ length: Math.max(0, width) }, (_, i) => (((i - offset) % period) + period) % period < 2);
};

/** Clamp a number between min and max bounds. */
export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/**
 * Truncate to a DISPLAY-WIDTH budget (not char count) with a clean ellipsis.
 * Wide glyphs (CJK, emoji) occupy 2 cells; measuring by `.length` over-fills and
 * bleeds into the next column. `Bun.stringWidth` is native + needs no new dep.
 * Fast path: pure single-width strings (the common ASCII case) avoid the loop.
 */
export const truncate = (value: string, max = 1_200): string => {
  const width = Bun.stringWidth(value);
  if (width <= max) return value;
  if (width === value.length) return `${value.slice(0, Math.max(0, max - 1))}…`;
  let out = "";
  let used = 0;
  for (const ch of value) {
    const cw = Bun.stringWidth(ch);
    if (used + cw > max - 1) break;
    out += ch;
    used += cw;
  }
  return `${out}…`;
};

/** Stringify value as formatted JSON and truncate (clean ellipsis). */
export const jsonBlock = (value: unknown, max = 1_200): string =>
  truncate(JSON.stringify(value, null, 2), max);

export interface JsonTok {
  readonly text: string;
  readonly color: string;
}

// Catch-all last group keeps the match exhaustive so no char is dropped.
const JSON_RE = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d[\d.eE+-]*)|\b(true|false|null)\b|([{}[\],:])|(\s+)|(.)/g;

/**
 * Tokenize one line of pretty-printed JSON into colored runs (Deep-Field token
 * theme). opentui bundles no `json` tree-sitter grammar, so we color it
 * ourselves: keys=fgMuted, strings=amber, numbers=cyan, bool/null=violet,
 * punctuation=fgDim. Consecutive same-color tokens are merged to few spans.
 */
export const colorJsonLine = (line: string): ReadonlyArray<JsonTok> => {
  const toks: JsonTok[] = [];
  const push = (text: string, color: string): void => {
    const last = toks[toks.length - 1];
    if (last && last.color === color) toks[toks.length - 1] = { text: last.text + text, color };
    else toks.push({ text, color });
  };
  JSON_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_RE.exec(line)) !== null) {
    if (match[1] !== undefined) {
      if (match[2] !== undefined) {
        push(match[1], PALETTE.fgMuted); // key
        push(match[2], PALETTE.fgDim); // its colon
      } else push(match[1], PALETTE.ok); // string value (amber)
    } else if (match[3] !== undefined) push(match[3], PALETTE.running); // number (cyan)
    else if (match[4] !== undefined) push(match[4], PALETTE.warnSoft); // bool/null (violet)
    else if (match[5] !== undefined) push(match[5], PALETTE.fgDim); // punctuation
    else if (match[6] !== undefined) push(match[6], PALETTE.fgDim); // whitespace
    else if (match[7] !== undefined) push(match[7], PALETTE.fg); // anything else
  }
  return toks.length > 0 ? toks : [{ text: " ", color: PALETTE.fgDim }];
};

/** Shorten a string to 8 chars if longer than 12. */
export const shortId = (value: string): string =>
  value.length <= 12 ? value : value.slice(0, 8);
