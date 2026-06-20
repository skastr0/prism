---
description: Generate a structured QA report for the loaded Prism plugin
---

# QA Report

Generate a short QA report confirming the Prism-generated plugin is loaded.

## Arguments

- **focus**: optional area to emphasize (`tools`, `skills`, `hooks`, `all`)

## Instructions

1. Confirm the plugin context skill was loaded at session start.
2. List the skills you can see from this plugin.
3. If `focus` is `tools` or `all`, note whether the MCP challenge_echo tool is available.
4. Return a JSON object with `{ loaded: boolean, focus: string, skills: string[] }`.
