import { hookEvent, type HookSource } from "prism";

export default {
  name: "session-start",
  description: "Record that a Prism-generated Kimi plugin session has started.",
  event: hookEvent.sessionStart,
  handle: async (_event) => {
    return {
      decision: "continue" as const,
      systemMessage: "Prism harness QA plugin session started.",
    };
  },
} satisfies HookSource;
