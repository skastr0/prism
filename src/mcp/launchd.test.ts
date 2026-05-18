import { expect, test } from "bun:test";
import { renderLaunchAgentPlist } from "./launchd.js";

test("LaunchAgent plist restarts failed MCP daemons with launchd throttling", () => {
  const plist = renderLaunchAgentPlist({
    label: "com.prism.mcp.prism-generated-test",
    programArguments: ["bun", "/tmp/prism/mcp/server.mjs"],
    workingDirectory: "/tmp/prism",
    environment: {
      PATH: "/usr/bin:/bin",
      PRISM_MCP_HTTP_PORT: "38463",
    },
    standardOutPath: "/tmp/prism/prism/logs/server.out.log",
    standardErrorPath: "/tmp/prism/prism/logs/server.err.log",
  });

  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).toContain("<key>SuccessfulExit</key>");
  expect(plist).toContain("<false/>");
  expect(plist).toContain("<key>ThrottleInterval</key>");
  expect(plist).toContain("<integer>30</integer>");
});
