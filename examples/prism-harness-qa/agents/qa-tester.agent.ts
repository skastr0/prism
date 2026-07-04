import { modelProfileRef, skillRef, type AgentSource } from "prism";

export default {
  name: "qa-tester",
  description: "Quality-assurance tester for Prism harness parity.",
  identity: "qa-tester",
  model: modelProfileRef("qa-models", "smoke"),
  traits: ["qa-capable"],
  skills: [skillRef("qa-helper")],
} satisfies AgentSource;
