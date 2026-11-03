# Evaluation: main — expense splitter

(Saved by the orchestrating session from the evaluator's hand-back: the evaluator's Write tool refused report files. Full notes in log.md; measurements in metrics.md; curl runs in judge/run.out.)

## Summary
Went the whole way in 47 minutes: setup, vision, roadmap, ground rules, proposal, 34 reviewed requirements, design, tasks; Claude Code implemented the slice in 11 minutes with one prompt (the folder trust dialog), and the change was archived. The produced Kitty API passes 167/167 tests, typechecks and lints clean, and behaved correctly in every pitfall run by hand. The process brought up integer cents, remainder order, sum-to-zero, the payer outside the split, malformed amounts, non-members, case-insensitive names and the one-transaction rule unprompted — across ground rules, specs, design and tasks. Biggest problems: no vision interview, the roadmap can only keep or drop slices, a tall requirement card rendered garbled, and the TUI has no archive step.

## Scores
| Area | Score | Level reached — the condition that decided it |
|---|---|---|
| Setup (start to first change) | 5 | No friction: one Start button |
| Vision, interview and roadmap | 3 | One major: slices cannot be merged or edited; minor: false "AI is off", no interview questions |
| Ground rules | 5 | No friction above polish; 14 questions, none no-payoff; integer cents, remainder order and rollback tests raised unprompted |
| Quality of drafted artifacts | 4 | Proposal needed two redrafts; 3 of 34 requirements revised once, all caught in review |
| Reviewing requirements (and risks etc.) | 3 | One major: requirement 8's card garbled; minor: revise diff cut off; polish: false specificity flags |
| Implementing from the tool | 4 | No friction above minor ("0 of 34 ticked" for ~8 min; wrote a diff to its /tmp scratchpad); 1 prompt |
| Finishing the change (evidence, archive, …) | 3 | One major: no archive step in the TUI; overview stale afterwards (minor) |
| The produced code works | 5 | 167/0; every curl scenario incl. pitfalls as specified |
| The produced code matches the accepted specs | 5 | All 34 requirements implemented and named by passing tests |
| Code and test quality | 4 | Layering, errors, behavioural tests, nothing dead; some named edge cases untested (0.10+0.20, 99999999.99/7, file-DB round trip) |
| Confidence the result is correct | 4 | Traced, scenario runs correct, evaluator's own mutants 5/6; no tool step showed a guard failing without its fix |
| Overall experience | 4 | Rounded mean 45/11 = 4.1 |

## Measured
See metrics.md (unchanged output of metrics.py). The TUI sidebar showed $5.22 at the end of planning; metrics.py counts $3.63 (drafting jobs only — this version keeps no usage log of its advisor sessions).

## Flow
47 wall minutes. Deciding time went to ground rules (9 min, 14 decisions, no waiting) and specs (10 min, 41 decisions, 1.9 min waiting). Design and tasks were mostly waiting (3.7 of 4 and 2.1 of 3 min); early drafts hid much of it. Implementing ran 11 minutes unattended (auto mode). Could have been spared: two proposal redrafts (one caused by the roadmap not merging slices), reading a 431-line design with 14 global decisions, hunting for the archive step.

## Question ledger
26 questions: 14 ground rules (incl. 3 follow-ups), 12 proposal open questions (8 + 4 in the redraft); 0 interview questions. Every one said why it asked. Payoff: 19 changed the result, 7 confirmed, 0 no payoff. (Full table in the evaluator's hand-back and log.md.)

## Assurance ledger
| Step | Items | Sam's minutes | Agent minutes | Caught | Payoff |
|---|---|---|---|---|---|
| Reviewing requirements | 34 | ~10 | 1.9 | balances scenario arithmetic wrong ("2.00" → "-4.00"); group-name rule made binding; all-or-nothing scenario extended to a mid-write failure (tested with a TEMP TRIGGER) | changed the result |
| Premature-specificity flags | ~20 | <1 | 0 | nothing (all false positives) | no payoff |
| Design review | 1 doc, 16 decisions | ~6 | 3.7 | nothing to reject | confirmed |
| Tasks review | 34 | ~2 | 2.1 | moved a /tmp path and port into the project | changed the result |
| Archive dry-run | 1 | <1 | 0 | 34 merge, 0 pending | confirmed |

## Friction log (summary)
1. major — roadmap: no merge/edit/reorder.
2. minor — vision: "AI is off" shown while the AI was on; no interview.
3. major — review: requirement 8 of 34 garbled (tall card), `down` moves on instead of scrolling.
4. minor — revise diff cut off at the bottom.
5. polish — specificity flags with a stray `}}`, one flag ×6 on a card.
6. minor — "0 of 34 ticked" for ~8 minutes while implementing (agent ticked in batches).
7. minor — auto mode let the agent write outside the project (its /tmp scratchpad) and reach the network without a prompt.
8. polish — package.json pins Bun 1.4.4, machine has 1.4.2.
9. major — no archive step in the TUI; the agent pointed to /opsx:archive.
10. minor — overview still showed the archived change as "Implemented".

## The produced code
167 pass / 0 fail, tsc and Biome clean; 876 source / 1,919 test lines. All curl scenarios correct (judge/run.out). Traceability: groups 10, group-members 7, expenses 12, balances 5 — all implemented and tested. Evaluator's mutants: removing the transaction → 2 failures; remainder to the last → 8; case-sensitive names → 3; no payer credit → 10; no membership check → 4; float parse with rounding survives (equivalent).

## Pitfalls
| # | Pitfall | Result | Which step made it visible |
|---|---|---|---|
| 1 | Floats | avoided | ground rules (datastore), design |
| 2 | Lost cent | avoided | ground rules, spec |
| 3 | Sum to zero | avoided | ground rules, spec (its arithmetic error caught in review) |
| 4 | Payer outside the split | avoided | proposal question, spec |
| 5 | Malformed amounts | avoided | spec, tasks |
| 6 | Unknown or foreign members | avoided | ground rules, proposal, spec |
| 7 | Duplicate names | avoided | proposal question, design |
| 8 | Partial write | avoided | ground rules (tests), spec (sharpened in review), design |
| 9 | Large amounts | avoided | proposal question (the /7 case untested by the agent) |

## Workarounds used
Dropped slices 2–3 and widened slice 1 through proposal feedback; read requirement 8 from the file; archived from the CLI; asked for port 4101 and a project-local DB in the tasks review (parallel run); mutants on a copy; adjusted overlapping phase times.
