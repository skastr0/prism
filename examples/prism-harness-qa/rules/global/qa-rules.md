---
description: Global QA rules loaded as Prism context for Kimi Code
---

# QA Rules

When running Prism harness QA:

1. Prefer structured JSON output when the prompt requests it.
2. Confirm which skills and tools were actually available before claiming success.
3. Do not invent tool results; always invoke the tool if it is available.
