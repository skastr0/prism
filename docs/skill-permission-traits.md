# Skill Permission Traits

Skill permission traits grant visibility to method skills without turning those skills into direct agent dependencies.

Initial orbit trait families:

- `forge-practitioner`
- `survey-practitioner`
- `scribe-practitioner`
- `beacon-practitioner`

Initial domain trait families:

- `core-engineering`
- `functional-thinking`
- `core-marketing`
- `writing-and-publishing`
- `research-practice`
- `frontend-implementation`
- `media-generation-practice`

These are capability traits, not folders of random skills. Overlap is allowed only where the same method is genuinely shared. For example, `testing` appears in engineering and functional-thinking because both families use it as a validation method; `copy-engineering` appears in marketing and writing because it is relevant to both persuasion and publication.

Traits use `skillspaceRef("agent-core", "global-skills", "<skill>")` for global harness-native skills. Direct `skills: [skillRef(...)]` remains reserved for agent-level dependencies that should appear in the generated agent body.

See `docs/agent-skill-integration-tests.md` for the fast OpenCode audit lane that verifies generated skill permissions and prompt-visible dependencies.
