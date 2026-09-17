import { defineWorkflow, jev } from "prism";

/**
 * Tab triage via TypeSafe System One (Jev): ONE request answers a list of
 * questions about a shared state. The batching doctrine, in one workflow:
 *
 * - All items travel in `state` (strings/objects/arrays/null only).
 * - Every question pins its subject in `instructions` — the question id does
 *   NOT bind the question to a state item on its own.
 * - One jev() task replaces a fan-out of per-tab agent calls; run 150 tabs
 *   the same way (shard the state past the ~28k-token request budget, keep
 *   the questions).
 *
 * Requires TYPESAFE_API_KEY. Rehearse for free:
 *   prism workflow run jev-routing.workflow.ts --mock-output jev-routing.mocks.json
 */

const tabRoute = {
  keep: "actively needed in the next day or two",
  park: "worth keeping as reference; not active",
  close: "stale, duplicated, or answered — safe to close",
} as const;

const triageTabs = jev({
  id: "triage-tabs",
  cacheKey: "jev-tab-triage-v1",
  state: {
    tabs: [
      { id: "t1", title: "Effect Schema v4 — README", url: "https://effect.website/docs", note: "docs tab, open since yesterday, referenced twice today" },
      { id: "t2", title: "github.com/skastr0/prism/pull/41", url: "https://github.com/skastr0/prism/pull/41", note: "open PR on the workflow store, awaiting my review" },
      { id: "t3", title: "TypeSafe System One — concepts", url: "https://docs.typesafe.ai/concepts/system-one", note: "read in full; integration shipped" },
      { id: "t4", title: "Hacker News front page", url: "https://news.ycombinator.com", note: "scanning habit, nothing saved" },
      { id: "t5", title: "Bun v1.3 release notes", url: "https://bun.com/blog", note: "skimmed; one section on test sharding still relevant" },
      { id: "t6", title: "aws console — billing", url: "https://console.aws.amazon.com/billing", note: "checked this month; nothing anomalous" },
    ],
  },
  questions: {
    // Per-tab routing: 6 bound questions (subject named in instructions).
    t1_route: { type: "choice", instructions: "About state item t1 ('Effect Schema v4 — README', docs tab referenced twice today)", criteria: tabRoute },
    t2_route: { type: "choice", instructions: "About state item t2 ('github.com/skastr0/prism/pull/41', open PR awaiting my review)", criteria: tabRoute },
    t3_route: { type: "choice", instructions: "About state item t3 ('TypeSafe System One — concepts', read in full, work shipped)", criteria: tabRoute },
    t4_route: { type: "choice", instructions: "About state item t4 ('Hacker News front page', scanning habit, nothing saved)", criteria: tabRoute },
    t5_route: { type: "choice", instructions: "About state item t5 ('Bun v1.3 release notes', skimmed, one test-sharding section still relevant)", criteria: tabRoute },
    t6_route: { type: "choice", instructions: "About state item t6 ('aws console — billing', checked this month, nothing anomalous)", criteria: tabRoute },
    // Global questions over the whole state in the SAME request.
    actionable_count: {
      type: "score",
      instructions: "Across ALL tabs in state, how many need concrete action from me this week (a review, a reply, a follow-up)?",
      criteria: ["none need action", "one or two need action", "three or more need action"],
    },
    any_credential_risk: {
      type: "noul",
      instructions: "Is any tab in state an authenticated console or account page that should not linger open in a shared-screen situation?",
      criteria: { true: "at least one tab is an authenticated console/account page", false: "no such tabs" },
    },
  },
});

export default defineWorkflow({
  name: "jev-tab-triage",
  tasks: [triageTabs],
});
