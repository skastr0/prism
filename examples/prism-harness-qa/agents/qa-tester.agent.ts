import { bindTrait, defineAgent, skillRef } from "prism";

export default defineAgent({
  name: "qa-tester",
  description: "Quality-assurance tester for Prism harness parity.",
  identity: "qa-tester",
  traits: [bindTrait("qa-capable")],
  skills: [skillRef("qa-helper")],
});
