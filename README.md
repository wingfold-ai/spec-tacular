# spec-tacular

A terminal UI for spec-driven development built on OpenSpec, being rewritten in Rust with Ratatui. The previous TypeScript implementation lives on the `claude/vibrant-fermat-s72fcs` branch.

## Port plan

The Rust port lands as a stack of PRs, each building on the last:

1. Skeleton: Cargo project, CLI parsing, docs, `--help`
2. Core: markdown/requirement parsing, review state and drift, session, pipeline, gate, linter, foundation, decisions/ADRs
3. OpenSpec adapter, context bundle, init, `--print` overview, instructions/foundation/adr commands
4. Background jobs, agent drivers (claude/opencode), archive/pending/verify/roadmap commands
5. TUI shell: event loop, theme, widgets, start screen, overview, help, jobs pane (ctrl+c never quits)
6. TUI review screen, document viewer, editor integration
7. Guided setup: project stages, ground-rules screen, describe-then-name new change
8. AI advisor: structured requests, follow-ups/options/derived answers/help, name proposals, vision interview and slicing, draft opens when done, redraft with feedback
9. ACP agent integration: permission prompts in the UI, live tool/diff events, session resume
10. Release: CI workflow, release build, README

## Docs

- [`docs/rust-port.md`](docs/rust-port.md) — why the port, the stages, the stacked-PR workflow, how to build
- [`docs/architecture.md`](docs/architecture.md) — stack, layers, data model, the rules the layout enforces
- [`docs/problem-analysis.md`](docs/problem-analysis.md) — what is wrong with spec-driven development as it stands
- [`docs/tui-design.md`](docs/tui-design.md) — the interface
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — the original milestone plan

## Building

Needs a Rust toolchain and `rustup target add x86_64-unknown-linux-musl`:

```sh
cargo build --release   # one static binary, no runtime to install
cargo test
```

With no C toolchain on the machine, `. scripts/no-cc.sh` first — see
[`docs/rust-port.md`](docs/rust-port.md#building-without-a-c-toolchain).
