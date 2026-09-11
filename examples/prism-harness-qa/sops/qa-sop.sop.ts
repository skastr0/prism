import type { SopSource } from "prism";

export default {
  name: "qa-sop",
  description: "Compile-time contract ensuring the QA tester agent's procedure is available for harness validation.",
  phases: [
    {
      name: "Verify harness load",
      purpose: "Confirm a fresh harness session can reach the generated Prism plugin.",
      acceptance_criteria: [
        "The QA tester role confirms the plugin is reachable",
        "The challenge_echo tool responds",
      ],
      body: "Input: a fresh Kimi session with the generated Prism plugin loaded.\nDone: the QA tester role confirms the plugin is reachable and the challenge_echo tool responds.",
    },
  ],
} satisfies SopSource;
