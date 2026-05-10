# Release Plan

## Verdict
Ready after blockers. The repository now has the basic public project surface, but it should not be made public or published until the blockers below are resolved or explicitly accepted.

## Public Promise
Experimental. Plugin distribution system for AI coding harnesses is useful enough to inspect and try, but APIs, packaging, and support expectations may change.

## Package Publishing Boundary
Bun CLI: GitHub Releases and Homebrew for standalone binaries; npm only after adding a Node launcher plus per-platform package layout.

Do not publish from automation yet. First public release should be manual after repository visibility, registry auth, trusted publishing/token setup, and package dry-runs are reviewed.

## Blockers
- Review publish-scan confidential keyword hits (2) in ~/.local/state/publish-scan/home_Projects_prism/20260509T082535Z.
- Triage publish-scan semgrep/ast-grep findings (3/0); many are expected false positives, but they must be acknowledged before public release.

## Project-Specific Audit Notes
- Root README was added, but bundled plugin/skill provenance still needs review before public release.
- Package remains private; decide whether Prism publishes as npm, release binaries, or source-only first.
- Scan hits appear to be eval-viewer/local wording false positives; record triage.

## Minimum Before Public
- Confirm all source, docs, fixtures, prompts, screenshots, and generated artifacts are owned by the project or safe to publish.
- Re-run publish-scan and review the latest output directory.
- Run the verification commands below on a clean checkout.
- Enable GitHub secret scanning, push protection, Dependabot alerts, and private vulnerability reporting before or immediately after the visibility flip.
- Keep registry publishing disabled until dry-runs and package contents are inspected.

## Verification
- bun run verify
- bun run typecheck
- bun run build

## First Publish Steps
1. Keep the repository private and finish blocker cleanup.
2. Run local verification and publish-scan.
3. Inspect package contents with npm pack/bun publish --dry-run or cargo package --list, depending on the project.
4. Make the repository public only after the public files and security settings are ready.
5. Publish manually to the chosen registry or create a draft GitHub Release.
6. Add Homebrew tap/formula work only after the first release asset shape is stable.

## Latest Scan
- Latest publish-scan output: ~/.local/state/publish-scan/home_Projects_prism/20260509T082535Z
- Confidential keyword hits: 2
- Security keyword hits: 8
- Semgrep/ast-grep hits: 3/0

## Notes
- License: MIT.
- Package scope target: @skastr0 for npm packages.
- Actual npm, crates.io, GitHub Release, and Homebrew publication remains intentionally out of scope for this prep pass.
