import type { TestRendererSetup } from "@opentui/core/testing";
import { act } from "react";

export interface TestFrameWaitOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 10;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for external I/O and its React render without relying on OpenTUI's
 * scheduler-only wait. Every event-loop yield stays inside async `act`, so
 * filesystem-backed effects cannot update the component between test turns.
 */
export const actAndWaitForTestFrame = async (
  setup: TestRendererSetup,
  action: (() => void | Promise<void>) | undefined,
  predicate: (frame: string) => boolean,
  options: TestFrameWaitOptions = {},
): Promise<string> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let pendingAction = action;
  let frame = setup.captureCharFrame();

  while (true) {
    await act(async () => {
      if (pendingAction !== undefined) {
        const run = pendingAction;
        pendingAction = undefined;
        await run();
      }
      await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    });

    frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for TUI frame:\n${frame}`);
    }
  }
};

export const waitForTestFrame = (
  setup: TestRendererSetup,
  predicate: (frame: string) => boolean,
  options?: TestFrameWaitOptions,
): Promise<string> => actAndWaitForTestFrame(setup, undefined, predicate, options);
