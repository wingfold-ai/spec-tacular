# Scenario: a small time-tracking app

## The person you play

Sam, a freelance developer. Comfortable in a terminal and with TypeScript,
new to spec-tacular and to OpenSpec. Sam has read nothing but the README of
the version under test (`README-under-test.md` in the run directory), and
reads it the way a new user does: the first screens' worth, then looks
things up when stuck. Sam wants working software at the end, not a perfect
process, and is honest about what was confusing.

## What Sam wants to build

> **Tick** — a time tracker for freelancers, used from the terminal.
> I start a timer on a client project when I begin working and stop it when I
> stop; only one timer runs at a time, and starting a new one stops the
> running one. I can list today's entries, see how many hours went to each
> project today and this week, and export a date range as CSV to send with
> my invoice. Entries can be corrected afterwards — wrong project, forgot to
> stop. Everything is stored locally in a file; no server, no accounts.
> TypeScript on Bun, tested with bun test.

Use this as the vision. In the interview, answer as Sam would: concrete,
brief, consistent with the brief; invent sensible details when asked
("rounded to the minute", "weeks start on Monday", "CSV with date, project,
start, end, minutes"), and keep them consistent afterwards — note each one in
your log so both runs can be compared.

## What to do

1. **Set up** — start spec-tacular, go through its own setup.
2. **Vision and roadmap** — describe Tick, answer the interview, review the
   proposed slices. Keep a first slice that is small and end to end (start,
   stop, list today). Drop or reorder slices only where Sam would.
3. **Ground rules** — answer or confirm each question as Sam: TypeScript,
   Bun, bun test, a simple layered or hexagonal structure, local JSON file.
   Leave for later what Sam would not know yet.
4. **The first change (slice 1)** — let the agents draft each artifact, and
   review every one properly, as a careful user would:
   - read the proposal; accept, or ask for changes if it is wrong;
   - review every requirement one at a time: accept good ones, reject (with
     a reason) ones that are wrong, vague, untestable or over-specified,
     and let them be revised;
   - whatever else the version under test asks you to review (risks, ground
     rules for tests, formal forms, …) — use it the way its README says;
   - the design, then the tasks.
5. **Implement it** — start implementing from spec-tacular. The session
   opens in another headless terminal (see the agent instructions). Follow
   it like Sam would: answer what it asks, approve sensible commands, deny
   anything outside the project. Let it finish.
6. **Finish the change** — whatever the version under test wants before the
   change is done (accepting a diff, evidence, a harness check, archiving):
   do it the way its README describes. Archive the change if you get there.
7. **Judge the result** — as a reviewer of Sam's new codebase.

Stop after the first slice. Do not start a second.

## Limits

- If something blocks you, try what Sam would try — the screen's hints, `?`,
  the README — for at most three attempts, then record it as a blocker and
  work around it (for instance by doing the step with spec-tacular's CLI, or
  by hand) so the run can continue. Say exactly what you did.
- Never edit spec-tacular itself, and never edit the project's files by hand
  unless the version under test tells the user to (e.g. `$EDITOR` on an
  artifact). The point is to see what the tool produces.
- Do not leave the run directory.

## Judging the produced code

In `project/`, as a reviewer would:

- **Does it work?** Run `bun install` if needed, `bun test`, and the app
  itself through the slice's scenarios: start, stop, list today, starting
  while one runs. Note every failure exactly.
- **Does it do what was accepted?** For each accepted requirement: is it
  implemented, is it tested, does the test check it? Note requirements with
  no test, tests with no requirement, and behaviour no requirement asked for.
- **Is it good code?** Structure against the ground rules, naming, error
  handling, tests that test behaviour rather than implementation, edge cases
  (no timer running, stopping twice, midnight, clock in the past).

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
behaves as specified; 4 one *minor* behavioural deviation; 3 one scenario
wrong; 2 several wrong, or failing tests; 1 does not run.

**Matches the accepted specs:** 5 every accepted requirement implemented and
named by a passing test; 4 at most one without a test; 3 one not
implemented; 2 several; 1 unrelated to the specs.

**Code and test quality:** one point for each that holds, at least 1:
structure follows the ground rules; errors handled as the specs say; tests
check behaviour, not implementation; the edge cases (no timer running,
stopping twice, midnight, clock in the past) are tested; nothing dead or
duplicated a reviewer would remove.

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
# Evaluation: <label> — time tracker

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

## Workarounds used
Everything done outside the normal flow, and why.
```
