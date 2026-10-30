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

## Pitfalls

What a careful implementation of the slice gets right. Do not mention them to
the tool or the agents; check each against the produced code and report it in
the *Pitfalls* section.

1. **Stopping with nothing running** is an error, not a crash or a silent no-op.
2. **Stopping twice**: the second stop changes nothing.
3. **Starting while one runs** ends the running entry at the same instant the
   new one starts — no gap, no overlap.
4. **Midnight**: an entry running across midnight is listed on the day it
   started (or as the specs settle it), with its full duration.
5. **The clock in the past**: an end before the start is refused, never stored.
6. **A damaged data file** is reported, never overwritten.

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

## Measuring, scoring and the report

As every scenario: `evals/rubric.md`. Read it before you start — it says
what to record as you go, not only at the end. The report's title is
`# Evaluation: <label> — time tracker`.
