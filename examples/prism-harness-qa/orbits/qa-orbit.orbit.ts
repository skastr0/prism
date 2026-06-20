import { agentRef, defineOrbit } from "prism";

export default defineOrbit({
  name: "qa-orbit",
  description: "Compile-time contract ensuring the QA tester agent is available for harness validation.",
  phases: [
    {
      name: "Verify harness load",
      agents: [agentRef("qa-tester")],
      notes: {
        Input: "A fresh Kimi session with the generated Prism plugin loaded.",
        Done: "The QA tester role confirms the plugin is reachable and the challenge_echo tool responds.",
      },
    },
  ],
});
