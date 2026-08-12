/**
 * Clipboard helpers for configure TUI editor.
 * Prefer macOS pbcopy/pbpaste; fall back to OSC 52 write when available.
 */

import type { CliRenderer } from "@opentui/core";

export const writeClipboard = async (
  text: string,
  renderer?: CliRenderer | null,
): Promise<boolean> => {
  // 1) Platform tools (reliable for paste back into other apps)
  try {
    if (process.platform === "darwin") {
      const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(text);
      proc.stdin.end();
      const code = await proc.exited;
      if (code === 0) return true;
    } else if (process.platform === "linux") {
      for (const cmd of [
        ["xclip", "-selection", "clipboard"],
        ["wl-copy"],
      ] as const) {
        try {
          const proc = Bun.spawn([...cmd], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          });
          proc.stdin.write(text);
          proc.stdin.end();
          if ((await proc.exited) === 0) return true;
        } catch {
          // try next
        }
      }
    }
  } catch {
    // fall through
  }

  // 2) Terminal OSC 52 (copy into terminal host clipboard when supported)
  try {
    if (renderer && typeof renderer.copyToClipboardOSC52 === "function") {
      return renderer.copyToClipboardOSC52(text);
    }
  } catch {
    // ignore
  }
  return false;
};

export const readClipboard = async (): Promise<string | null> => {
  try {
    if (process.platform === "darwin") {
      const proc = Bun.spawn(["pbpaste"], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(proc.stdout).text();
      if ((await proc.exited) === 0) return out;
    } else if (process.platform === "linux") {
      for (const cmd of [
        ["xclip", "-selection", "clipboard", "-o"],
        ["wl-paste", "-n"],
      ] as const) {
        try {
          const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "ignore" });
          const out = await new Response(proc.stdout).text();
          if ((await proc.exited) === 0) return out;
        } catch {
          // try next
        }
      }
    }
  } catch {
    return null;
  }
  return null;
};
