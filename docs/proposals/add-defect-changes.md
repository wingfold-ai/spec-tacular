# Add defect changes

## Why

spec-tacular plans features. A bug fix today is either an ordinary change,
with a proposal, specs and risks it does not fit, or work done outside the
tool, where the accepted specs quietly stop describing the system. Safety
engineering's finding is that most defects in critical systems trace to an
ambiguous or missing requirement, not to a coding slip, and that every fix
must say which it was: a code bug is fixed against the unchanged requirement,
a requirement bug changes the requirement first. Proof's version is the
reproducer: a test that fails before the fix and passes after it, kept as a
regression test.

## What Changes

- **A defect is its own kind of change**, started from what went wrong
  (observed, expected, how to reproduce) rather than from what to build.
- **Its first question is whose bug it is**: the agent and the human decide
  whether the accepted requirement was right and the code wrong, the
  requirement was ambiguous or wrong, or no requirement covered it. The
  answer is recorded on the change.
  - Code bug: the specs stay as they are; the requirement the code violated
    is named.
  - Requirement bug or gap: the change modifies or adds the requirement
    first, reviewed like any other, before anything is fixed.
- **A reproducer comes before the fix**: a test, named after the requirement,
  that fails on the code as it is. The fix is done when it passes; the record
  of it failing first is kept, the same "shown red" rule as a guard.
- **Lighter pipeline**: proposal and design shrink to the defect report and the
  fix approach; the risks stage asks one question — what else could the fix
  break — and the consequence class (add-consequence-classes) of the code
  touched sets how much more is needed.
- **The lesson is kept**: a defect that reveals a new way the system could
  fail adds a hazard (add-hazard-register).

## Capabilities

### New Capabilities

- `defect-changes` — the defect report, the code-or-requirement decision, the
  reproducer rule, and the lighter pipeline.

### Modified Capabilities

None yet (no baseline specs). Reuses `change-risks` and the guard rules.

## Impact

- A second schema (or a variant of the spec-tacular one) for defect changes,
  installed by `spec-tacular init` alongside.
- TUI: "report a defect" next to "new change"; the decision shown on the
  change.
- `src/core/tasks.ts`: the reproducer task and its proof, reusing the guard
  task markers.

## As implemented

- A second schema, `schemas/spec-tacular-defect/`, installed by
  `spec-tacular init` next to the main one and chosen per change
  (`openspec new change --schema`). Its stages keep the main schema's ids —
  proposal (the report), specs, risks, design (the fix), tasks — so every gate,
  review, class rule and evidence rule applies without special cases.
- Created with `b` in the TUI ("Report a defect") or
  `spec-tacular defect <name> [--description …]`.
- `src/core/defects.ts` checks the change against its report: whose bug it
  is must be stated; a code bug's spec must repeat the baseline requirement
  unchanged (compared with `openspec/specs/`), a requirement bug's must change
  it, a gap's must add one; a code bug's violated requirement must be in the
  specs; the tasks must have a reproducer. The overview labels it
  `defect · code bug` and lists what does not fit.
- The reproducer is the guard of the defect's own risk, so the existing rules
  do the rest: `(shown red: …)` means it failed on the unfixed code, its tag
  is evidence, and at archive the defect joins the hazard register (or
  updates the hazard named by `**Known hazard:**`).
- The fix's design asks for proximate cause, root cause and contributing
  factors.

Not done yet:

- **A lighter pipeline by class.** A defect goes through every stage; the
  consequence class does not yet shorten it for low-class code.
- **The decision is not a separate review item.** Whose bug it is lives in
  the report, which is accepted as a whole.
