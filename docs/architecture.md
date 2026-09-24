# Architecture

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript | OpenSpec is TypeScript and ships a library entry (`exports: "."` → `dist/index.js`, re-exporting `./core`). Same language means we can import its parsers and artifact graph instead of reimplementing them. |
| Runtime | Bun | What opencode uses; fast start matters for a CLI you open constantly. Node ≥20.19 stays supported as a fallback target. |
| TUI | **OpenTUI** (`@opentui/core`) + **SolidJS** (`@opentui/solid`) | This is exactly what opencode's TUI is built on (`packages/tui/package.json`). You said you like that UI — this is that UI's foundation, not an approximation of it. Solid's fine-grained reactivity fits a dashboard where a background job updates one pane. |
| Keybindings | `@opentui/keymap` | Same as opencode; gives leader keys and chords for free. |
| Agent execution | Pluggable driver | Claude Code / opencode / codex invoked as subprocesses. Never hardcode one vendor. |
| State | JSON sidecar files in-repo | Reviewable in git, diffable, no database, survives clone. |

**The load-bearing decision: wrap, do not fork.** `openspec/` on disk stays the
source of truth in OpenSpec's own format. spec-tacular writes only to its own
`spec-tacular/` namespace and to `.spec-tacular/` sidecars. Consequence: plain
`openspec` and any agent that knows OpenSpec keep working, and abandoning
spec-tacular costs you nothing but the review history.

## Layers

```
┌──────────────────────────────────────────────────────────┐
│  TUI  (SolidJS + OpenTUI)                                │
│  pipeline bar · review queue · job pane · ADRs · roadmap │
└──────────────────────────────────────────────────────────┘
                          │ reactive stores
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

One module, the only place that knows OpenSpec exists. Two access paths:

- **Library import** for pure reads — spec/change Markdown parsing, the artifact
  graph. These are stable, in-process, and fast.
- **Subprocess `--json`** for anything with side effects — `openspec status
  --json`, `instructions --json`, `validate --json`, `archive --json`, `new
  change`. The CLI has a broad JSON surface and is a far more stable contract
  than internal module paths.

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

```ts
interface AgentDriver {
  run(opts: {
    instruction: string          // from `openspec instructions --json`
    context: ContextBundle       // foundation + accepted ADRs + accepted specs
    cwd: string
    signal: AbortSignal
  }): AsyncIterable<AgentEvent>  // streamed into the job pane
}
```

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

## Risks

| Risk | Mitigation |
| --- | --- |
| Upstream OpenSpec changes its format | Adapter is the only coupling point; CI runs against `latest`; version range pinned. |
| Sidecar desyncs from Markdown | Content hashing resets drifted state to `pending` on every load. Never silently trust the sidecar. |
| Requirement IDs break on rename | OpenSpec's `RENAMED Requirements` delta is explicit; handle it in the parser, and fall back to a fuzzy match with a confirmation prompt. |
| Concreteness linter too noisy | Advisory only, never a gate; per-project allowlist; tune thresholds against real specs in M6. |
| Scope creep into reimplementing OpenSpec | Any PR that writes `openspec/` directly, outside the adapter, is rejected. |
