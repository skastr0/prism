---
description: Run tests with coverage
# targets: [claude-code, opencode]  # Uncomment to limit to specific agents

# Agent-specific overrides:
# claude-code:
#   allowed-tools: [Bash]
# opencode:
#   mode: subagent
---

Run the test suite with coverage reporting.

## Arguments

- **Test pattern or file**: $1 (optional - runs all tests if not provided)
- **Additional flags**: $ARGUMENTS (for free-form flags like --watch --verbose)

## Examples

```bash
/test                           # Run all tests
/test src/utils                 # Run tests matching "src/utils"
/test "user auth" --watch       # Run "user auth" tests in watch mode
```

## Instructions

1. Run tests matching $1 (or all tests if empty)
2. Generate coverage report
3. Highlight any failures with clear explanations
4. Summarize results at the end
