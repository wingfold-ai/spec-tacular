# Scenario: a group expense splitter

## The person you play

Robin, a backend developer. Comfortable with TypeScript, HTTP APIs and SQL,
new to spec-tacular and to OpenSpec. Robin has read nothing but the README of
the version under test (`README-under-test.md` in the run directory), and
reads it the way a new user does: the first screens' worth, then looks
things up when stuck. Robin wants working software at the end, not a perfect
process, has little patience for ceremony that does not pay off, and is
honest about what was confusing.

## What Robin wants to build

> **Kitty** — shared expenses for a group of friends, as a small HTTP JSON
> API that a phone app will call later. A group has members. Anyone records
> an expense: who paid, how much, and who shares it — equally by default,
> later also by exact amounts or by shares. Kitty keeps a balance per member
> (what they paid minus what they owe) and tells the group who should pay
> whom to settle up, in as few transfers as possible. Expenses can be edited
> or deleted afterwards, and a member can leave the group. One currency per
> group. Data in a local SQLite file; no accounts yet, no auth. TypeScript on
> Bun, tested with bun test.

Use this as the vision. In the interview and the ground rules, answer as
Robin would: concrete, brief, consistent with the brief. When asked for
details, give these — and only when asked:

- Amounts are entered as decimal strings with at most two decimals
  (`"12.50"`), stored and computed as integer cents.
- A leftover cent from an uneven split goes to the participants in the order
  they were listed on the expense, one cent each, starting with the first.
- The payer does not have to share the expense.
- Zero and negative amounts are refused; refunds come later, as their own
  feature.
- A member with a non-zero balance cannot leave the group.
- Member names are unique within a group, compared case-insensitively.
- Settling up suggests transfers only; recording a payment is a later slice.
- The server's port comes from the `PORT` environment variable, default 3000;
  the database file's path from `KITTY_DB`, default `./kitty.db`.

Invent anything else sensibly, keep it consistent, and note every detail you
invented in your log, so runs can be compared.

## What to do

1. **Set up** — start spec-tacular, go through its own setup.
2. **Vision and roadmap** — describe Kitty, answer the interview, review the
   proposed slices. Keep a first slice that is small and end to end: create a
   group with members, add an expense split equally among some of them, and
   read every member's balance. Drop, merge or reorder slices only where
   Robin would.
3. **Ground rules** — answer or confirm each question as Robin: TypeScript,
   Bun, `Bun.serve`, `bun:sqlite`, bun test, a simple layered structure,
   JSON errors with an HTTP status. Leave for later what Robin would not know
   yet.
4. **The first change (slice 1)** — let the agents draft each artifact, and
   review every one properly, as a careful user would: the proposal, every
   requirement one at a time (reject, with a reason, what is wrong, vague,
   untestable or over-specified), whatever else the version asks you to
   review, the design, then the tasks.
5. **Implement it** — start implementing from spec-tacular. Follow the
   session like Robin would: answer what it asks, approve sensible commands,
   deny anything outside the project. Let it finish.
6. **Finish the change** — whatever the version under test wants before the
   change is done, the way its README describes. Archive it if you get there.
7. **Judge the result** — as a reviewer of Robin's new codebase.

Stop after the first slice. Do not start a second.

## Limits

- If something blocks you, try what Robin would try — the screen's hints,
  `?`, the README — for at most three attempts, then record it as a blocker
  and work around it (for instance with spec-tacular's CLI, or by hand) so
  the run can continue. Say exactly what you did.
- Never edit spec-tacular itself, and never edit the project's files by hand
  unless the version under test tells the user to (e.g. `$EDITOR` on an
  artifact). The point is to see what the tool produces.
- Do not leave the run directory. The server listens on localhost only;
  stop it when you are done.

## Pitfalls

What a careful implementation of slice 1 gets right, and a hasty one gets
wrong. Do not mention them to the tool or the agents: the point is whether
the process brings them up by itself — in a question, a requirement, a
risk, a formal form, a test. Check each one against the produced code and
report it in the *Pitfalls* section.

1. **Money in floats.** `"0.10"` + `"0.20"` shared by one member must give a
   balance of exactly 0.30, and amounts like `"19.99"` must survive a round
   trip through SQLite unchanged.
2. **The lost cent.** `"10.00"` shared by three: 3.34, 3.33 and 3.33, in the
   listed order — the shares sum to exactly 10.00, every time.
3. **Balances sum to zero.** After any sequence of expenses, the members'
   balances add up to exactly 0.
4. **The payer outside the split.** Alice pays `"30.00"` for Bob and Carol:
   Alice +30.00, Bob −15.00, Carol −15.00.
5. **Malformed amounts.** `"0"`, `"-5.00"`, `"1.234"`, `"1e3"`, `"abc"`, a
   number instead of a string, and a missing amount are each refused with a
   4xx and a JSON error — and nothing is stored.
6. **Unknown or foreign members.** An expense naming a member who is not in
   the group, or no one to share it, is refused; nothing is stored.
7. **Duplicate names.** Adding `"bob"` to a group with `"Bob"` is refused.
8. **A partial write.** An expense whose shares fail to store leaves no
   expense behind (one transaction).
9. **Large groups and amounts.** `"99999999.99"` shared by 7 still sums
   exactly; nothing overflows or turns into a float.

## Judging the produced code

In `project/`, as a reviewer would:

- **Does it work?** `bun install` if needed, `bun test`, then start the
  server and exercise slice 1 with `curl`: create a group, add members, add
  equal-split expenses, read the balances — and every pitfall above. Note
  every failure exactly (request, response, status).
- **Does it do what was accepted?** For each accepted requirement: is it
  implemented, is it tested, does the test check it? Note requirements with
  no test, tests with no requirement, and behaviour no requirement asked for.
- **Is it good code?** Structure against the ground rules, naming, error
  handling, transactions, tests that test behaviour rather than
  implementation, and the edge cases: the pitfalls above.

## Measuring, scoring and the report

As every scenario: `evals/rubric.md`. Read it before you start — it says
what to record as you go, not only at the end. The report's title is
`# Evaluation: <label> — expense splitter`.
