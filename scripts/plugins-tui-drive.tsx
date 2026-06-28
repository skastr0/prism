/**
 * Programmable headless driver for the plugins TUI — renders the REAL component
 * against REAL plugins (no sandbox) in OpenTUI's virtual terminal, runs a
 * scripted key sequence, and prints captured frames. The refinement-loop tool.
 *
 *   bun scripts/plugins-tui-drive.tsx --dir ~/Projects/prism-plugins --settle 3500 \
 *       shot:list select:cartography shot:preview tab shot:status tab d shot:doctor
 *
 * Tokens (in order):
 *   shot[:label]        capture a frame
 *   tab enter esc up down left right   named keys
 *   <single char>       e.g. j k d r a p q 1   (pressKey)
 *   select:<name>       arrow-down until the selected row matches <name>
 *   wait:<ms>           extra settle
 */
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { PluginsApp } from "../src/plugins-tui/app.js";

const raw = process.argv.slice(2);
const opts: Record<string, string> = {};
const tokens: string[] = [];
for (let i = 0; i < raw.length; i++) {
  const a = raw[i]!;
  if (a === "--dir" || a === "--settle" || a === "--width" || a === "--height" || a === "--project") {
    opts[a.slice(2)] = raw[++i] ?? "";
  } else {
    tokens.push(a);
  }
}

const dir = opts.dir ?? process.cwd();
const settleMs = opts.settle ? Number(opts.settle) : 3000;
const width = opts.width ? Number(opts.width) : 150;
const height = opts.height ? Number(opts.height) : 46;
const projectPath = opts.project ?? process.cwd();

const named: Record<string, () => void> = {};

const collapse = (frame: string): string => {
  const lines = frame.split("\n").map((l) => l.replace(/\s+$/, ""));
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    const empty = /^[│┌└─\s]*│?\s*$/.test(line) && !line.includes("┐") && !line.includes("┘");
    if (empty) {
      blanks++;
      if (blanks <= 1) out.push(line);
    } else {
      blanks = 0;
      out.push(line);
    }
  }
  return out.join("\n");
};

const main = async (): Promise<void> => {
  const setup = await testRender(<PluginsApp dir={dir} projectPath={projectPath} pollMs={600_000} />, { width, height });
  const mi = setup.mockInput;
  named.tab = () => mi.pressTab();
  named.enter = () => mi.pressEnter();
  named.esc = () => mi.pressEscape();
  named.up = () => mi.pressArrow("up");
  named.down = () => mi.pressArrow("down");
  named.left = () => mi.pressArrow("left");
  named.right = () => mi.pressArrow("right");

  const settle = async (ms = settleMs): Promise<void> => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  };
  const shot = (label: string): void => {
    process.stdout.write(`\n===== ${label} =====\n${collapse(setup.captureCharFrame())}\n`);
  };

  try {
    await settle();
    for (const token of tokens) {
      if (token.startsWith("shot")) {
        shot(token.includes(":") ? token.slice(token.indexOf(":") + 1) : "frame");
        continue;
      }
      if (token.startsWith("wait:")) {
        await settle(Number(token.slice(5)));
        continue;
      }
      if (token.startsWith("scroll:")) {
        // scroll:<dir>:<x>:<y>  e.g. scroll:down:60:8
        const [, dir, sx, sy] = token.split(":");
        await act(async () => {
          await setup.mockMouse.scroll(Number(sx ?? 0), Number(sy ?? 0), dir as "up" | "down" | "left" | "right");
        });
        await settle(150);
        continue;
      }
      if (token.startsWith("select:")) {
        const name = token.slice(7);
        const re = new RegExp(`›[^\\n]*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
        for (let i = 0; i < 60; i++) {
          if (re.test(setup.captureCharFrame())) break;
          await act(() => mi.pressArrow("down"));
          await settle(150);
        }
        await settle();
        continue;
      }
      if (named[token]) {
        await act(() => named[token]!());
      } else {
        await act(() => mi.pressKey(token));
      }
      await settle();
    }
  } finally {
    act(() => setup.renderer.destroy());
  }
};

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
