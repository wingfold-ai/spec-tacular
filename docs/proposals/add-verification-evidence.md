# Add verification evidence

## Why

A change archives once its tasks are ticked. A tick says someone believes the
work is done; it does not say which test shows a requirement holds, whether
that test passed, or whether it passed against the text that was accepted.
spec-tacular already refuses to trust a stale acceptance (the hash check); it
should refuse a stale or missing test result just the same.

## What Changes

- **Tests name what they verify**, in their test name, in any language and
  framework: a requirement, a risk, and later a matrix row.
  {{example: `[req:archive#archive-is-allowed]`, `[risk:<change>#edited-requirement-stays-accepted]`}}
- **spec-tacular runs the project's tests** with the command the Foundation
  names, reads a machine-readable report {{example: JUnit XML}}, and records
  the result per requirement and per risk.
- **Evidence has distinct states**, never collapsed into one number:
  - `missing` — no test names the item;
  - `passing` / `failing` — from the latest run;
  - `stale` — passed, but the item's accepted text, or the test file, changed
    since that run;
  - `excepted` — a person recorded why it is not verified now, the same way a
    requirement is deferred today, and it goes to the pending register at
    archive.
- **A result is bound to the text it verified**: each record stores the hash
  of the requirement or risk at run time, so an edit makes it stale
  automatically, the same rule acceptance already follows.
- **The archive gate requires evidence**: every accepted requirement and every
  accepted risk is passing or excepted. The gate names each item that is not.
- **The overview shows evidence** per change, next to acceptance
  {{example: `evidence 11/14 · 1 stale · 2 missing`}}, and the review screen
  shows an item's tests and their last result.
- **`spec-tacular evidence`** prints the same over a pipe and in CI, and exits
  non-zero while anything is missing, failing or stale.

### Added after the NASA practice review

- **Not everything is verified by a test.** NASA's four verification methods —
  Test, Analysis, Inspection, Demonstration — are named per requirement and per
  risk, default Test. Inspection is a human's recorded sign-off in the TUI;
  Analysis a tool's output {{example: a type check, a static analyser, a
  proof}}; Demonstration a recorded run. Each method has its own evidence and
  goes stale the same way. "A requirement without a test (or other
  verification method) is a non-compliance."
- **The overview is a verification matrix (RVTM)**: per item its id, text,
  method, linked tests, last result, date and status, with `excepted`
  reported as *waived, with justification*. `spec-tacular evidence` prints it.
- **Traceability both ways**: besides requirements without tests, tests that
  name an item that does not exist, or that no longer matches, are listed as
  orphans.
- **Evidence is appended, never overwritten**: a new run adds a record; the
  history of each item's results stays, so "it passed on the day we accepted
  it" can be shown.
- **Guard proofs are replayed, not trusted**: add-change-risks lets the agent
  record `(shown red: …)` itself, which is self-certification. Here the agent
  also leaves the change that removes the mitigation {{example: a patch
  file}}, and spec-tacular replays it in a scratch copy: with the patch the
  guard test must fail, without it pass. A replayed proof is evidence; a
  recorded one stays a claim, and is shown as such.
- **Negative cases are required**: every requirement needs at least one
  scenario where the behaviour must *not* happen or must fail safely; one
  with only nominal scenarios is flagged at review.
- **An evidence pack at archive**: the change's rationale (proposal), impact
  (risks and boundary), evidence (the matrix), the review record (who
  accepted what, and when), its rollback plan (the design's migration plan)
  and the provenance of every draft — which agent and model wrote it, which
  spec-tacular knows already — written into the archived change. Readiness is
  "No-Go until proven": missing evidence blocks, silence does not count.

## Capabilities

### New Capabilities

- `verification-evidence` — linking tests to items, running and recording
  them, evidence states, staleness, exceptions, and the archive gate's use of
  them.

### Modified Capabilities

None yet (no baseline specs). Archive behaviour changes; see Impact.

## Impact

- New `src/core/evidence.ts`: finding links in test files, running the test
  command, reading its report, storing results in `.spec-tacular/evidence/`.
- `src/core/archive.ts`, `gate.ts`: evidence as an archive condition;
  `pending.ts`: excepted items join the pending register.
- Foundation: the test command, and the report format it can produce, become a
  question (proposed from the stack, like the others).
- Schema `tasks` and `apply` instructions: tests carry the item's id in their
  name.
- TUI overview and review screen; `--print`; a new CLI command.
- Projects whose test runner cannot write a report fall back to `missing`
  with a reason, never to `passing`.

## As implemented

The core, in `src/core/evidence.ts`, the `evidence` command and the archive
gate:

- Tags `[req:<capability>#<slug>]` and `[risk:<change>#<slug>]` in test (or
  suite) names; the test command and its JUnit report in
  `spec-tacular/verification.yaml`. Without that file nothing is collected or
  required.
- An append-only record per change in `.spec-tacular/evidence/<change>.jsonl`:
  test runs bound to the item's hash and the test file's hash; sign-offs for
  analysis, inspection and demonstration; waivers with reasons.
- States missing / passing / failing / stale / excepted. Stale when the item's
  text or the test's file changed since the run; only the latest run counts,
  and a skipped test is not evidence.
- `**Verified by:**` per requirement or risk, default test.
- The verification matrix (`spec-tacular evidence [<change>]`), exiting
  non-zero while anything is open; orphan tags reported by `--run`.
- Deferred requirements count as excepted; unmitigated risks need none.
- Archive refused while anything is open ("No-Go until proven"); the overview
  shows evidence per change and, once implementing started, what is open.
- The review flags requirements with no negative scenario; the specs, tasks
  and apply instructions ask for negative scenarios and tags.

Not done yet:

- **Guard proofs replayed.** `(shown red: …)` is still the agent's own claim.
  Replaying needs a patch that removes the mitigation and a scratch copy of
  the project to run it in; that is its own step, and the matrix does not yet
  tell a replayed proof from a recorded one.
- **The evidence pack at archive**, with the review record and the provenance
  of each draft.
- **Sign-offs in the TUI.** Inspection and the other methods are recorded on
  the command line only; the review screen does not show an item's evidence
  yet.
