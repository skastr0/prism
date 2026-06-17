import { defineHook, hookEvent } from "prism";

export default defineHook({
  name: "session-start",
  description: "Record that a Prism-generated Kimi plugin session has started.",
  event: hookEvent.sessionStart,
  handle: async (_event) => {
    return {
      decision: "continue" as const,
      systemMessage: "Prism harness QA plugin session started.",
    };
  },
});
