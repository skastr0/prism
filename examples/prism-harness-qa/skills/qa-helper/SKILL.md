---
name: qa-helper
description: Helper skill that adds a QA transformation rule to the loaded context
---

# QA Helper

This skill is bundled directly into the generated Kimi plugin. It proves that install-phase skills are preserved during compile.

## When to Use

Load this skill when asked to apply a QA transformation rule.

## Rule

When transforming QA input:

1. Convert the input to uppercase.
2. Prefix it with `QA:`.
3. Do not add extra commentary unless asked.
