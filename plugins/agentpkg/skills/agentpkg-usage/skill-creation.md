# Skill Creation Guide

Complete guide for creating effective skills that extend agent capabilities.

## What Skills Provide

1. **Specialized workflows** - Multi-step procedures for specific domains
2. **Tool integrations** - Instructions for file formats or APIs
3. **Domain expertise** - Company knowledge, schemas, business logic
4. **Bundled resources** - Supporting docs and assets for complex tasks

## Core Principles

### 1. Concise is Key

The context window is shared. Only add what the agent doesn't already know.

**Challenge each piece:**
- "Does the agent really need this?"
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

**Keep SKILL.md under 500 lines.** Split into sibling `.md` files when approaching this limit.

## Skill Anatomy

```
skill-name/
├── SKILL.md              # Required
├── references/           # Optional: supporting docs loaded as needed
├── scripts/              # Optional: deterministic helpers
└── assets/               # Optional: output files
```

### SKILL.md Structure

```yaml
---
name: skill-name           # REQUIRED: kebab-case identifier
description: What it does AND when to use it  # REQUIRED
# compatibility: Optional prerequisites or environment notes
---

# Skill Title

Instructions...
```

**Required frontmatter fields:**
- `name` - Kebab-case identifier (lowercase, digits, hyphens only). Max 64 chars.
- `description` - What the skill does AND when to use it. Max 1024 chars, no angle brackets.
- `compatibility` - Optional prerequisites or environment notes. Max 500 chars.

**Critical**: The `description` is the primary trigger. Include:
- What the skill does
- When to use it (specific scenarios, file types, tasks)

### Resource Types

| Type | Purpose | Example | How Used |
|------|---------|---------|----------|
| `references/` | Supporting documentation | `references/schema.md`, `references/api.md` | Read into context when needed |
| `scripts/` | Deterministic helpers | `scripts/verify_output.py` | Executed when the workflow needs reliable checks or transforms |
| `assets/` | Files for output | `template.pptx`, `logo.png` | Used directly, not read |

### What NOT to Include

**Avoid:**
- General programming knowledge the agent already has
- Installation instructions (dependency management)
- User documentation (READMEs, guides)
- Changelog, license, or contributor info

Only include what the agent needs to do the job.

## Progressive Disclosure Patterns

### Pattern 1: High-level guide with supporting files

```markdown
## Quick Start
[Essential workflow]

## Advanced
- **Forms**: See [forms.md](forms.md) for complete guide
- **API**: See [api.md](api.md) for all methods
```

### Pattern 2: Domain-specific organization

For multi-domain skills, use sibling files:

```
skill/
├── SKILL.md       # Overview + navigation
├── finance.md     # Revenue, billing metrics
├── sales.md       # Opportunities, pipeline
└── product.md     # API usage, features
```

When user asks about sales, the agent only reads `sales.md`.

### Pattern 3: Conditional details

```markdown
## Creating Documents
Use docx-js. See [docx-js.md](docx-js.md).

## Editing Documents
For simple edits, modify XML.
**For tracked changes**: See [redlining.md](redlining.md)
```

**Guidelines:**
- Keep small supporting docs close to SKILL.md; use `references/` and `scripts/` when the skill grows.
- For files >100 lines, include table of contents

## Creation Process

### Step 1: Understand with Examples

Ask clarifying questions:
- "What functionality should this skill support?"
- "Give examples of how it would be used"
- "What would a user say to trigger this?"

### Step 2: Plan Reusable Contents

For each example, analyze:
- What docs are needed repeatedly? → `references/` or sibling `.md` files
- What deterministic helpers are worth reusing? → `scripts/`
- What templates/files used in output? → `assets/`

**Example analysis:**

| Skill | Query | Resources |
|-------|-------|-----------|
| `pdf-editor` | "Fill this form" | `forms.md`, `field-types.md` |
| `brand-guidelines` | "Create branded presentation" | `assets/logo.png`, `assets/template.pptx`, `colors.md` |
| `bigquery` | "How many users today?" | `schema.md`, `common-queries.md` |

### Step 3: Initialize

```bash
agentpkg init my-plugin --with-skill
```

Or manually:

```bash
mkdir -p skills/my-skill/assets
touch skills/my-skill/SKILL.md
```

### Step 4: Write SKILL.md

**Frontmatter:**
- `name`: kebab-case (e.g., `data-analyzer`), max 64 chars
- `description`: WHAT + WHEN, max 1024 chars, no angle brackets
- `compatibility`: optional string, max 500 chars

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
- Name format (kebab-case, ≤64 chars)
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

Examples help agents understand style better than descriptions.

## Validation Checklist

- [ ] SKILL.md exists with YAML frontmatter starting with `---`
- [ ] `name` field present (REQUIRED): kebab-case, ≤64 chars
- [ ] `description` field present (REQUIRED): includes WHAT and WHEN, ≤1024 chars, no `<>`
- [ ] Body under 500 lines
- [ ] Resources properly referenced with triggers
- [ ] No unnecessary documentation files
- [ ] Tested with real examples

## Common Mistakes

1. **Missing `name` or `description`** - These are REQUIRED fields; validation will fail without them
2. **Description missing "when to use"** - Skill won't trigger properly
3. **Too much in SKILL.md** - Use sibling files for large docs
4. **No examples** - Agents learn better from examples than explanations
5. **Including user docs** - README, CHANGELOG waste context
6. **Nested subdirectories** - Keep supporting files flat alongside SKILL.md
