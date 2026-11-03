# Add FRET interoperability

## Why

spec-tacular's formal forms follow FRET's grammar and meaning but do not use
FRET itself. That leaves two gaps. Our reading of FRET's semantics could be
wrong in an edge case, and every derived matrix would inherit the mistake. And
FRET can do what tests cannot: check that a set of requirements can be met at
all (realizability), and generate tests by its own coverage criterion (FLIP)
with a model checker. Timing requirements are also hard to test by driving
step sequences; FRET's toolchain (Copilot via Ogma) checks them on the real
system's runs instead.

## What Changes

- **Export to FRET**: the formal requirements of a change and the glossary are
  exported in a form FRET imports, so a user with FRET installed can run its
  realizability checking, simulator and test generation on them. Optional;
  nothing in spec-tacular requires FRET.
- **Realizability as a stop reason**: where FRET is installed, spec-tacular can
  run its realizability check from the command line and report unrealizable
  requirements in the existing stop report, like contradicting ones.
- **FRET cross-checks spec-tacular's semantics**: spec-tacular's own test
  suite exports sample requirements to FRET and checks that FRET's formulas
  agree with spec-tacular's expectations on the generated step sequences,
  including violating sequences. Edge cases (inclusive bounds, a trigger at
  the first step) are pinned to FRET's answer.
- **Runtime monitors for timing requirements**: a timing requirement can be
  compiled into a monitor that observes a real run — an end-to-end test, or a
  recorded trace — and reports whether the formula held. Nothing is driven, so
  no input mapping is needed; outputs are still mapped and reviewed per
  add-harness-assurance. Monitor results are evidence like test results.

### Added after the NASA practice review

- **Three layers from one formula**, as the book's worked example runs it:
  the matrix in CI, a proof at design time where the decision can be expressed
  for a model checker (Kind 2), and a runtime monitor from the same formula.
  Changing the requirement regenerates all three.
- **Monitorability is checked.** Safety properties, bounded response and
  past-time properties can be monitored; an unbounded `eventually` cannot. A
  timing requirement chosen for a monitor that is not monitorable is flagged,
  with a bounded rewrite suggested.
- **Monitors are reviewed specifications.** A generated monitor, and the alert
  it raises, trace to the requirement they check; a requirement whose
  variables have no source in the signals catalog (add-formal-requirements)
  is listed as unmonitorable.
- **The semantics cross-check is tool qualification.** spec-tacular generates
  test expectations, which makes it a tool whose errors would go unnoticed
  downstream. Checking it against FRET, and re-checking on every release, is
  how such a tool earns trust.

## Capabilities

### New Capabilities

- `fret-interop` — export, optional realizability checks, the semantics
  cross-check, and runtime monitors.

### Modified Capabilities

None yet (no baseline specs). Extends `formal-requirements` and
`verification-evidence`.

## Impact

- New `src/core/formal/fret.ts`: export and the command line bridge.
- spec-tacular's own CI: a job with FRET installed for the semantics
  cross-check (FRET is an Electron app; its command line and a Kind 2 or
  NuSMV install are needed).
- Runner libraries: a monitor mode next to the matrix mode.
- Users who never install FRET see no change.
- To settle in the design: FRET's import format and command line
  capabilities in the version current at the time (v3.1 as of writing), and
  whether to depend on Copilot / Ogma or generate monitors in spec-tacular's
  own runner libraries.

## As implemented

- `src/core/formal/mtl.ts`: FRET's future-time metric temporal logic over
  finite traces, as `fretcli formalize -l ft-fin` prints it — `X` (strong),
  `F`, `G`, `U`, `V`/`R`, their `[a,b]` bounds, `LAST`, the boolean operators
  and comparisons — with its meaning step by step.
- `src/core/formal/fret.ts`:
  - **Cross-check**: for each FRETish requirement, FRET's ft-fin formula is
    evaluated next to spec-tacular's verdict, on the matrix's step sequences
    and seeded random traces over its variables; disagreements are reported
    with the trace. Formulas come from FRET's CLI (`fret.cli` in
    `verification.yaml` or `SPECTACULAR_FRET_CLI`) and are cached in
    `spec-tacular/fret/formulas.json`.
  - **Export**: `fret-requirements.json` and `.csv` (reqid, fulltext,
    rationale, project) and `fret-variables.csv` (Mode / Input / Output /
    Internal; boolean / integer / double).
  - **Realizability**: `spec-tacular fret realizability <project>
    <component>` passes through to FRET's `realizability --diagnose`.
  - **Monitoring**: `spec-tacular monitor <run.jsonl>` checks a recorded run
    against every formal requirement — active changes and the baseline —
    whose variables it records; `monitorability` flags an unbounded
    `eventually`, and `finally` without a scope that ends.
- **Settled by FRET's own output** (its CLI documentation's example,
  `sw shall within 500 ticks satisfy x` → `((F[0,500] x) | (F[0,499] LAST))`):
  spec-tacular's `within` — inclusive bounds, and a window running past the
  end judged on the steps there are — agrees with FRET on every trace tried.
  The test suite checks it, and checks that a naive reading (`F[0,3] x`) is
  caught.

Not done yet — and not doable here, where FRET is not installed:

- **The cross-check for every other timing, scope and condition**:
  `upon` at an interval's start, `until`/`before` whose stop never comes,
  `for`, `after`, `in`/`before`/`after` scopes. The code is in place; it
  needs FRET installed once, to formalize them and fill the cache. Until
  then those choices are spec-tacular's own, as written in fretish.ts.
- **FRET's import format is not verified** against a running FRET: the
  JSON's fields follow FRET's exported requirements as far as known, and the
  CSV is for FRET's column-mapping import.
- **Proofs** (Kind 2 over Lustre via CoCoSim) and **online monitors**
  (Copilot via Ogma) are not generated: monitoring is offline, over
  recordings.
- **Running the cross-check in spec-tacular's own CI** with FRET installed.
