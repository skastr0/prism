# Tools

A Prism tool is one TypeScript file with a typed input, a typed output, and one implementation. Compile turns it into a CLI any agent can call, and into a native tool where the harness has a plugin API for tools.

## Define a tool

`tools/<name>.tool.ts` default-exports a `ToolSource`:

| field | what it is |
|---|---|
| `name` | tool name |
| `description` | what the agent sees when choosing the tool |
| `input` | Effect Schema for the arguments; use `Schema.Struct({})` for none |
| `output` | Effect Schema for the result |
| `handle(input, context)` | the implementation |
| `authority` | optional: what side effects the tool has |

Example: [`examples/prism-harness-qa/tools/challenge_echo.tool.ts`](../examples/prism-harness-qa/tools/challenge_echo.tool.ts). Add the harnesses to `plugin.json -> targets.tools`.

## What compile writes

For every plugin with tools, `prism refresh` writes:

```text
~/.prism/runtime/tools/<plugin>/
├── catalog.json   tool inventory
├── runtime.mjs    the bundled handlers
└── SKILL.md       how an agent finds and calls them
```

`PRISM_HOME` moves this root. OpenCode, Amp, Pi, and Oh My Pi also register the same handlers through their own plugin APIs (`registerTool`); see [`lowerer-capability-matrix.md`](lowerer-capability-matrix.md).

## Call a tool

```text
$ prism tools list
prism-harness-qa	1 tools

$ prism tools show prism-harness-qa
tools (1):
  challenge_echo
    Returns a keyed proof that this generated Prism tool executed.

$ prism tools invoke prism-harness-qa challenge_echo --input '{"challenge":"hello"}'
{
  "challenge": "hello",
  "proof": "prism-tool-proof:hello",
  "source": "prism-generated-tool"
}

$ prism tools invoke prism-harness-qa challenge_echo --input '{"nope":1}'
{ "error": "Expected no excess property\n  at [\"nope\"]" }
```

`invoke` loads `runtime.mjs` in-process, decodes the input against the tool's schema, and prints JSON. There is no daemon and no MCP server. `prism tools skill <plugin>` prints the generated `SKILL.md`.

## How agents learn about tools

| `PRISM_TOOLS_CLI_INJECT` | effect |
|---|---|
| `skill` (default) | installs a `prism-tools-<plugin>` skill plus a short pointer in the harness rules file |
| `rules` | writes the full tool list into the harness rules file |

Set `PRISM_TOOLS_CLI_EMIT=0` to skip writing catalogs.
