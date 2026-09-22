# Architecture

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Language | **Rust** | The TypeScript implementation cost 2.9 s to start and 127 MB of `node_modules` for a tool you open dozens of times a day. Rust gives a single static binary that starts in under a millisecond and needs no runtime installed. The trade made: OpenSpec's parsers can no longer be imported, so the handful spec-tacular depends on are ported and cited line by line (`core/markdown.rs`). |
| Distribution | One static binary | `cargo build --release` against `x86_64-unknown-linux-musl` produces a stripped, statically linked executable well under a megabyte. Nothing to install, nothing to keep in sync with a runtime. |
| TUI | **Ratatui** + **crossterm** | An immediate-mode terminal library over a portable backend. Immediate mode suits a dashboard whose panes are derived from state that a background job keeps changing: there is no widget tree to keep in sync, only a render of the current model. crossterm also lets ctrl+c arrive as a *key event* rather than a signal, which is what makes "ctrl+c never quits" implementable rather than aspirational. |
| Async | **tokio** (`rt-multi-thread`, `process`, `sync`, `time`) | One runtime for the three things that must happen at once: drawing, reading keys (`crossterm`'s `event-stream`), and streaming a subprocess agent's output into the job pane. |
| CLI | **clap** (derive) | The command surface is a contract — `--print` is used in CI — so it is declared once, checked at build time, and renders its own help. |
| Serialisation | **serde** + `serde_json` / `serde_yml` | `openspec --json` output, the review sidecars and the roadmap, all parsed into typed structs that ignore unknown fields, so an upstream addition is never a breaking change. |
| Agent execution | Pluggable driver | Claude Code / opencode / codex invoked as subprocesses, streaming JSON today. **ACP** (the Agent Client Protocol) replaces the transport later, behind the same trait: permission prompts and tool/diff events in the UI, resumable sessions. Never hardcode one vendor. |
| State | JSON sidecar files in-repo | Reviewable in git, diffable, no database, survives clone. |

**The load-bearing decision: wrap, do not fork.** `openspec/` on disk stays the
source of truth in OpenSpec's own format. spec-tacular writes only to its own
`spec-tacular/` namespace and to `.spec-tacular/` sidecars. Consequence: plain
`openspec` and any agent that knows OpenSpec keep working, and abandoning
spec-tacular costs you nothing but the review history.

## Layers

```
┌──────────────────────────────────────────────────────────┐
│  TUI  (Ratatui + crossterm, tokio event loop)             │
│  pipeline bar · review queue · job pane · ADRs · roadmap │
└──────────────────────────────────────────────────────────┘
                          │ renders the model
┌──────────────────────────────────────────────────────────┐
│  Core                                                     │
│  review state · gating · concreteness linter ·            │
│  decision promotion · deferral/archive split · roadmap    │
└──────────────────────────────────────────────────────────┘
        │                        │                     │
┌───────────────┐   ┌─────────────────────┐   ┌──────────────┐
│ OpenSpec      │   │ Agent drivers       │   │ Job runner   │
│ adapter       │   │ claude / opencode   │   │ background   │
└───────────────┘   └─────────────────────┘   └──────────────┘
        │
┌──────────────────────────────────────────────────────────┐
│ Filesystem:  openspec/  (OpenSpec's)                     │
│              spec-tacular/  .spec-tacular/  (ours)       │
└──────────────────────────────────────────────────────────┘
```

### OpenSpec adapter

One module, the only place that knows OpenSpec exists. One access path:

- **Subprocess `--json`** for everything — `openspec status --json`,
  `instructions --json`, `validate --json`, `archive --json`, `new change`. The
  CLI has a broad JSON surface and is a far more stable contract than internal
  module paths.

The TypeScript implementation also imported OpenSpec's parsers in-process. A
Rust binary cannot, so the few parsing rules spec-tacular genuinely needs are
ported into `core/markdown.rs` with the upstream file they came from cited
beside them. Agreeing with OpenSpec about what a requirement *is* is a
correctness requirement, not a convenience, so divergence there is a bug.

Rule: never write a file OpenSpec owns except through OpenSpec. Guarantees
format compatibility across upstream versions.

Pin a tested OpenSpec version range and run a compatibility suite in CI against
`latest`, so an upstream change surfaces as a failing test rather than a
corrupted `openspec/` directory in someone's repo.

## Data model

### On disk

```
openspec/                        # OpenSpec owns this. We read; we write via its CLI.
  specs/                         # accepted baseline
  changes/<change>/              # proposal.md, specs/**, design.md, tasks.md
  schemas/spec-tacular/          # our schema (see schemas/spec-tacular/schema.yaml)

spec-tacular/                    # ours, human-facing, committed
  foundation/
    stack.md  architecture.md  conventions.md
  decisions/
    0001-<slug>.md               # global ADRs
  roadmap.yaml                   # vision → ordered slices
  pending-validation.md          # deferred requirements register

.spec-tacular/                   # ours, machine state, committed
  review/<change>.json           # per-requirement review state
  jobs/<job-id>.json             # background job records
```

### Review state

```jsonc
{
  "change": "add-status-next-step",
  "schemaVersion": 1,
  "requirements": {
    "cli-artifact-workflow#next-artifact-discovery": {
      "state": "accepted",        // pending | accepted | rejected | deferred
      "hash": "sha256:8f3a…",     // hash of the requirement's normalized text
      "reviewedAt": "2026-09-21T10:12:00Z",
      "note": "…",                // why it was rejected
      "deferReason": "…"          // e.g. "awaiting-deployment"
    }
  }
}
```

Requirements are keyed flat rather than nested per artifact: the id already
carries the capability, and only one artifact in a change holds requirements.

**Requirement identity** is `<capability-path>#<slugified-requirement-name>`.
OpenSpec's requirement headers (`### Requirement: <name>`) are the only stable
handle available, and renames are explicit in its delta format
(`RENAMED Requirements`, FROM:/TO:), so a rename is detectable rather than
looking like a delete plus an add.

**The hash is what makes this safe.** On every load, spec-tacular re-hashes each
requirement's normalized text and compares. A mismatch means the text changed
after review, so the state resets to `pending` and the UI marks it *changed
since you accepted it*. This is what keeps the sidecar honest when someone
(you, or an agent) edits Markdown outside the TUI — which they will.

Normalization collapses whitespace and drops blank lines, so reformatting a
spec does not revoke an acceptance, but any change to the words does. A tool
that punished you for tidying a file would just teach you not to tidy files.

### Gating

An artifact is **accepted** when every requirement it contains is `accepted` or
`deferred`, and no requirement's hash has drifted.

The pipeline advances only on acceptance:

```
foundation ─▶ roadmap ─▶ proposal ─▶ specs ─▶ design ─▶ tasks ─▶ apply ─▶ archive
             (accepted)  (accepted) (accepted) (accepted) (accepted) (all done
                                                                      or deferred)
```

This is enforced twice, deliberately:

- **In the schema** (`design.requires: [specs]`) so that a plain `openspec` run,
  or an agent that bypasses the TUI, still gets the right order.
- **In spec-tacular's core**, which additionally requires *acceptance*, not just
  file existence — the part the schema cannot express.

## Agent drivers

```rust
trait AgentDriver {
    /// `instruction` comes from `openspec instructions --json`; `context` is
    /// the foundation, the accepted ADRs and the accepted specs. Events are
    /// streamed into the job pane as they arrive, and the token cancels the
    /// run.
    fn run(&self, req: AgentRequest, cancel: CancellationToken)
        -> impl Stream<Item = AgentEvent>;
}
```

The transport behind this trait is a subprocess emitting JSON lines today and
ACP later. The trait is what the rest of the program sees either way, which is
what keeps the switch a change to `agent/` alone.

Every agent call receives the Foundation documents and accepted ADRs in its
context bundle. That is the mechanism by which ground rules actually constrain
generated specs and designs, rather than being documentation nobody reads.

## Background jobs

Long operations (`apply`, artifact generation, validation sweeps) are dispatched
to a job runner and never block the UI. A job is a record in
`.spec-tacular/jobs/`, survives a TUI restart, and reattaches on launch. The
review loop and a running `apply` are concurrent by construction — that is the
point of §7 in the problem analysis, and the reason the TUI is event-driven
rather than a prompt loop.

Concurrency rule: at most one job may write to a given change at a time. Reviews
are reads and always allowed.

## The rule that holds it together

`core/` contains no terminal code and no subprocess code. It takes plain data
in and returns plain data out. `adapter/` is the only module that knows
OpenSpec exists. Everything else follows from those two sentences: the review
loop is tested without a terminal, `--print` and the TUI are two renderings of
one model rather than two implementations of one feature, and swapping or
stubbing OpenSpec is a change to one directory.

## Risks

| Risk | Mitigation |
| --- | --- |
| Upstream OpenSpec changes its format | Adapter is the only coupling point; CI runs against `latest`; version range pinned. |
| Ported parsers drift from OpenSpec's | Each rule cites the upstream file it came from, and the compatibility suite parses real OpenSpec fixtures. |
| Sidecar desyncs from Markdown | Content hashing resets drifted state to `pending` on every load. Never silently trust the sidecar. |
| Requirement IDs break on rename | OpenSpec's `RENAMED Requirements` delta is explicit; handle it in the parser, and fall back to a fuzzy match with a confirmation prompt. |
| Concreteness linter too noisy | Advisory only, never a gate; per-project allowlist; tune thresholds against real specs in M6. |
| Scope creep into reimplementing OpenSpec | Any PR that writes `openspec/` directly, outside the adapter, is rejected. |
| Terminal or subprocess code leaking into `core/` | Same rule, same answer: rejected in review. `core/` depends on neither ratatui nor tokio's process module. |
