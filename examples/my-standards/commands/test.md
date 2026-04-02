---
description: Run tests with coverage
# No file-level targets. Install targeting lives in plugin.json -> targets.commands

# Agent-specific overrides:
# claude-code:
#   allowed-tools: [Bash]
# opencode:
#   mode: subagent
---

Run the test suite with coverage reporting.

## Arguments

- **Test pattern or flags**: $ARGUMENTS (optional - runs all tests if not provided)

## Examples

```bash
/test                           # Run all tests
/test src/utils                 # Run tests matching "src/utils"
/test "user auth" --watch       # Run "user auth" tests in watch mode
```

## Instructions

1. Run tests matching $ARGUMENTS (or all tests if empty)
2. Generate coverage report
3. Highlight any failures with clear explanations
4. Summarize results at the end
