import { bindTrait, defineAgent, modelProfileRef, skillRef } from "prism";

export default defineAgent({
  name: "qa-tester",
  description: "Quality-assurance tester for Prism harness parity.",
  identity: "qa-tester",
  model: modelProfileRef("qa-models", "smoke"),
  traits: [bindTrait("qa-capable")],
  skills: [skillRef("qa-helper")],
});
