# Add consequence classes

## Why

Every change gets the same rigor today, and the changes after this one would
make that worse: a full test matrix, mutation runs and a per-variable harness
review for a settings screen is ceremony nobody keeps up, and it teaches
people to click through. Safety-critical engineering solves this the other way
round: it **classifies first**, by what a failure would cost, and scales the
rigor to that (NASA's software classes A–E, ISO 26262's ASIL, the P0–P3
classes of the NASA practice book). "Rigor proportional to consequence" is
what makes the rest affordable. And AI-written code in a critical decision
path is exactly the case those frameworks single out for more scrutiny, not
less.

## What Changes

- **Classes in the Foundation**: the project names its areas of code and their
  consequence class {{example: P0 — a wrong output harms users or data, or
  cannot be undone; P1 — degraded service; P2 — inconvenience; P3 —
  experimental}}, each with the paths it covers and a sentence on why. The
  advisor proposes them from the vision and the stack; "when in doubt,
  classify higher" is the stated default.
- **A change inherits the highest class it touches**: from the paths in its
  boundary, and again from the files it actually changed. "Higher consequence
  wins" — a P2 change that reaches into a P0 path is a P0 change, and the
  overview says so when it happens.
- **The class sets what each later stage requires**, in one table the project
  can tailor:
  - risks: always; for P0, every high-severity risk needs a guard, and
    `Unmitigated:` needs a second human's agreement to stand;
  - formal forms (add-formal-requirements): expected for P0 decisions,
    optional below;
  - matrix (add-test-matrix): full truth table for P0, MC/DC plus boundary
    values for P1, none required below;
  - harness checks (add-harness-assurance): mutation for P0, coverage for P1;
  - evidence (add-verification-evidence): an evidence pack for P0 and P1.
- **AI-written code in P0 is reviewed as code**: for a P0 change, archiving
  requires a human to accept the implementation diff itself, hashed like any
  other acceptance — the agent wrote it, so the agent cannot be the one to
  certify it. Below P0 the tests and the review of the plan stand.
- **Tailoring is recorded**: a project that lowers a requirement for a class
  writes why, and the reason is shown wherever the lowered rule would have
  applied.
- **An experimental change cannot silently become critical**: a P3 change
  whose code later sits under a higher class is flagged until it is
  reclassified.

## Capabilities

### New Capabilities

- `consequence-classes` — classes and their paths in the Foundation, the
  class of a change, the rigor table and its tailoring, and diff review for
  P0.

### Modified Capabilities

None yet (no baseline specs). Builds on `change-boundary`
(add-change-risks); the later proposals read the class.

## Impact

- `src/core/foundation.ts`, the advisor and presets: the classes question,
  proposed from the vision.
- New `src/core/classes.ts`: matching paths to classes, a change's class from
  its boundary and its diff, the rigor table.
- `src/core/gate.ts` and `archive.ts`: rules that depend on the class; the
  diff signoff for P0 (reusing `core/signoff.ts`).
- TUI overview: the class next to each change; a diff reader for P0.
- Order: best done right after add-change-risks, before the rest — the book's
  own advice is to classify before adding any other rigor.

## As implemented

- Classes live in `spec-tacular/classes.yaml` (default class, areas with
  paths and why, tailoring with reasons), read by `src/core/classes.ts`.
- Two rules are enforced, the ones that exist to check today: `diff-review`
  (P0) and `guard-high-risks` (P0, P1). The rules of the later proposals —
  formal forms, matrix depth, harness checks, evidence packs — join the same
  table when those land.
- The implementation diff is what the branch changed since it left the
  default branch, plus uncommitted and new files, without spec-tacular's and
  OpenSpec's own records. Read and accepted in the TUI (`v`, `a`) or with
  `spec-tacular diff <change> [--accept]`; archiving refuses without it.

Not done yet, deliberately:

- **Proposed by the advisor.** The classes are a file the project writes,
  not yet a Foundation question the advisor proposes from the vision. That
  needs the advisor's question and preset machinery and is its own step.
- **A second human for `Unmitigated:` in P0.** spec-tacular does not know who
  is reviewing, so it cannot tell two people apart. Instead, a high-severity
  risk in P0 or P1 cannot be left unmitigated at all, unless tailored.
- **A P3 change that becomes critical.** Covered for the change itself — its
  changed files raise its class and are named — but not for P3 code from
  earlier, archived changes that later sits under a higher class.
- **Diff per change.** Several changes on one branch share one diff; each is
  accepted on it separately.
