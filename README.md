# spec-tacular — TypeScript (OpenTUI) implementation

spec-tacular is a terminal UI for spec-driven development layered on
[OpenSpec](https://github.com/Fission-AI/OpenSpec). It adds the review surface
OpenSpec lacks: per-requirement accept/reject/defer state, an always-visible
pipeline, gated proposal → specs → design → tasks sequencing, background agent
jobs, and guided setup. This branch is the empty base of the TypeScript
implementation (Bun, OpenTUI + Solid); each stage below lands as its own
stacked pull request.

## Stages

1. `ts/01-plan` — implementation plan, problem analysis, custom OpenSpec schema
2. `ts/02-m0-skeleton` — M0: skeleton, OpenSpec adapter, pipeline model, TUI shell
3. `ts/03-m2-review-state` — M2: review state, requirement parser, drift detection
4. `ts/04-m3-review-loop` — M3: the review loop
5. `ts/05-m4-gating` — M4: gating and the custom schema
6. `ts/06-m5-agents-jobs` — M5: agent drivers and background jobs
7. `ts/07-m6-linter` — M6: concreteness linter and the example notation
8. `ts/08-m7-foundation-adrs` — M7: Foundation, ADRs, and decision promotion
9. `ts/09-m8-deferral-roadmap` — M8: deferral, the archive split, and the roadmap
10. `ts/10-setup-advisor-vision-core` — guided setup, AI advisor, vision interview: core logic and unit tests
11. `ts/11-start-screen-guided-tui` — start screen, guided setup, vision and document screens, CLI wiring, end-to-end tests

The Rust (Ratatui) implementation lives in the separate `rust/main` stack.
