---
name: skill-creator
description: Guide for creating effective skills that extend Claude's capabilities. Use when users want to create a new skill, update an existing skill, or learn about skill design patterns. Triggers on requests like "create a skill", "build a skill", "make a skill for X", or "help me design a skill".
---

# Skill Creator

Guide for creating effective skills that extend Claude's capabilities.

## What Skills Provide

1. **Specialized workflows** - Multi-step procedures for specific domains
2. **Tool integrations** - Instructions for working with file formats or APIs
3. **Domain expertise** - Company-specific knowledge, schemas, business logic
4. **Bundled resources** - References and assets for complex tasks

## Core Principles

### Concise is Key

The context window is shared. Only add context Claude doesn't already have.

**Challenge each piece:**
- "Does Claude really need this explanation?"
- "Does this justify its token cost?"

Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

Match specificity to task fragility:

| Freedom | When to Use | Format |
|---------|-------------|--------|
| **High** | Multiple valid approaches, context-dependent | Text instructions |
| **Medium** | Preferred pattern exists, some variation OK | Pseudocode, parameterized examples |
| **Low** | Fragile operations, consistency critical | Exact templates, strict formats |

Think: narrow bridge with cliffs needs guardrails (low freedom); open field allows many routes (high freedom).

### Progressive Disclosure

Three-level loading system:

1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - When skill triggers (<5k words, keep under 500 lines)
3. **Bundled resources** - As needed (unlimited, loaded on demand)

## Skill Anatomy

```
skill-name/
├── SKILL.md              # Required: YAML frontmatter + markdown instructions
├── *.md                  # Optional: supporting docs loaded into context as needed
└── assets/               # Optional: templates, images, fonts for output
```

### SKILL.md Structure

```yaml
---
name: skill-name           # REQUIRED: hyphen-case identifier
description: What it does AND when to use it (this triggers the skill)  # REQUIRED
---

# Skill Title

Instructions for using the skill...
```

**Required frontmatter fields:**
- `name` - Hyphen-case identifier (lowercase, digits, hyphens only). Max 64 chars.
- `description` - What the skill does AND when to use it. Max 1024 chars, no angle brackets.

**Critical**: The `description` field is the primary trigger mechanism. Include BOTH:
- What the skill does
- When to use it (specific scenarios, file types, tasks)

### Bundled Resources

| Type | Purpose | Example | How Used |
|------|---------|---------|----------|
| `*.md` | Docs loaded when needed | `api.md`, `schema.md` | Read into context |
| `assets/` | Files used in output | `template.pptx`, `logo.png` | Used directly, not read |

### What NOT to Include

- README.md (for users)
- INSTALLATION_GUIDE.md
- CHANGELOG.md
- Any auxiliary documentation

Only include what an AI agent needs to do the job.

## Progressive Disclosure Patterns

Keep SKILL.md under 500 lines. Split large content into reference files:

**Pattern 1: High-level guide with supporting files**

```markdown
## Quick Start
[Essential workflow here]

## Advanced Features
- **Form filling**: See [forms.md](forms.md) for complete guide
- **API reference**: See [api.md](api.md) for all methods
```

**Pattern 2: Domain-specific organization**

For multi-domain skills, organize with sibling files:

```
bigquery-skill/
├── SKILL.md       # Overview + navigation
├── finance.md     # Revenue, billing metrics
├── sales.md       # Opportunities, pipeline
└── product.md     # API usage, features
```

When user asks about sales metrics, Claude only reads `sales.md`.

**Pattern 3: Conditional details**

```markdown
## Creating Documents
Use docx-js for new documents. See [docx-js.md](docx-js.md).

## Editing Documents
For simple edits, modify XML directly.
**For tracked changes**: See [redlining.md](redlining.md)
```

**Guidelines:**
- Keep supporting files as siblings to SKILL.md (flat structure)
- For files >100 lines, include table of contents at top

## Skill Creation Process

### 1. Understand with Concrete Examples

Ask clarifying questions:
- "What functionality should this skill support?"
- "Give examples of how it would be used"
- "What would a user say that should trigger this?"

Conclude when you have clear sense of the functionality needed.

### 2. Plan Reusable Contents

For each example, analyze:
- What documentation is needed repeatedly? → sibling `.md` files
- What templates/files are used in output? → `assets/`

**Example analysis for a `pdf-editor` skill:**
- Query: "Help me fill this PDF form"
- Analysis: Need form field documentation, validation rules
- Result: `forms.md`, `field-types.md` (alongside SKILL.md)

**Example analysis for a `brand-guidelines` skill:**
- Query: "Create a presentation with our branding"
- Analysis: Need logo files, color specs, templates
- Result: `assets/logo.png`, `colors.md`, `assets/template.pptx`

### 3. Initialize the Skill

Use agentpkg to create the structure:

```bash
agentpkg init my-plugin --with-skill
```

Or manually create:

```bash
mkdir -p skills/my-skill/assets
touch skills/my-skill/SKILL.md
```

### 4. Write SKILL.md

**Frontmatter:**
- `name`: hyphen-case identifier (e.g., `data-analyzer`), max 64 chars
- `description`: WHAT + WHEN, max 1024 chars, no angle brackets

**Body guidelines:**
- Use imperative/infinitive form
- Reference resources with clear triggers ("See X when doing Y")
- Include working examples over explanations
- Keep under 500 lines

### 5. Validate

Use agentpkg to validate:

```bash
agentpkg validate ./my-plugin
```

Checks:
- YAML frontmatter format
- Required fields (name, description)
- Name format (hyphen-case, ≤64 chars)
- Description constraints (≤1024 chars, no angle brackets)

### 6. Iterate

Test on real tasks → Notice struggles → Update skill → Repeat

## Design Patterns

See [workflows.md](workflows.md) for workflow patterns.
See [output-patterns.md](output-patterns.md) for output patterns.

### Sequential Workflows

```markdown
Processing involves these steps:
1. Analyze input (examine structure)
2. Transform data (apply rules)
3. Validate output (check constraints)
```

### Conditional Workflows

```markdown
1. Determine the task type:
   **Creating new?** → Follow "Creation workflow"
   **Editing existing?** → Follow "Editing workflow"
```

### Template Pattern

For strict output requirements:

```markdown
## Report Structure

ALWAYS use this template:
# [Title]
## Executive Summary
## Key Findings
## Recommendations
```

### Examples Pattern

For quality-dependent output, provide input/output pairs:

```markdown
## Commit Message Format

**Input**: Added user auth with JWT
**Output**:
feat(auth): implement JWT authentication

Add login endpoint and token validation
```

Examples help Claude understand style better than descriptions.
