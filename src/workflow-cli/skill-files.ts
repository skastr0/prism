/**
 * One file of an embedded Prism skill.
 *
 * A skill is a directory: `SKILL.md` carries the frontmatter and the routing
 * body, and sibling markdown under `references/` carries the depth. Both the
 * PRISM_HOME materialization (`prism workflow skill --write`) and the harness
 * install (`prism workflow skill --install`) write this same list, so the two
 * surfaces can never disagree about what a skill contains.
 */

export interface EmbeddedSkillFile {
  /** Path relative to the skill's own directory, e.g. `SKILL.md` or `references/scheduling.md`. */
  readonly relativePath: string;
  readonly markdown: string;
}

/** An embedded skill: its directory name plus every file that belongs in it. */
export interface EmbeddedSkill {
  readonly name: string;
  readonly files: readonly EmbeddedSkillFile[];
}
