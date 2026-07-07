import { ShimAggregator } from "../packages/prism-sdk/src/mcp/shim.ts";

const agg = new ShimAggregator({
  plugins: ["prism-harness-qa"],
  harness: "hermes",
  naming: "per-plugin",
  enabledTools: new Set(["challenge_echo"]),
});

const tools = await agg.listTools();
console.error("tools", tools.map((t) => t.name));
const result = await agg.callTool("challenge_echo", { challenge: "hermes-2026-06-20-001" });
const text = result?.content?.[0]?.text ?? JSON.stringify(result);
console.log(typeof text === "string" ? text : JSON.stringify(text));