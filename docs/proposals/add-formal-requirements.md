# Add formal requirements

## Why

A requirement in prose can be read two ways, and the review only catches that
if the reviewer happens to read it the second way. "Archive only when the work
is closed" — does an open stop report count as open work? Does a deferred
task? A formal form answers that once, in a shape a tool can evaluate, and is
the basis for deriving tests rather than writing them (add-test-matrix).
NASA's FRET shows the format: structured English with a fixed grammar and a
precise meaning over time, over typed variables.

## What Changes

- **An optional formal form per requirement**, written by the specs agent where
  a requirement has a real decision or timing rule, and left out where it has
  not. Most requirements of a CLI or web app have no timing; many have a
  decision. Two forms:
  - a **decision**: an output defined by a boolean expression over inputs,
    comparisons included
    {{example: `archive_allowed = tasks_applied AND specs_accepted AND NOT stop_open`}};
  - a **FRETish** line: `[scope] [condition] component shall [timing] response`
    {{example: `upon request_sent Client shall within 3 ticks satisfy response | timeout_error`}},
    in a subset of FRET's grammar — scope by mode; `upon`, `whenever`, `if`
    conditions; `immediately`, `at the next timepoint`, `within`, `for`,
    `after`, `until`, `before`, `always`, `eventually`, `never`.
- **A project glossary** of the variables formal forms use: name, meaning in
  words, role (FRET's types: mode, input, output, internal), data type and
  range, and the ways an input can be made true or false where there are
  several. The Foundation's "core terms" question seeds it. A formula naming a
  variable not in the glossary is an error, shown at review.
- **The formal form is reviewed with the prose**: the review screen shows both,
  the glossary meaning of each variable used, and the formula read back in
  plain words. Accepting the requirement accepts both forms; the formal form
  is part of the hash, so changing it resets acceptance, like marking an
  `{{example: …}}` does.
- **Prose and formula must agree**: a reviewer who sees a difference rejects
  the requirement; the agent that revises it changes both together.
- **Conflict checks between formal requirements**: two requirements on the
  same output whose conditions overlap and whose responses contradict are
  reported in the same stop report agents already write for contradicting
  requirements, with both texts side by side.
- **Too large is flagged**: a decision over more than a small number of
  conditions {{example: 6}} is flagged for splitting, by the existing rule of
  one requirement, one behaviour.
- **A risk's guard may be a formal form** too, usually a `never`.

### Added after the NASA practice review

- **The prose stays authoritative.** As FRET augments a requirements document
  rather than replacing it, the formal form augments the requirement. Where the
  two disagree, the requirement is rejected and both are revised; the prose is
  what the specs promise.
- **Formalize where it pays.** NASA formalizes about half of the functional
  requirements and most safety ones; quality attributes and interface
  specifications stay as text and are verified by inspection or analysis. The
  specs agent is told the same, and the consequence class
  (add-consequence-classes) says where a formal form is expected.
- **Questions back.** The book calls this "arguably more valuable than the
  formal verification itself": formalizing forces vague words into variables
  and thresholds ("promptly", "anomalous", "any primary sensor"). The agent
  that writes a formal form lists the questions it had to answer, the answers
  go into the prose, and the review shows them. A vague-term check, like the
  concreteness linter, flags such words in requirements that have no formal
  form.
- **Negation is not a condition.** `x` and `NOT x` are one condition, as DO-178C
  counts them; a call such as `isValid()` is one atomic condition, its own
  logic tested separately.
- **Decisions produce data.** A requirement with a decision form is
  implemented as a pure decision function — inputs in, a plan out — with side
  effects done by separate code (the book's Decide → Plan → Execute). The
  design instruction says so; it is what makes the matrix testable without
  mocks, and what add-harness-assurance relies on.
- **The glossary is the seed of a signals catalog**: each variable also
  records where its value comes from in the system and who owns it, and links
  back to the requirements using it. A requirement whose variables have no
  source cannot be monitored (add-fret-interop).
- **Constraints between variables** are part of the glossary
  {{example: `token_valid -> NOT token_expired`}}, so combinations that cannot
  happen are known (add-test-matrix).

## Capabilities

### New Capabilities

- `formal-requirements` — the formal form, its grammar subset, its meaning on
  finite sequences of steps, its review, and conflict checks.
- `requirement-glossary` — the glossary, its variables and their roles, and
  its link to the Foundation.

### Modified Capabilities

None yet (no baseline specs). The specs instruction and the review screen
change; see Impact.

## Impact

- New `src/core/formal/`: a parser for the subset, an evaluator for its
  meaning on finite step sequences (following FRET's definitions), the plain
  words reading, conflict detection.
- `src/core/requirements.ts`: the formal block is parsed with the requirement
  and included in its hash.
- New `spec-tacular/glossary.yaml`; `src/core/foundation.ts` seeds it.
- Schema `specs` instruction and template: when to write a formal form, and
  how; `src/core/stops.ts`: conflicts as a stop reason.
- TUI review screen: the formal form, variables and plain words reading.
- To settle first: whether `openspec validate` accepts a fenced block inside a
  requirement body. If it does not, the formal form is stored beside the spec,
  keyed by requirement id.

## As implemented

- `src/core/formal/expr.ts`: boolean expressions with FRET's operators in
  either spelling, comparisons, calls as atomic conditions; evaluation,
  atomic conditions (`x` and `NOT x` one condition), plain words.
- `src/core/formal/fretish.ts`: the FRETish subset (scope `in` / `not in` /
  `before` / `after`; `upon` / `when` / `if` / `whenever`; the timings listed
  in the schema), its meaning over a finite sequence of steps, and plain
  words. The finite-trace choices — inclusive windows, a window running past
  the end judged on the steps there are, `until` without its stop holding to
  the end, `before` without its stop met — are written next to the code, for
  add-fret-interop to pin against FRET.
- `src/core/formal/glossary.ts`: `spec-tacular/glossary.yaml` with role,
  type, meaning, enum values, range, tolerance, source, owner, ways true and
  false, and constraints between variables.
- `src/core/formal/formal.ts`: the ```formal block (`decision:`, `fret:`,
  `asked:`) inside a requirement or a risk, checked against the glossary
  (unknown variables, roles, types, enum values), the size flag (more than
  six conditions), conflicts between decisions on the same output found by
  comparing truth tables, and the vague-term check for requirements without
  a formal form.
- Settled: `openspec validate` accepts the block, and it is part of the
  requirement's hash.
- The review (TUI and headless) shows the reading in words, the variables'
  meanings, the `asked:` lines and any problems. Errors and conflicts block
  the design gate and show on the overview, which also counts formal
  requirements per change. `spec-tacular glossary` lists variables, their
  users, and those without a source.
- Agents get the glossary in their context; the specs instruction says when
  and how to formalize, the risks instruction allows a formal guard, the
  design instruction asks for decisions as pure functions.

Not done yet:

- **FRETish conflicts.** Only decisions are compared; two timing
  requirements that cannot both hold are not found yet (realizability is
  add-fret-interop's).
- **`only in` scopes and probabilistic FRET** are not in the subset.
- **Seeding the glossary from the Foundation's core terms** by the advisor.
- **A class rule** that expects formal forms for P0 decisions: whether a
  requirement "has a decision" is not something a tool can see.
