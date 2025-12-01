# Skill Creation Guide

Complete guide for creating effective skills that extend AI agent capabilities.

Skills follow Anthropic's Skills Specification v1.0 and work with:
- **Claude Code** - Native support
- **OpenCode** - Via `opencode-skills` plugin

## What Skills Provide

1. **Specialized workflows** - Multi-step procedures for specific domains
2. **Tool integrations** - Instructions for file formats or APIs
3. **Domain expertise** - Company knowledge, schemas, business logic
4. **Bundled resources** - References and assets for complex tasks

## Core Principles

### 1. Concise is Key

The context window is shared. Only add what Claude doesn't already know.

**Challenge each piece:**
- "Does Claude really need this?"
- "Does this justify its token cost?"

Prefer concise examples over verbose explanations.

### 2. Set Appropriate Degrees of Freedom

Match specificity to task fragility:

| Freedom | When to Use | Format |
|---------|-------------|--------|
| **High** | Multiple valid approaches | Text instructions |
| **Medium** | Preferred pattern, some variation OK | Pseudocode, parameterized examples |
| **Low** | Fragile ops, consistency critical | Exact templates, strict formats |

Think: narrow bridge with cliffs needs guardrails (low freedom); open field allows many routes (high freedom).

### 3. Progressive Disclosure

Three-level loading system:

1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - When skill triggers (<5k words)
3. **Bundled resources** - As needed (unlimited)

**Keep SKILL.md under 500 lines.** Split into reference files when approaching this limit.

## Skill Anatomy

```
skill-name/
├── SKILL.md              # Required
├── references/           # Optional: contextual docs
└── assets/               # Optional: output files
```

### SKILL.md Structure

```yaml
---
name: skill-name
description: What it does AND when to use it
---

# Skill Title

Instructions...
```

**Critical**: The `description` is the primary trigger. Include:
- What the skill does
- When to use it (specific scenarios, file types, tasks)

### Resource Types

| Type | Purpose | Example | How Used |
|------|---------|---------|----------|
| `references/` | Documentation | `schema.md`, `api.md` | Read into context when needed |
| `assets/` | Files for output | `template.pptx`, `logo.png` | Used directly, not read |

### What NOT to Include

- README.md
- INSTALLATION_GUIDE.md
- CHANGELOG.md
- Any user-facing documentation

Only include what an AI agent needs to do the job.

## Progressive Disclosure Patterns

### Pattern 1: High-level guide with references

```markdown
## Quick Start
[Essential workflow]

## Advanced
- **Forms**: See [references/forms.md](references/forms.md)
- **API**: See [references/api.md](references/api.md)
```

### Pattern 2: Domain-specific organization

For multi-domain skills:

```
skill/
├── SKILL.md (overview + navigation)
└── references/
    ├── finance.md
    ├── sales.md
    └── product.md
```

When user asks about sales, Claude only reads `sales.md`.

### Pattern 3: Conditional details

```markdown
## Creating Documents
Use docx-js. See [references/docx-js.md](references/docx-js.md).

## Editing Documents
For simple edits, modify XML.
**For tracked changes**: See [references/redlining.md](references/redlining.md)
```

**Guidelines:**
- Keep references one level deep from SKILL.md
- For files >100 lines, include table of contents

## Creation Process

### Step 1: Understand with Examples

Ask clarifying questions:
- "What functionality should this skill support?"
- "Give examples of how it would be used"
- "What would a user say to trigger this?"

### Step 2: Plan Reusable Contents

For each example, analyze:
- What docs are needed repeatedly? → `references/`
- What templates/files used in output? → `assets/`

**Example analysis:**

| Skill | Query | Resources |
|-------|-------|-----------|
| `pdf-editor` | "Fill this form" | `references/forms.md`, `references/field-types.md` |
| `brand-guidelines` | "Create branded presentation" | `assets/logo.png`, `assets/template.pptx`, `references/colors.md` |
| `bigquery` | "How many users today?" | `references/schema.md`, `references/common-queries.md` |

### Step 3: Initialize

```bash
agentpkg init my-plugin --with-skill
```

Or manually:

```bash
mkdir -p skills/my-skill/{references,assets}
touch skills/my-skill/SKILL.md
```

### Step 4: Write SKILL.md

**Frontmatter:**
- `name`: hyphen-case (e.g., `data-analyzer`), max 64 chars
- `description`: WHAT + WHEN, max 1024 chars, no angle brackets

**Body:**
- Use imperative form
- Reference resources with clear triggers
- Include working examples
- Keep under 500 lines

### Step 5: Validate

```bash
agentpkg validate ./my-plugin
```

Checks:
- YAML frontmatter format
- Required fields present
- Name format (hyphen-case, ≤64 chars)
- Description constraints (≤1024 chars, no `<` `>`)

### Step 6: Iterate

Test → Notice struggles → Update → Repeat

## Design Patterns

### Sequential Workflows

```markdown
Processing involves:
1. Analyze input
2. Transform data
3. Validate output
```

### Conditional Workflows

```markdown
1. Determine task type:
   **Creating?** → "Creation workflow"
   **Editing?** → "Editing workflow"
```

### Template Pattern

For strict output:

```markdown
ALWAYS use this template:
# [Title]
## Summary
## Findings
## Recommendations
```

### Examples Pattern

For quality-dependent output:

```markdown
**Input**: Added user auth
**Output**:
feat(auth): implement authentication

Add login endpoint
```

Examples help Claude understand style better than descriptions.

## Validation Checklist

- [ ] SKILL.md exists with YAML frontmatter
- [ ] `name`: hyphen-case, ≤64 chars, matches directory name
- [ ] `description`: includes WHAT and WHEN, ≥20 chars, ≤1024 chars, no `<>`
- [ ] Body under 500 lines
- [ ] Resources properly referenced with triggers
- [ ] No unnecessary documentation files
- [ ] Tested with real examples

## Common Mistakes

1. **Description missing "when to use"** - Skill won't trigger properly
2. **Too much in SKILL.md** - Use references for large docs
3. **No examples** - Agent learns better from examples than explanations
4. **Including user docs** - README, CHANGELOG waste context
5. **Deeply nested references** - Keep one level deep from SKILL.md
6. **Name doesn't match directory** - Must be identical (e.g., `api-dev/` → `name: api-dev`)

## Installation Paths

| Agent | Global Path | Project Path |
|-------|-------------|--------------|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| OpenCode | `~/.config/opencode/skills/` | `.opencode/skills/` |

## OpenCode Setup

To enable skills in OpenCode, add the `opencode-skills` plugin:

```json
// ~/.config/opencode/opencode.json
{
  "plugin": ["opencode-skills"]
}
```

Skills will then be auto-discovered from:
1. `~/.config/opencode/skills/` (XDG config)
2. `~/.opencode/skills/` (legacy global)
3. `.opencode/skills/` (project-local, highest priority)
