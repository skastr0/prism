/**
 * Per-harness visual marks — a distinct glyph + brand-ish color so harnesses are
 * identifiable at a glance without spelling out "claude-code" everywhere. Colors
 * drawn from the Deep-Field 13-hue set; first-pass assignments, meant to iterate.
 */

export interface HarnessMark {
  readonly glyph: string;
  readonly color: string;
  readonly short: string;
}

const MARKS: Record<string, HarnessMark> = {
  "claude-code": { glyph: "✦", color: "#ff9840", short: "claude" }, // anthropic warm
  "codex-cli": { glyph: "◇", color: "#98c0e8", short: "codex" }, // openai cool steel
  opencode: { glyph: "◆", color: "#58ecff", short: "opencode" },
  openclaw: { glyph: "◈", color: "#88ff48", short: "openclaw" },
  hermes: { glyph: "⬡", color: "#b850e8", short: "hermes" },
  "antigravity-cli": { glyph: "▲", color: "#48e4b0", short: "antigrav" },
  "kimi-code": { glyph: "◐", color: "#f48c6c", short: "kimi" },
  "amp-code": { glyph: "★", color: "#f0b040", short: "amp" },
  cursor: { glyph: "▸", color: "#8080ff", short: "cursor" },
  "factory-droid": { glyph: "⊕", color: "#f0dc9c", short: "factory" },
  pi: { glyph: "π", color: "#ff58a8", short: "pi" },
  grok: { glyph: "✶", color: "#6288ff", short: "grok" },
  devin: { glyph: "◎", color: "#38c8a0", short: "devin" },
};

const FALLBACK: HarnessMark = { glyph: "●", color: "#a59878", short: "?" };

export const harnessMark = (id: string): HarnessMark => MARKS[id] ?? FALLBACK;
