# Output Patterns

Patterns for producing consistent, high-quality output from skills.

## Template Pattern

Provide templates when output format matters. Match strictness to requirements.

### Strict Requirements

For API responses, data formats, or compliance documents:

```markdown
## Report Structure

ALWAYS use this exact template:

# [Analysis Title]

## Executive Summary
[One-paragraph overview of key findings]

## Key Findings
- Finding 1 with supporting data
- Finding 2 with supporting data
- Finding 3 with supporting data

## Recommendations
1. Specific actionable recommendation
2. Specific actionable recommendation
```

### Flexible Guidance

When adaptation is useful:

```markdown
## Report Structure

Sensible default format - adjust as needed:

# [Title]
## Summary
## Findings
## Recommendations

Adapt sections based on what you discover.
```

## Examples Pattern

For skills where output quality depends on seeing examples, provide input/output pairs:

```markdown
## Commit Message Format

Generate commit messages following these examples:

**Example 1:**
Input: Added user authentication with JWT tokens
Output:
```
feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware
```

**Example 2:**
Input: Fixed bug where dates displayed incorrectly in reports
Output:
```
fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation
```

Follow this style: type(scope): brief description, then detailed explanation.
```

Examples help Claude understand the desired style and level of detail more clearly than descriptions alone.

## Checklist Pattern

For quality assurance or multi-criteria validation:

```markdown
## Code Review Checklist

Before approving, verify:

- [ ] No security vulnerabilities (SQL injection, XSS, etc.)
- [ ] Error handling covers edge cases
- [ ] Tests cover new functionality
- [ ] Documentation updated if API changed
- [ ] No hardcoded secrets or credentials
```

## Format Specification Pattern

For structured data output:

```markdown
## API Response Format

All responses must follow this JSON structure:

{
  "status": "success" | "error",
  "data": { ... } | null,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  } | null,
  "metadata": {
    "timestamp": "ISO8601",
    "version": "1.0"
  }
}

Never include additional top-level fields.
```
