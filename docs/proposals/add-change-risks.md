# Add change risks and boundaries

## Why

A change is reviewed for what it should do, never for what it could break.
The design's "Risks / Trade-offs" section is prose nobody accepts, nothing
tests, and nothing checks again at archive time. A risk that is written down
but not verified gives the same false comfort as a ticked task that was never
run. And nothing states what a change is allowed to touch, so an agent that
edits files far outside the change is not noticed.

## What Changes

- **A `risks` artifact**, between specs and design: proposal → specs →
  **risks** → design → tasks. A risk is about how this change could violate an
  accepted requirement or the existing baseline, so it needs the specs; the
  design must answer each one, so it comes before the design.
- **Each risk is a reviewable item**, accepted, rejected or deferred one at a
  time, with drift detection, exactly like a requirement. It states:
  - **Hazard** — what must not happen, as an observable outcome;
  - **Affects** — the requirements and existing capabilities it threatens;
  - **Boundary** — the situation in which it arises (edits made outside the
    TUI, an empty input, a second trigger while the first is pending);
  - **Severity**;
  - **Guard** — the property that rules it out, in words (and, once
    add-formal-requirements exists, optionally as a formula);
  - **Check** — how a test shows the guard holds.
- **The design must address every accepted risk** by name: a mitigation, or an
  argued acceptance of the risk. A design that leaves one unanswered is
  stopped the same way as one that meets contradicting requirements.
- **Every risk yields a guard task**: a test that verifies the guard. The task
  is done only when the test has been shown to **fail with the mitigation
  removed** and pass with it in place (Proof's "failed before the fix, passed
  after"). The agent records how it showed the failure.
- **A change boundary in the proposal**: the capabilities and areas of the code
  the change expects to touch. After implementing, files changed outside it
  are listed as a warning on the change, for a human to accept or question.
  Advisory only, like the concreteness linter.
- **Risks the change does not mitigate** are marked `Unmitigated:` with a
  reason; they stay listed on the change and survive into the archive.

### Adjusted after the NASA practice review

Already implemented in the code:

- The field for a knowingly unmitigated risk is `Unmitigated:`, not
  `Accepted:`. In the review, accepting a risk means agreeing it is stated
  right, and the two must not read alike.
- An optional **Causes** field, as in NASA's hazard reports.
- The risks instruction walks each requirement through the failure modes
  safety engineering asks of software: wrong, missing, unexpected, too early,
  too late, out of order, stuck; provided when not needed, not provided when
  needed, too long, too short (STPA); boundaries; existing data and callers;
  and, where identity or outside input is involved, the STRIDE threats.

Moved to later changes:

- `(shown red: …)` is recorded by the agent itself: self-certification.
  Replaying the proof independently is part of add-verification-evidence.
- Risks outlive their change in add-hazard-register.
- How much each risk requires follows the change's consequence class
  (add-consequence-classes).

## Capabilities

### New Capabilities

- `change-risks` — the risks artifact, its items, their review, the design's
  obligation to answer them, and guard tasks.
- `change-boundary` — the declared boundary of a change and the check of the
  implementation against it.

### Modified Capabilities

None yet (spec-tacular has no accepted baseline specs in `openspec/specs/`).
Behaviour of the schema sequence, the gate and task generation changes; see
Impact.

## Impact

- `schemas/spec-tacular/schema.yaml` and its templates: a `risks` artifact and
  template; `design` requires `risks`; the design and tasks instructions name
  risks; the proposal instruction asks for a boundary.
- `src/core/requirements.ts` / `review.ts`: risks reuse `ReviewItem`, its
  sidecar and drift detection (the type was written to serve more than
  requirements).
- `src/core/gate.ts`: design waits for accepted risks; `src/core/stops.ts`: an
  unanswered risk is a stop reason.
- `src/core/tasks.ts`: guard tasks and the record of their failing run.
- TUI: a risks review screen (the requirement review, with different fields),
  the boundary warning on the change overview.
- Existing changes without a `risks.md` keep working: the stage reads as
  skipped, with a warning, rather than blocking them.
