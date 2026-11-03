# Add harness assurance

## Why

The matrix says what should happen; the harness decides whether the test
checks the real system. It sets each input (`drive`) and reads each output
(`observe`), and it is the one hand-written part. The matrix catches some
harness mistakes on its own — an input that has no effect breaks its MC/DC
pair, an output that is always the same breaks a row expecting the other — but
not the ones that pass every row while the code is wrong:

- the harness computes the answer itself (the shortest way for an agent that
  can see the matrix to make it green);
- it observes the wrong place: a sibling code path, a dry run, a UI state
  instead of the decision;
- setting one input also changes another, so a row passes for the wrong
  reason;
- an input that can be true in several ways is only ever made true in one.

FRET avoids most of this by binding variables to model signals declaratively
and proving rather than testing; where its tests reach code, NASA relies on
coverage of the real code and independent review. This change brings both to
the harness.

## What Changes

- **Declarative mappings first**: each glossary variable is mapped in a
  mapping file — which function to call or field to read for an output, which
  fixture sets an input, how to read an input back. A mapping holds no logic,
  so it cannot compute an answer. Procedural harness code remains the fallback
  for what the mapping cannot express, and is held to the rules below.
- **The harness author does not see the answers**: the agent that writes it is
  given the glossary (names, meanings, roles, types), not the matrix's
  expected values.
- **Static rules** on mappings and harness code: an output is read through
  production code; the harness does not read the matrix; an output's reading
  does not use input variables.
- **Input isolation**: every input can be read back independently. After each
  drive, all inputs are read back, and the row fails if any other input
  changed.
- **Red before implementation**: the matrix test runs once before the
  implementing code exists; a matrix that is fully green then is reported as
  not connected.
- **Coverage of the implementing code**: when the matrix runs, the code the
  change implements must be executed {{example: the decision function's lines
  and branches}}. A green matrix that did not execute it is not connected, not
  passing.
- **Mutation checks**: small changes to the implementing code — a condition
  removed, an operator swapped, a comparison inverted — must each turn at
  least one row red. Run with the project's mutation tool where one exists
  {{example: Stryker, mutmut}}, else by the agent, at least once per MC/DC
  condition.
- **Every way an input can be true is driven**, as the glossary lists them.
- **The mapping is reviewed per variable**, one item each, like a requirement:
  the variable's meaning beside how it is set or read, with the results of the
  checks above shown with it. One question each: is this what the word means?
  The mapping is hashed; an edit sends its items back to pending and makes
  results that relied on it stale.
- **Purity is asked, not assumed**: for a decision, the review asks whether the
  code reads anything beyond its listed inputs. Only if not does the full truth
  table count as exhaustive.
- **Evidence gains `not connected`**: a passing result whose harness has not
  passed these checks is shown as such, and does not satisfy the archive gate.

### Added after the NASA practice review

- **Purity by design, not by question.** add-formal-requirements makes a
  formal decision a pure function that returns a plan. The mapping observes
  that plan directly, so most of the failures above cannot be written; the
  review asks only where a decision could not be made pure, and why.
- **Coverage is also a question about the requirements.** Code in the
  change's boundary that no requirement-based test executes is either dead or
  doing something no requirement asks for. It is listed as a question back to
  the specs, not just as a coverage number — "a diagnostic tool for
  requirements completeness, not a measure of test quality".
- **The runner is qualified like a test tool.** Tool qualification asks a test
  framework to be checked with known-pass and known-fail cases. The violating
  sequences are those known-fail cases; the runner libraries ship with a
  suite of both, and the matrix records the spec-tacular version that
  generated it, so an update triggers a re-check.
- **Author is not approver.** The agent writing the harness is not the one
  that wrote the implementation, and for P0 the harness review is done by a
  person other than the one who accepts the implementation diff, where the
  team has two.

## Capabilities

### New Capabilities

- `matrix-harness` — mappings and harness code, their rules, the connection
  checks (isolation, red before implementation, coverage, mutation), the
  per-variable review, and the `not connected` evidence state.

### Modified Capabilities

None yet (no baseline specs). Extends `verification-evidence` and
`test-matrix`.

## Impact

- New mapping file format and its reader in the runner libraries.
- New `src/core/harness.ts`: static rules, isolation checks, coverage and
  mutation runs, per-variable review items (reusing `ReviewItem`).
- `src/core/evidence.ts`: the `not connected` state; archive gate.
- Foundation: the coverage command and, optionally, a mutation tool, proposed
  from the stack.
- Agent instructions for `apply`: harness written before the implementation,
  without the matrix's expected values.
- TUI: the per-variable mapping review.
- Mutation runs cost time; they are scoped to the files the change touches and
  can be limited to MC/DC conditions.

## As implemented

- **Mappings** (`<component>.mapping.yaml`, `src/core/formal/harness.ts`):
  `module`, optional `create` and `tick`, inputs by `arg` / `set` / `call` /
  `on_rise` / `on_fall` with an optional `probe`, outputs by `call` (with
  `field`) or `read`. Compiled into the generated test and run by the
  runner's `harnessFromMapping`. Checked: the module exists and is not test
  code, every input and output says how it is bound, and every variable the
  matrices use is bound.
- **Harness code** is the fallback, held to static rules: it imports
  production code, it imports neither the matrix nor the runner's code.
- **Input isolation**: the runner reads every driven input back through
  `probe` after each drive and fails the row if another one moved.
- **`spec-tacular harness [<change>] [--check]`**: coverage of the production
  code the harness names (lcov: a file with no function executed is not
  reached), then mutants of it — every occurrence of `&&`, `||`, `===`,
  `!==`, `>`, `>=`, `<`, `<=`, `!`, `true`, `false`, spread over the file, up
  to a configurable number — each run in a scratch copy of the project
  (tracked and untracked files, `node_modules` linked). The result is kept in
  `.spec-tacular/harness/<component>.json`, bound to the harness's and the
  code's hashes. Commands, report path, mutant count and threshold are
  `matrix:` settings in `verification.yaml`.
- **Review**: each mapped variable, or a harness file as a whole, is an item
  in the change's review queue, after the decisions, shown beside the
  variable's meaning.
- **Not connected**: an item whose matrix runs through a harness that is
  missing, breaks a rule, leaves a variable unbound, is unreviewed, has no
  check, a stale check, or a failed one, has the evidence state
  `not connected` instead of `passing`; the archive gate waits for it, and
  the overview names the harness and why once implementing has started.
- The specs and apply instructions ask for the harness first, from the
  glossary and not the matrix, a mapping where possible, and the check.

Tried on the scratch project: a harness computing the decision itself passed
all 8 rows and was reported as never executing the decision and catching 0
of 3 mutants. The honest mapping caught 3 of 3. On the client, 4 of 6
mutants survived because no requirement said a response must not appear
before a request; adding that requirement killed 3 of them, and the last —
a timeout reported twice — is again something no requirement forbids.

Not done yet:

- **Ways true and false** from the glossary are not yet driven as separate
  rows.
- **Red before implementation** is asked of the agent, not checked: a
  matrix that never failed is not flagged.
- **Equivalent mutants** cannot be waived; the threshold
  (`mutation_threshold`) is the only way to accept survivors.
- **The writer of the harness is not shown the matrix's answers** only by
  instruction; nothing stops an agent opening the file.
- **Mutation for languages other than TypeScript/JavaScript** — the operators
  are C-family, and the check runs any test command, but it has only been
  tried with bun.
