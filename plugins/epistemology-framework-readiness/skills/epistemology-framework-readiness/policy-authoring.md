# Policy Authoring Guide

Complete guidance for authoring `.opencode/policy.toml` guardrails that match the live epistemology framework plugin/runtime behavior.

## Table of Contents

1. [File Location and Discovery](#file-location-and-discovery)
2. [Policy Schema](#policy-schema)
3. [Rule Structure](#rule-structure)
4. [Match Conditions](#match-conditions)
5. [Actions](#actions)
6. [Content Matchers](#content-matchers)
7. [Include and Merge Behavior](#include-and-merge-behavior)
8. [Session Commands](#session-commands)
9. [Complete Examples](#complete-examples)

## File Location and Discovery

Policy files are discovered in this order:

1. **Project policy**: `.opencode/policy.toml` (relative to workspace root)
2. **Global policy**: `~/.config/opencode/.opencode/policy.toml`
3. **Environment overrides**:
   - `OPENCODE_POLICY_GUARDRAIL_CONFIG` — override project policy path
   - `OPENCODE_POLICY_GUARDRAIL_GLOBAL_CONFIG` — override global policy path

Policy loads at session start and applies to all tool invocations. Changes require session restart to take effect.

## Policy Schema

```toml
version = 1  # Required. Must be exactly 1.

# Optional: include other policy files
includes = [
  "./policies/secrets.toml",
  "./policies/destructive.toml"
]

# Rule definitions
[[rules]]
id = "rule-identifier"           # Required: unique rule ID
match = ["glob/pattern/**"]      # Required: path patterns to match
tools_include = [...]            # Optional: tools this rule watches
tools_exclude = [...]            # Optional: tools this rule ignores
scope = "changed_lines"            # Optional: "changed_lines" or "all"
content_mode = "additions_only"    # Optional: "additions_only" or "all"

# Actions to take when rule matches
actions = [
  { type = "...", ... }
]
```

## Rule Structure

### Required Fields

- `id`: Unique identifier for the rule. Used in logs and override messages.
- `match`: Array of glob patterns for file paths. Matches are relative to workspace root.

### Optional Fields

- `tools_include`: Array of tool names. Rule only triggers for these tools. If omitted, rule applies to all tools.
- `tools_exclude`: Array of tool names. Rule never triggers for these tools.
- `scope`: `"changed_lines"` (default) or `"all"`. Controls whether content matchers only see changed lines or entire files.
- `content_mode`: `"additions_only"` (default) or `"all"`. Controls whether content matchers see deletions.

### Match Patterns

Glob patterns support standard syntax:

- `**/*.ts` — all TypeScript files
- `src/**/*.test.ts` — test files in src
- `**/.env*` — environment files
- `**/{secrets,credentials,keys}/**` — multiple path segments
- `!**/generated/**` — negation (exclude generated files)

## Match Conditions

Rules match when ALL conditions are true:

1. Target file path matches at least one `match` pattern
2. Tool name is in `tools_include` (if specified)
3. Tool name is NOT in `tools_exclude` (if specified)
4. Content matchers succeed (if specified)

## Actions

When a rule matches, its actions execute in order. The first blocking action stops further execution.

### `block_tool`

Prevent the tool invocation entirely.

```toml
[[rules]]
id = "block-secrets"
match = ["**/.env*", "**/secrets/**"]
tools_include = ["read", "edit", "write"]

actions = [
  { type = "block_tool", message = "Direct access to secrets is blocked. Use 1Password CLI or a secret manager." }
]
```

### `require_human_override`

Block until explicit human approval.

```toml
[[rules]]
id = "destructive-ops"
match = ["**/*.tf", "**/infrastructure/**"]
tools_include = ["bash"]

actions = [
  { type = "require_human_override", message = "Infrastructure changes require explicit human review." }
]
```

### `require_work_item`

Block until a valid work item is active.

```toml
[[rules]]
id = "tracked-changes"
match = ["src/core/**/*.ts"]
tools_include = ["edit", "write", "apply_patch"]

actions = [
  { type = "require_work_item", message = "Core changes require an active SDLC work item." }
]
```

### `ensure_skill_loaded`

Require specific skills to be loaded before proceeding.

```toml
[[rules]]
id = "policy-edits"
match = [".opencode/policy.toml"]
tools_include = ["edit", "write"]

actions = [
  { type = "ensure_skill_loaded", skills = ["epistemology-framework-readiness"], mode = "block" },
  { type = "require_human_override", message = "Policy changes need explicit review." }
]
```

Modes:
- `"block"` — hard block until skills are loaded
- `"warn"` — warning only, proceed if skills unavailable

### `inject_prompt`

Inject text into the agent context before proceeding.

```toml
[[rules]]
id = "database-changes"
match = ["**/migrations/**", "**/schema/**"]
tools_include = ["edit", "write", "bash"]

actions = [
  { type = "inject_prompt", prompt = "DATABASE CHANGE DETECTED: Verify migration rollback plan and test strategy before proceeding." }
]
```

### `stop_session`

Immediately terminate the session. Use sparingly for critical violations.

```toml
[[rules]]
id = "no-prod-direct"
match = ["**/production/**", "**/prod/**"]
tools_include = ["bash", "edit", "write"]

actions = [
  { type = "stop_session", message = "Direct production access is strictly prohibited." }
]
```

## Content Matchers

Content matchers analyze file content beyond path matching. They support `ast_grep` and `semgrep` patterns.

### ast_grep Matcher

Uses ast-grep structural search patterns.

```toml
[[rules]]
id = "no-eval"
match = ["**/*.ts", "**/*.js"]
tools_include = ["edit", "write", "apply_patch"]

[rules.content_matchers]
ast_grep = [
  { pattern = 'eval($$$)' },
  { pattern = 'new Function($$$)' }
]

actions = [
  { type = "require_human_override", message = "Dynamic code execution detected. Verify security implications." }
]
```

### semgrep Matcher

Uses Semgrep patterns for broader language support.

```toml
[[rules]]
id = "no-hardcoded-secrets"
match = ["**/*.py", "**/*.js", "**/*.ts"]
tools_include = ["edit", "write", "apply_patch"]

[rules.content_matchers]
semgrep = [
  { pattern = 'password = "..."', languages = ["python", "javascript", "typescript"] },
  { pattern = 'api_key = "..."', languages = ["python", "javascript", "typescript"] }
]

actions = [
  { type = "block_tool", message = "Hardcoded credentials detected. Use environment variables or a secret manager." }
]
```

### Scope and Content Mode

**`scope` parameter:**
- `"changed_lines"` (default): Content matchers only see lines changed in the edit
- `"all"`: Content matchers see entire file content

**`content_mode` parameter:**
- `"additions_only"` (default): Content matchers only see added lines
- `"all"`: Content matchers see both additions and deletions

These are powerful for reviewing diffs vs. entire files:

```toml
[[rules]]
id = "review-api-changes"
match = ["src/api/**/*.ts"]
tools_include = ["edit", "apply_patch"]
scope = "changed_lines"        # Only look at what is being changed
content_mode = "additions_only"  # Only look at additions

[rules.content_matchers]
ast_grep = [
  { pattern = 'export async function $NAME($$$)' }
]

actions = [
  { type = "inject_prompt", prompt = "API CHANGE: Verify backward compatibility and update API documentation." }
]
```

## Include and Merge Behavior

Policy files can include other policy files for modularity.

### Include Syntax

```toml
version = 1

# Single include
includes = "./policies/secrets.toml"

# Multiple includes
includes = [
  "./policies/secrets.toml",
  "./policies/destructive.toml",
  "./policies/compliance.toml"
]
```

### Merge Semantics

When multiple policy files are loaded, rules are merged with these semantics:

1. **Rule IDs must be unique** across all included files. Duplicate IDs cause load errors.
2. **Includes are processed depth-first** in the order declared.
3. **Later includes can reference earlier includes** but not vice versa.
4. **Circular includes are rejected** at load time.

### Global + Project Policy Merge

When both global and project policies exist:

1. Global policy loads first
2. Project policy loads second
3. Rules are combined (IDs must still be unique across both)
4. Project rules take precedence for same-match conflicts

Best practice: Use global policy for personal/developer guardrails, project policy for codebase-specific rules.

## Session Commands

The `/policy` command family provides runtime policy interaction.

### `/policy override <reason>`

Temporarily override a blocking policy action for the current tool invocation.

Usage:
```
/policy override "Emergency fix for production outage"
```

Requirements:
- Must provide explicit reason string
- Reason is logged to `.agents/messages/`
- Override applies to next tool invocation only

### `/policy skill-loaded <skill...>`

Declare that required skills are now loaded.

Usage:
```
/policy skill-loaded epistemology-framework-readiness sdlc
```

Use this when:
- A rule requires specific skills via `ensure_skill_loaded`
- You have manually loaded the required skills
- You want the policy runtime to know skills are available

## Complete Examples

### Example 1: Production Guardrails

`.opencode/policy.toml`:
```toml
version = 1

[[rules]]
id = "no-prod-bash"
match = ["**/production/**", "**/prod/**", "**/deploy/**"]
tools_include = ["bash"]
actions = [
  { type = "stop_session", message = "Direct production shell access is prohibited." }
]

[[rules]]
id = "prod-config-review"
match = ["**/production/**/config.*", "**/prod.*.yaml", "**/prod.*.yml"]
tools_include = ["edit", "write", "apply_patch"]
actions = [
  { type = "require_human_override", message = "Production configuration changes require SRE approval." },
  { type = "inject_prompt", prompt = "PRODUCTION CONFIG: Verify change is tested in staging. Document rollback plan." }
]
```

### Example 2: Security and Secrets

`.opencode/policy.toml`:
```toml
version = 1

[[rules]]
id = "block-secret-files"
match = [
  "**/.env*",
  "**/secrets/**",
  "**/*.key",
  "**/*.pem",
  "**/credentials*",
  "**/token*"
]
tools_include = ["read", "edit", "write", "grep"]
actions = [
  { type = "block_tool", message = "Secret material is blocked. Use 1Password CLI or your secret manager." }
]

[[rules]]
id = "secret-policy-maintenance"
match = [".opencode/policy.toml"]
tools_include = ["edit", "write"]
actions = [
  { type = "require_human_override", message = "Policy changes affect security boundaries. Verify with security team." }
]
```
