# Problem analysis

Every pain point below was traced to a specific place in the OpenSpec source
(read at `@fission-ai/openspec` v1.13.1). This matters because it decides
whether spec-tacular can **configure** OpenSpec, **wrap** it, or must **replace**
part of it — and those have very different costs.

---

## 1. Design is written before specs are settled

**Root cause — confirmed in source.** `schemas/spec-driven/schema.yaml`:

```yaml
- id: design
  requires:
    - proposal      # <- not specs
- id: tasks
  requires:
    - specs
    - design
```

`design` depends only on `proposal`. The artifact graph therefore treats both
`specs` and `design` unblocked at the same moment, and the agent writes them in
one pass. Your objection is correct and it is a real dependency bug for the way
you want to work: a change to a spec invalidates a design that was written
against it, silently.

**Fix — cheap.** A custom schema with `design.requires: [specs]`. OpenSpec has
first-class support for this (`openspec schema fork spec-driven <name>`, schemas
resolved from `openspec/schemas/`), so this costs one YAML file, not a fork.

**But that alone is not enough.** `requires` is satisfied by *file existence*
(see §2), so `design` would unblock the moment `specs/**/*.md` is written — not
when you have accepted it. The schema gives us ordering; the review gate (§2) is
what gives it teeth.

---

## 2. "Complete" means "the file exists" — there is no review state

**Root cause — confirmed in source.** `src/core/artifact-graph/state.ts`:

```ts
export function detectCompleted(graph, changeDir): CompletedSet {
  for (const artifact of graph.getAllArtifacts()) {
    if (isArtifactComplete(artifact.generates, changeDir)) completed.add(artifact.id)
  }
}
```

`isArtifactComplete` is a filesystem existence check. There is no notion of
reviewed, accepted, rejected, or needs-work anywhere in the artifact graph.

This is the single most important gap, and it is the reason for your "which
specs have been finished off and accepted" requirement. **It cannot be
configured away** — it needs state OpenSpec does not model.

**Fix.** spec-tacular keeps its own review state in a sidecar file per change
(`.spec-tacular/review.json`), keyed by a stable requirement ID and carrying a
content hash. OpenSpec never reads it and is unaffected; spec-tacular treats an
artifact as complete only when every requirement in it is `accepted` or
`deferred`. The content hash is what makes the state survive editing: if a
requirement's text changes after acceptance, its state drops back to `pending`
automatically.

---

## 3. Reviewing a change is a pile of files

A change produces `proposal.md`, `specs/<cap>/spec.md` × N, `design.md`,
`tasks.md`. For a greenfield feature N is routinely 4–8, each with 3–10
requirements, each with scenarios. That is 30–80 requirements presented as a
directory tree. There is no per-requirement navigation and nothing records how
far you got.

**Fix.** The review loop is the product. Requirements are flattened across all
specs in a change into one ordered queue and presented **one at a time** with
its scenarios. Progress (`17/42 accepted, 3 rejected, 2 deferred`) is always on
screen. Rejecting captures a reason and feeds it straight back to the agent as a
revision instruction, so you never hand-edit a rejection.

---

## 4. Greenfield floods you with changes

OpenSpec's model is a *change* against an existing baseline — the README says
so: "built for brownfield not just greenfield". On day one there is no baseline,
so a vision decomposes into a dozen parallel changes with no sequencing, and
every one of them needs full review before any code exists.

**Fix.** A **Roadmap** layer above changes. One vision → an ordered list of
slices, each of which becomes a change. You review the *roadmap* first (cheap:
one line per slice), then changes are opened one slice at a time. Slices stay
`planned` until promoted, so the review queue never exceeds one change.

(OpenSpec has experimental `openspec/initiatives/` and `openspec/work/`
directories in its own repo — this idea is live upstream but not yet a stable
surface, so spec-tacular should own the format and keep it in its own namespace.)

---

## 5. Requirements are written too concretely, too early

Specs come back naming endpoints, table names and classes that nobody has
decided yet. The schema's `spec` instruction does tell the agent to avoid
implementation detail, but nothing enforces it and nothing distinguishes "this
endpoint is a genuine, decided contract" from "the model needed an example".

**Fix — two parts, because instructions alone demonstrably do not hold.**

1. **Notation.** Illustrative values are marked: `{{example: POST /v1/export}}`.
   Unmarked concrete values are a contract. This makes the distinction reviewable
   instead of a matter of tone.
2. **A concreteness linter** that flags likely-premature specificity — URL paths,
   HTTP verbs + paths, identifiers in `CamelCase`/`snake_case`, file paths,
   library names not present in the Foundation stack — and surfaces each as a
   review hint on the requirement. You accept or mark it as example in one
   keystroke.

The linter is advisory. It runs at review time, not as a validation gate, so it
can be noisy without being harmful.

---

## 6. Design decisions stay trapped in one change

`design.md` holds "Decisions" with rationale. When a decision is actually
architectural — auth strategy, error model, persistence choice — it belongs to
the project, but OpenSpec has no project-level decision record, so the next
change's design re-decides it, differently.

**Fix.** Global ADRs under `spec-tacular/decisions/`, plus a **promote** action:
while reviewing a design decision, `p` lifts it to a global ADR. Subsequent
agent runs receive accepted ADRs as context. The community `intent-driven`
schema does something similar, which is good evidence the shape is right.

---

## 7. Everything blocks your terminal

`openspec apply` occupies the session, so reviewing while implementing means a
second terminal and a second agent instance, managed by hand.

**Fix.** Background jobs are the default, not an option. `apply` is dispatched
to a job runner, its output streams into a pane you can detach from, and you
stay in the review loop. This is the opencode interaction model and the reason
to borrow its stack (see architecture).

---

## 8. A task needing a deployed environment blocks the whole change

**Root cause — confirmed in source.** `src/core/archive.ts` counts unchecked
boxes in `tasks.md` and warns/blocks:

```ts
const incompleteTasks = Math.max(progress.total - progress.completed, 0)
if (incompleteTasks > 0) { /* 'archive_tasks_incomplete' ... rerun with --yes */ }
```

The escape hatches are `--yes` (archive anyway, losing the record of what was
never verified) and `--skip-specs` (archive without merging specs at all). Both
are all-or-nothing: there is no way to say *these three requirements are
verified, that one waits for a deployed environment*.

**Fix.** A `deferred` review state with a reason (typically
`awaiting-deployment`). On archive, spec-tacular splits:

- requirements `accepted` → merged into `openspec/specs/` normally;
- requirements `deferred` → written to a **pending-validation** register
  (`spec-tacular/pending-validation.md`) carrying the change name, requirement,
  and what is needed to verify it.

The change archives. The register is a first-class screen, so deferred work is
visible rather than lost, and verifying one later merges it into the main specs.

---

## 9. There are no ground rules before the first change

OpenSpec `init` scaffolds directories and agent instructions. It does not ask
what the project *is*: language, framework, architecture style, testing
strategy, layering rules. So the first change's design invents them implicitly,
and every later change inherits an accident.

**Fix.** A **Foundation** phase that must be accepted before any change can be
proposed. It produces a small set of durable documents (stack, architecture,
conventions, initial ADRs) that are injected as context into every agent call.
It is itself reviewed through the same accept/reject loop — foundation is just
another artifact kind.

---

## What this adds up to

Three of the nine (§1, §4 partially, §6 partially) are reachable through
OpenSpec's own extension points. The other six need state and UI that OpenSpec
does not have and is not trying to have.

That is the argument for **wrapping, not forking**: OpenSpec's on-disk format
stays the source of truth and stays compatible with plain `openspec` and with
any agent that knows it. spec-tacular adds a sidecar state layer and a UI. If
you ever stop using spec-tacular, the `openspec/` directory is still valid.
