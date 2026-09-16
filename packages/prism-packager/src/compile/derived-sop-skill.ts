/**
 * Derived SOP skill rendering.
 *
 * Harness lowerers each emit a SKILL.md per source SOP. The structured content
 * of that SKILL.md is identical across harnesses; only the frontmatter format
 * varies. This module owns the structured body so all lowerers stay aligned.
 *
 * A SOP is a type-safe procedure: it may say what must be true, and never
 * names who executes it, with what tool, or in what runtime. The rendering
 * therefore covers only the procedure itself — phases, typed phase I/O,
 * acceptance criteria, escalation, and prose. There is no orchestrator, tool,
 * trait, submission-protocol, transition, definition, or checkpoint material.
 */

import { composeSopPhaseReference } from "./compose.js";
import { tryWorkflowJsonSchemaFromEffectSchema } from "../workflow-output-schema.js";
import { jsonSchemaToEffectSchemaSource } from "./workflow-refs-emitter.js";
import type { Schema } from "effect";
import type { NormalizedSopPhase as SopPhase, Sop } from "./sources.js";

const sectionHeader = (level: number, text: string): string =>
  `${"#".repeat(level)} ${text}`;

const singleLine = (value: string): string =>
  value.replace(/\s*\n+\s*/gu, " ").trim();

const escapeTableCell = (value: string): string =>
  singleLine(value).replace(/\|/gu, "\\|");

const renderPhaseTable = (sop: Sop, lines: string[]): void => {
  if (sop.phases.length === 0) return;

  lines.push("## Phases", "");
  lines.push("| Phase | Purpose | Contract | Reference |");
  lines.push("| --- | --- | --- | --- |");
  for (const phase of sop.phases) {
    const reference = composeSopPhaseReference(phase);
    lines.push(
      `| ${escapeTableCell(phase.name)} | ${escapeTableCell(phase.purpose)} | ${escapeTableCell(reference.label)} | [\`references/${phase.name}.md\`](references/${phase.name}.md) |`,
    );
  }
  lines.push("");
};

const renderBodySection = (sop: Sop, lines: string[]): void => {
  const trimmed = sop.body.trim();
  if (trimmed.length === 0) return;
  lines.push(trimmed, "");
};

/**
 * Render the body of a SOP SKILL.md.
 *
 * The output starts with `# <name>`, the description, a phase overview table,
 * and ends with the free-form cross-phase body (when present). Frontmatter is
 * the lowerer's responsibility.
 */
export const renderDerivedSopSkillBody = (sop: Sop): string => {
  const lines: string[] = [];
  lines.push(`# ${sop.name}`, "");
  lines.push(sop.description, "");
  lines.push(
    "_A type-safe procedure. Each phase links to its full reference file under `references/`._",
    "",
  );

  renderPhaseTable(sop, lines);
  renderBodySection(sop, lines);

  return lines.join("\n");
};

export interface SopPhaseReferenceFile {
  /** Filename relative to the SOP's `references/` folder, e.g., `build.md`. */
  readonly filename: string;
  /** Markdown body of the reference file. */
  readonly content: string;
}

const renderSchemaSummary = (
  schema: Schema.Top,
): string | undefined => {
  const json = tryWorkflowJsonSchemaFromEffectSchema(schema);
  if (!json) {
    return "_Schema summary unavailable (schema is outside the JSON Schema bridge subset); see the source SOP._";
  }

  try {
    const source = jsonSchemaToEffectSchemaSource(
      json as unknown as Record<string, unknown>,
      "schema",
    );
    return ["```ts", source, "```"].join("\n");
  } catch {
    return ["```json", JSON.stringify(json, null, 2), "```"].join("\n");
  }
};

const renderSchemaSection = (
  heading: string,
  schema: Schema.Top | undefined,
  lines: string[],
): void => {
  if (!schema) return;
  const summary = renderSchemaSummary(schema);
  if (!summary) return;
  lines.push(sectionHeader(2, heading), "", summary, "");
};

const renderAcceptanceCriteria = (
  phase: SopPhase,
  lines: string[],
): void => {
  if (phase.acceptanceCriteria.length === 0) return;
  lines.push("## Acceptance criteria", "");
  for (const criterion of phase.acceptanceCriteria) {
    lines.push(`- ${criterion.trim()}`);
  }
  lines.push("");
};

const renderEscalation = (phase: SopPhase, lines: string[]): void => {
  if (!phase.escalation) return;
  lines.push("## Escalation", "", phase.escalation.trim(), "");
};

/**
 * Render one reference file per SOP phase. The file carries the full phase
 * download: purpose, typed input/output contract summary, acceptance
 * criteria, escalation rule, and the hand-authored phase body.
 */
export const renderDerivedSopPhaseReferences = (
  sop: Sop,
): ReadonlyArray<SopPhaseReferenceFile> =>
  sop.phases.map((phase) => {
    const lines: string[] = [];
    lines.push(`# ${sop.name}:${phase.name}`, "");
    lines.push(
      `_Phase reference for the **${phase.name}** phase of the **${sop.name}** SOP. The SOP SKILL.md carries the cross-phase frame; this file is the full download for this phase specifically._`,
      "",
    );

    lines.push("## Purpose", "", phase.purpose.trim(), "");
    renderSchemaSection("Input", phase.input as Schema.Top | undefined, lines);
    renderSchemaSection("Output", phase.output as Schema.Top | undefined, lines);
    renderAcceptanceCriteria(phase, lines);
    renderEscalation(phase, lines);

    const body = phase.body.trim();
    if (body.length > 0) {
      lines.push(body, "");
    }

    return {
      filename: `${phase.name}.md`,
      content: lines.join("\n"),
    };
  });
