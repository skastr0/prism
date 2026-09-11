import { defineTask, defineWorkflow } from "prism";
import { models } from "prism/refs/models";
import { challengeFinish, challengeOutput, challengePrompt } from "./challenge-proof";

const challenge = "hermes-2026-06-20-001";
const hermesProfile = process.env.PRISM_E2E_HERMES_PROFILE;

const verifyChallenge = defineTask({
  id: "verify-challenge",
  prompt: challengePrompt(challenge),
  output: challengeOutput,
  finish: challengeFinish(challenge),
  worker: {
    worker: "hermes",
    model: models.prismHarnessQa.qaModels.smoke,
    ...(hermesProfile !== undefined && hermesProfile.length > 0 ? { profile: hermesProfile } : {}),
  },
});

export default defineWorkflow({
  name: "hermes-smoke",
  tasks: [verifyChallenge],
});
