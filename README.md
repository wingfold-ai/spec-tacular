# spec-tacular

A terminal UI for spec-driven development built on OpenSpec, being rewritten in Rust with Ratatui. The previous TypeScript implementation lives on the `claude/vibrant-fermat-s72fcs` branch.

## Port plan

The Rust port lands as a stack of PRs, each building on the last:

1. Skeleton: Cargo project, CLI parsing, docs, `--help`
2. Core: markdown/requirement parsing, review state and drift, session, pipeline, gate, linter
3. OpenSpec adapter, context bundle, foundation, decisions/ADRs, init, `--print` overview, instructions/foundation/adr commands
4. Background jobs, agent drivers (claude/opencode), archive/pending/verify/roadmap commands
5. TUI shell: event loop, theme, widgets, start screen, overview, help, jobs pane (ctrl+c never quits)
6. TUI review screen, document viewer, editor integration
7. Guided setup: project stages, ground-rules screen, describe-then-name new change
8. AI advisor: structured requests, follow-ups/options/derived answers/help, name proposals, vision interview and slicing, draft opens when done, redraft with feedback
9. ACP agent integration: permission prompts in the UI, live tool/diff events, session resume
10. Release: CI workflow, release build, README
