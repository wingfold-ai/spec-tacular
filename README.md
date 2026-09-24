# spec-tacular

A terminal UI for spec-driven development that builds **on top of** [OpenSpec](https://github.com/Fission-AI/OpenSpec).

OpenSpec gets the artifacts right: proposals, specs, design, tasks, archive. What it
does not give you is a **review surface**. Everything is a folder of Markdown you read
in your editor, and "done" means "the file exists". spec-tacular adds the missing half:
a keyboard-driven review loop, an explicit accept/reject state per requirement, and a
pipeline that is always visible.

## What it changes

| OpenSpec today | spec-tacular |
| --- | --- |
| Artifact is "complete" when its file exists | Artifact is complete when a human **accepted** it |
| `design` only requires `proposal` — both can be written at once | `design` requires **accepted** specs; strict `proposal → specs → design → tasks` |
| Review = reading N spec files in your editor | Review = one requirement at a time, `a`ccept / `r`eject / `e`dit / `d`efer |
| Design decisions stay local to a change | Cross-cutting decisions are **promoted to global ADRs** |
| No project ground rules before the first change | A **Foundation** phase: stack, architecture style, conventions, ADRs |
| Greenfield = 15 changes proposed at once | A **Roadmap** layer that sequences an idea into reviewable slices |
| `apply` blocks the terminal | `apply` runs in the **background** while you keep reviewing |
| A task needing a deployed env blocks archive | That task is **deferred**; the rest of the change archives |

## Try it

```bash
bun install

# Overview of every change
bun run src/cli.ts --cwd /path/to/an/openspec/project --print

# Install the schema that sequences design after specs
bun run src/cli.ts init --cwd /path/to/project

# Ask for an artifact — refused while its prerequisites are unreviewed
bun run src/cli.ts instructions design -c <change> --cwd /path/to/project

# Dispatch an agent in the background; returns immediately
bun run src/cli.ts run design -c <change> --cwd /path/to/project
bun run src/cli.ts jobs --cwd /path/to/project
```

Drop `--print` for the TUI; `enter` opens the review queue for the selected
change. `--print` renders the same model as text, so the overview also works
over a pipe and in CI.

## Status

**M0–M6 done** (M1 mostly). The review loop works: open a change, walk its
requirements one at a time, and `a`ccept / `r`eject / `d`efer / `e`dit each one
from the keyboard. Decisions persist immediately, drift is detected when a
reviewed requirement is edited afterwards, and reopening resumes where you
stopped.

Sequencing is enforced. `spectacular init` installs a schema where `design`
requires `specs` (OpenSpec's own has it require only `proposal`), and
`spectacular instructions design -c <change>` is refused — exit 1 — while any
spec requirement is unreviewed.

Agents run in the background. `spectacular run <artifact> -c <change>`
dispatches Claude Code or opencode and returns immediately, so you keep
reviewing while it works. `ctrl+j` pulls up the job pane mid-review without
losing your place.

Premature specificity gets questioned. A requirement naming an endpoint, a
column or a class it has not earned is flagged during review, and `m` marks a
value as `{{example: ...}}` — an illustration rather than a contract. Advisory
only: it never blocks a stage.

```
 The system SHALL let a user export their data in a portable format CSV,
 exposed as POST /v1/export and persisted to the user_exports table by
 `ExportController`.

   examples, not contracts: CSV

   1. names an HTTP endpoint: POST /v1/export
   2. names a field or table: user_exports
   3. names a class or symbol: ExportController
```

Tune it per project with `spec-tacular/lint.json`:

```json
{ "allow": ["tasks.md", "proposal.md", "openspec"] }
```

Verified against the largest change in the OpenSpec repo — 26 requirements,
reviewed end to end by keystroke in tests that assert on the real rendered
terminal frame.

The plan:

- [`docs/problem-analysis.md`](docs/problem-analysis.md) — each pain point traced to its
  root cause in the OpenSpec source, and what the fix has to be.
- [`docs/architecture.md`](docs/architecture.md) — stack, layering, data model, state machine.
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — milestones M0–M8 with exit criteria.
- [`docs/tui-design.md`](docs/tui-design.md) — screens, layout, keybindings.
- [`schemas/spec-tacular/schema.yaml`](schemas/spec-tacular/schema.yaml) — the custom OpenSpec
  schema that enforces the sequencing. This one is already runnable.

Start with `docs/implementation-plan.md`.

Source layout:

| Path | What |
| --- | --- |
| `src/adapter/` | The only module that knows OpenSpec exists. Reads its `--json` CLI; never writes a file OpenSpec owns. |
| `src/core/` | Pure domain logic — requirement parsing, review state, drift detection, stage derivation. Schema-agnostic and terminal-free. |
| `src/render/` | Headless text rendering, so the overview is testable and pipe-friendly. |
| `src/agent/` | Agent drivers (Claude Code, opencode). Build a command; never talk to a model directly. |
| `src/tui/` | OpenTUI + Solid screens. Deliberately thin — they draw, `core/` decides. |
