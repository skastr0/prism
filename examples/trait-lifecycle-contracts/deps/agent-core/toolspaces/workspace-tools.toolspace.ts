import { defineToolspace, toolRef } from "agentpkg";

export default defineToolspace({
  name: "workspace-tools",
  description: "Logical tool vocabulary shared across examples",
  tools: {
    read_repo: {
      description: "Read repository files",
      targets: {
        opencode: { name: "read" },
        "claude-code": { name: "Read" },
      },
    },
    search_repo: {
      description: "Search repository contents",
      targets: {
        opencode: { name: "grep" },
        "claude-code": { name: "Grep" },
      },
    },
    run_shell: {
      description: "Run shell commands",
      targets: {
        opencode: { name: "bash" },
        "claude-code": { name: "Bash" },
      },
    },
  },
  groups: {
    repo_inspection: {
      description: "Read and search the repository",
      tools: [
        toolRef("workspace-tools", "read_repo"),
        toolRef("workspace-tools", "search_repo"),
      ],
    },
  },
});
