# The rubric: measuring, scoring and the report

Shared by every scenario in `evals/scenarios/`, so runs of different versions
— and different scenarios — are measured, scored and reported the same way.
Where it says *Sam*, read the scenario's person.

## Measuring as you go

The report is compared across versions, so what can be measured is measured,
the same way every time.

- **`phases.tsv`** in the run directory, one line per phase, written when the
  phase ends: `phase<TAB>start<TAB>end<TAB>decisions`, times as local
  `HH:MM:SS`, decisions the number of things Sam had to decide or type in it
  (an answer, an accept, a reject, a feedback line — not a keypress to move
  on). Phases, in this order and with these names: `setup`, `vision`,
  `ground-rules`, `proposal`, `specs`, `risks` (where the version has them),
  `design`, `tasks`, `implementing`, `finishing`.
- **`prompts.log`**: every permission prompt of the implementing session,
  each starting with a line `=== prompt <n> <HH:MM:SS> <APPROVE|DENY>`.
- **The question ledger** (in the report): every question spec-tacular asked
  Sam before the code existed — interview, ground rules, the proposal's open
  questions — one row each.
- **The assurance ledger** (in the report): every step that exists to make
  the result more certain — reviewing a requirement, a risk, a formal form,
  a matrix, a harness check, evidence, a hazard — one row each per kind.
- At the end, run `evals/tools/metrics.py <run-dir>` (with the project's
  test runner on the PATH, as `env.sh` sets it). It writes `metrics.json` and
  `metrics.md` from the run itself: drafting jobs and their cost, the
  implementing session's tokens from Claude Code's own transcript, what was
  reviewed, the questions answered and left for later, per-phase time spent
  waiting on an agent, and the size and test results of the code. Put
  `metrics.md` into the report as it is: never retype or round its numbers.

## Scoring

A score is a level reached, not an impression. Each area has levels with
observable conditions; give the highest level whose conditions all hold, and
name the condition that decided it in the evidence column.

**The experience areas** — setup; vision, interview and roadmap; ground
rules; reviewing; implementing; finishing — are scored from the friction log
entries of that area, then from the question and assurance ledgers:

| Level | Condition |
|---|---|
| 5 | no friction above *polish*, and no more than one ledger row in the area that Sam rated *no payoff* |
| 4 | no friction above *minor* |
| 3 | at most one *major*, nothing worse |
| 2 | a *blocker* worked around, or two or more *major* |
| 1 | a *blocker* that stopped the step |

Lower the level by one when more than half of the area's ledger rows were
*no payoff* — a smooth step that changed nothing is still a cost.

**Quality of drafted artifacts:** 5 every artifact accepted after at most one
round of revision, and no defect in one found only later; 4 one artifact
needed two or more rounds, or one defect surfaced later; 3 several such; 2 an
artifact had to be rewritten by hand; 1 unusable.

**The produced code works:** 5 every test passes and every scenario Sam ran
behaves as specified (the scenario's own checks included); 4 one *minor* behavioural deviation; 3 one scenario
wrong; 2 several wrong, or failing tests; 1 does not run.

**Matches the accepted specs:** 5 every accepted requirement implemented and
named by a passing test; 4 at most one without a test; 3 one not
implemented; 2 several; 1 unrelated to the specs.

**Code and test quality:** one point for each that holds, at least 1:
structure follows the ground rules; errors handled as the specs say; tests
check behaviour, not implementation; the edge cases the scenario names are
tested; nothing dead or duplicated a reviewer would remove.

**Confidence the result is correct:** one point each, at least 1: every
accepted requirement traced to a passing test; Sam's own scenario runs all
correct; a risk or guard was shown to fail without its fix; something checked
that the tests reach the code (mutants, coverage); no item was waived or
allowed without its reason being checked.

**Overall:** the rounded mean of the other areas. Move it by one at most, and
only with a reason stated in the row.

## The report

Write `report.md` in the run directory, in exactly this shape, so runs can
be compared:

```markdown
# Evaluation: <label> — <scenario>

## Summary
Three to five sentences: how far it got, the biggest strengths, the biggest
problems.

## Scores
| Area | Score | Level reached — the condition that decided it |
|---|---|---|
| Setup (start to first change) | | |
| Vision, interview and roadmap | | |
| Ground rules | | |
| Quality of drafted artifacts | | |
| Reviewing requirements (and risks etc.) | | |
| Implementing from the tool | | |
| Finishing the change (evidence, archive, …) | | |
| The produced code works | | |
| The produced code matches the accepted specs | | |
| Code and test quality | | |
| Confidence the result is correct | | |
| Overall experience | | |

## Measured
(metrics.md, as metrics.py wrote it)

## Flow
Where the time went, from the phases table: which phases Sam spent waiting on
an agent, which deciding, and which the version could have spared him. One
paragraph, with the numbers.

## Question ledger
| # | Asked in | Question | Did it say why it asks? | Sam's answer | Where the answer was used (file:line) | Would Sam have had to decide it anyway? | Payoff |
Payoff is one of: *changed the result* (the answer is visible in the specs,
design or code, and a different answer would have changed them), *confirmed*
(it only restated the brief), *no payoff* (unused, or asked again later).

## Assurance ledger
| Step | Items | Sam's minutes | Agent minutes | Caught (a defect, an ambiguity, a gap — with evidence) | Payoff |
One row per kind of step the version has: reviewing requirements, risks,
formal forms and their read-back, test matrices, harness review, the harness
check, evidence, hazards. *Caught* names each concrete thing the step found
that would otherwise have reached the code or the specs; payoff as above.

## Timeline
| Time | Step | What happened |

## Friction log
For each problem: **severity** (blocker / major / minor / polish), **where**
(screen or command), **what happened**, **what Sam expected**, and the screen
excerpt that shows it.

## What worked well
Concrete moments, with the screen excerpt.

## The produced code
Test results (exact counts), the app's behaviour per scenario, requirements
traceability (a table: requirement → implemented? → tested?), code quality
notes against the scoring checklist.

## Details Sam invented
Every answer given in the interview and the ground rules, so the runs can be
compared.

## Pitfalls
The scenario's list of pitfalls, one row each: *avoided* (with the file:line
or test that shows it), *fell in* (with the failing input and output), or
*not reached* in this slice — and which step of the tool, if any, made Sam
or the agent see it coming.

## Workarounds used
Everything done outside the normal flow, and why.
```
