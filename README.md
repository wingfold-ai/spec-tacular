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
bun run src/cli.ts --cwd /path/to/an/openspec/project --print
```

Drop `--print` for the TUI. `--print` renders the same model as text, so the
overview also works over a pipe and in CI.

## Status

**M0 done** — reads a real OpenSpec project and renders the pipeline for every
change. M1 (always-visible overview) partly done. See the plan for what's next.

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
| `src/core/` | Pure domain logic — stage derivation, gating. Schema-agnostic and terminal-free. |
| `src/render/` | Headless text rendering, so the overview is testable and pipe-friendly. |
| `src/tui/` | OpenTUI + Solid shell. Deliberately thin. |
