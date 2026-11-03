# Add the test matrix

## Why

A formal requirement that is only reviewed and exported is never used. Its
value is that the tests can be derived from it instead of chosen by whoever
writes them: every combination of the inputs, the edges of every numeric
range, every timing case, each with the expected outcome computed from the
formula. An agent writing tests by hand picks the cases it thought of; the
matrix is every case the formula distinguishes. It is also the most readable
form of the formula: a reviewer who disagrees with one row has found a wrong
formula.

## What Changes

- **A matrix is generated for every formal requirement and formal risk guard**,
  committed with the change, never edited by hand, and regenerated when the
  formula or the glossary changes.
- **Decisions get their full truth table**: all 2ⁿ combinations, each with the
  expected output. The rows forming a minimal MC/DC set — where one input alone
  changes the outcome — are marked, but every row is tested.
- **Comparisons become boundary values** taken from the glossary's data type:
  on the boundary, just inside, just outside, and the range's ends
  {{example: `voltage > 9` over int → 9, 10, min, max}}, crossed with the other
  conditions.
- **Timing requirements become step sequences**: the inputs per step (driven by
  the test) and an expectation over the outputs (observed). Cases include the
  trigger firing once, never, held high, firing again while the first is
  pending, and firing late, crossed with the condition's combinations.
- **Expectations compile to four checks** — an output's value at a step; at
  some step in a window; at every step in a window; at no step in a window — so
  the test needs no temporal logic evaluator and works in any language.
- **Violating sequences are generated too**, to test the checks themselves:
  given a sequence that breaks the formula, a check must report failure.
- **The matrix is shown in full on the review screen**, under the requirement,
  in plain words per row. Its hash is part of the requirement's, so accepting
  the requirement accepts its matrix.
- **A small runner library per language** reads a matrix and runs each row as
  its own named test case; spec-tacular can write the loop file for supported
  runners {{example: bun:test, vitest, pytest}}. Only the harness — how to set
  and read each variable in the real code — is written by hand
  (add-harness-assurance).
- **Evidence per row**: each row is a test case named with its row id, so
  add-verification-evidence records results per row; a regenerated matrix
  makes earlier results stale.
- **Tasks are generated** for each formal requirement: the harness for its
  component (once per component) and the matrix test passing.
- **Matrix size is bounded** by add-formal-requirements' size flag; no row is
  dropped silently.

### Added after the NASA practice review

- **Impossible rows are marked, not tested.** Conditions that constrain each
  other (a valid token cannot be expired) make some combinations impossible.
  Rows the glossary's constraints exclude are shown as infeasible, with the
  constraint, and are not run; the remaining rows are.
- **Every condition needs an independence pair.** The generator looks for
  unique-cause pairs first (only that condition changes) and falls back to
  masking pairs. A condition with neither is dead, always masked by the
  others, and is reported at review. Coupled or dead conditions are design
  feedback: replace correlated booleans with one state {{example: an enum
  VALID / EXPIRED / REVOKED}} or remove the redundant guard. The book's rule
  of thumb applies: if the table is hard to write, the decision is too
  complicated.
- **How much of the matrix is required follows the class**: the full table for
  P0, MC/DC rows plus boundary values for P1 (N+1 rows for N conditions
  instead of 2ⁿ), as add-consequence-classes sets. The full table is always
  generated and shown; the class decides which rows must pass.
- **Boundary values handle precision**: for floating values the "just inside"
  and "just outside" points use a tolerance from the glossary, not the
  smallest representable step.
- **Properties as a supplement**: for TypeScript and Python projects, the same
  formula can drive a property-based test (random step sequences, checked by
  the evaluator), reported as supplementary evidence. Requirements-based rows
  stay the primary evidence.

## Capabilities

### New Capabilities

- `test-matrix` — generating matrices (truth tables, MC/DC marks, boundary
  values, step sequences, violating sequences), their file format, review,
  runner libraries and per-row evidence.

### Modified Capabilities

None yet (no baseline specs). Builds on `formal-requirements` and
`verification-evidence`.

## Impact

- New `src/core/formal/matrix.ts` (generation), the matrix file format, and
  matrix files under each change.
- Runner libraries, shipped with spec-tacular, for TypeScript first, then
  Python.
- `src/core/evidence.ts`: per-row results; `tasks.ts`: generated tasks.
- TUI review screen: a scrollable matrix view with MC/DC marks and plain words
  rows.
- Schema `tasks` and `apply` instructions: matrix tests are generated, not
  written; the agent writes the harness.

## As implemented

- `src/core/formal/matrix.ts` generates, per decision: the full truth table
  over its atomic conditions (up to 10), each row made concrete — booleans as
  assigned, each compared variable at the value nearest its boundaries that
  meets every comparison on it — and checked against the glossary's
  constraints; MC/DC witnesses (unique-cause pairs, else masking pairs); dead
  conditions; and boundary rows across each numeric comparison. Per FRETish
  line: step sequences (fires once, never, held, again while pending, late,
  outside the scope) with `at` / `some` / `every` / `none` checks over the
  response, and self-test responses that meet and break them.
- Rows are required by class: all for P0 or without classes, MC/DC, boundary
  and step rows for P1, none below. Evidence counts an item verified only
  when every required `[row:…]` ran in its latest run and none failed.
- `runners/spec-tacular-matrix.ts`: the TypeScript runner, dependency-free,
  embedded in the binary and copied into the project by `--write`; framework
  neutral (`matrixCases(matrix, harness)` gives name and function pairs).
- `spec-tacular matrix [<change>] [--write]` writes the matrices, the runner
  and a test per matrix, and names the harnesses still to write. The review
  shows the matrix under the formula; the overview flags a matrix out of
  date.
- Tried on a small client: the "fires again while the first is pending" row
  found a timer that a second request reset — a case nobody had written a
  test for.

Changed from the proposal:

- **Matrices live in `spec-tacular/matrix/`, not in the change.** Archiving
  moves the change folder, and the generated tests import the matrix; the
  requirement outlives its change, so its matrix does too.
- **The matrix is not part of the requirement's hash.** The formula is, so a
  formula change resets acceptance; a glossary change (a new range, a
  constraint) regenerates the matrix and is flagged as out of date, without
  resetting acceptance.
- **The response is evaluated by the runner,** from the expression stored in
  the matrix, rather than compiled into per-output checks: a compound
  response (`response | timeout_error`) could not be expressed otherwise.

Not done yet:

- **A Python runner** (pytest); only TypeScript ships.
- **Property-based tests** from the same formula.
- **Comparisons between two variables** (`a < b`): such rows are marked as not
  generated.
- **Harness checks** — that the harness reaches the real code — are
  add-harness-assurance.
