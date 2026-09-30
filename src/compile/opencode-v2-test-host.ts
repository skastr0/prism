/** Minimal host using the public @opencode/plugin 2.0.20 Promise contracts. */
export interface TestTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute(input: unknown, context: { sessionID: string; agent: string; signal: AbortSignal }): Promise<{ content: string }>;
}

export const createOpenCodeV2TestHost = () => {
  const tools = new Map<string, TestTool>();
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const transforms: Array<(editor: { add(tool: TestTool): void }) => void> = [];
  const events: any[] = [];
  let wake: (() => void) | undefined;
  let subscriptionSignal: AbortSignal | undefined;
  let closed = false;
  const sessions = new Map<string, any>();
  const registration = { async dispose() {} };
  const hook = (domain: string) => async (name: string, callback: (event: any) => Promise<void>) => {
    hooks.set(`${domain}.${name}`, callback);
    return registration;
  };
  const context = {
    location: { directory: "/setup", project: { id: "setup-project", directory: "/setup", canonical: "/setup" } },
    tool: {
      async transform(callback: (editor: { add(tool: TestTool): void }) => void) {
        transforms.push(callback);
        const result = callback({ add: (tool) => tools.set(tool.name, tool) });
        if (result !== undefined) throw new Error("tool transform must be synchronous");
        return registration;
      },
      hook: hook("tool"),
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        const session = sessions.get(sessionID);
        if (!session) throw new Error(`missing session ${sessionID}`);
        return session;
      },
      hook: hook("session"),
    },
    permission: { hook: hook("permission") },
    worktree: { async list() { return [{ directory: "/worktree" }]; } },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        subscriptionSignal = signal;
        const onAbort = () => wake?.();
        signal.addEventListener("abort", onAbort);
        try {
          while (!signal.aborted) {
            if (events.length > 0) yield events.shift();
            else await new Promise<void>((resolve) => { wake = resolve; });
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
          closed = true;
        }
      },
    },
  };
  sessions.set("session", { id: "session", projectID: "other-project", title: "Live session", agent: "stale-agent", location: { directory: "/worktree/src" }, tokens: { input: 10, output: 5, reasoning: 2 }, cost: 0.02 });
  return {
    context, tools, hooks, sessions,
    replay() {
      tools.clear();
      for (const callback of transforms) callback({ add: (tool) => tools.set(tool.name, tool) });
    },
    emit(event: any) { events.push(event); wake?.(); },
    get subscriptionSignal() { return subscriptionSignal; },
    get closed() { return closed; },
  };
};
