# Evaluation: fret — expense splitter

(Saved by the orchestrating session from the evaluator's hand-back: the evaluator's Write tool refused report files. Full notes in log.md; measurements in metrics.md; curl runs in judge/run.out.)

## Summary
The whole first slice ran through the tool in about 1 h 47 min: setup, vision, roadmap, ground rules, proposal, 13 requirements, 6 risks, design, tasks, implementing, harness review, evidence and archive. 200 tests pass, evidence 19/19, and every pitfall but one is handled in code and tests. Strongest: the planning artifacts — the advisor raised the leftover cent unprompted, the specs refused `1e3`, numbers and oversized amounts unasked, the risks found gaps the specs left (`-0.01` formatting, storage order, the group-creation transaction, non-object JSON bodies), and the matrix review caught two formal forms collapsed to a single condition. Biggest problems: 22 permission prompts while implementing, mostly for harmless in-project commands; two planning defects found only while implementing (the design's test harness does not work on Bun 1.4.2; risk 1's planned check could never go red); and the accepted spec makes an empty participants list mean "everyone", where the scenario expects a refusal.

## Scores
| Area | Score | Level reached — the condition that decided it |
|---|---|---|
| Setup (start to first change) | 5 | No friction; Start to Vision in 19 s |
| Vision, interview and roadmap | 5 | Nothing above polish (merged slice kept the old name); the one interview question changed the result |
| Ground rules | 5 | Nothing above polish (a stale ★; a duplicate "Decide later" question); no no-payoff rows |
| Quality of drafted artifacts | 3 | Several defects surfaced later: design D8's harness fails on Bun 1.4.2; risk 1's check could not fail; task 3.3's boundary caught in review |
| Reviewing requirements (and risks etc.) | 4 | Nothing above minor (revise diff garbled three times) |
| Implementing from the tool | 3 | One major: 22 prompts, ~17 for in-project commands |
| Finishing the change (evidence, archive, …) | 4 | Nothing above minor: harness check, survivors and evidence only from the CLI; one task left unticked; proposal answers not written back to the foundation |
| The produced code works | 4 | One minor deviation: `participants: []` → 201, split among all (as the accepted spec says; the scenario expects a refusal) |
| The produced code matches the accepted specs | 5 | Every requirement implemented and named by a passing test (evidence 19/19) |
| Code and test quality | 4 | 4 of 5 checks; not every named edge case has its own test |
| Confidence the result is correct | 4 | 4 of 5 checks; Sam's own runs not all correct (empty participants) |
| Overall experience | 4 | Rounded mean 46/11 = 4.2 |

## Measured
See metrics.md (unchanged output of metrics.py).

## Flow
~107 minutes. Planning took 39 (14:00:40–14:39:53), mostly deciding: ground rules 9 min with no wait, specs 13 min with 2.4 waiting; 10.7 agent minutes over 7 drafting jobs. Implementing 62 wall minutes, the agent working 61.4, with 22 prompts answered at ~2-minute intervals (part of that the harness's polling latency). Finishing 6 min, 3.5 waiting. Could have been spared: ~17 of 22 prompts, and re-typing seven decisions the proposal recorded but never wrote back into the foundation.

## Question ledger
22 questions: 1 interview, 14 ground rules (incl. follow-ups), 7 proposal open questions. Every asked question said why. Payoff: 13 changed the result, 9 confirmed, 0 no payoff. Four design open questions were left to their defaults. (Full table in log.md.)

## Assurance ledger
| Step | Items | Sam's minutes | Agent minutes | Caught | Payoff |
|---|---|---|---|---|---|
| Reviewing requirements | 13 | ~13 | ~1.5 | response decimals made exact; an unobservable scenario rewritten | changed the result |
| Formal forms and read-back | 4 | ~3 | — | read-backs correct; `asked:` lines answered by the agent, never put to Sam (one of them is the empty-participants decision) | confirmed |
| Test matrices | 7 | ~3 | — | two formal forms collapsed by glossary constraints (dead/coupled conditions); fixed to test the 404/400/422 order | changed the result |
| Risks | 6 | ~4 | 1.1 | `-0.01` sign, storage position, group-creation transaction, non-object JSON bodies → all in design and code | changed the result |
| Guards shown red | 7 | 0 | in implementing | risk 1's check could not fail; the agent added values above 2⁵³ | changed the result |
| Harness review | 2 | ~4 | 0 | one harmless flaw | confirmed |
| Harness check | 2 components, 43 mutants | ~5 | <1 | 11 survivors, each covered by other tests; allowed with checked reasons | confirmed |
| Evidence | 19 | ~1 | <1 | 19/19 | confirmed |
| Hazards | 6 | 0 | 0 | registered, all mitigated | no payoff (yet) |

## Friction log (summary)
- major — implementing: 22 prompts; piping or chaining a pre-approved command (`bun test … | grep`, `export PATH … && tsc`) defeats the pre-approval.
- minor — the agent read `../shims/spec-tacular` outside the project (denied).
- minor — design D8: `server.fetch` skips the `routes` table on Bun 1.4.2; the agent stopped and asked, well handled.
- minor — revise-with-AI diff garbled three times (possibly the headless terminal).
- minor — no TUI step for the harness check, survivors or evidence.
- minor — task 2.3 left unticked; held up archiving.
- minor — proposal answers not written back to the foundation.
- polish — merged slice kept its old name; stale ★ after an architecture answer; duplicate "Decide later" question; nested example braces not stripped.

## The produced code
200 pass / 0 fail, tsc and Biome clean; 844 source / 1,578 test lines; evidence 19/19; 6 hazards mitigated. bigint money, composite foreign keys, `CHECK (amount_minor > 0)`. All curl scenarios correct except `participants: []`. Bun.serve binds all interfaces (no spec asked for localhost).

## Pitfalls
| # | Pitfall | Result | Which step brought it up |
|---|---|---|---|
| 1 | Floats | avoided | ground rules, risk 1, design D1 |
| 2 | Lost cent | avoided | the advisor's ground-rule follow-up, unprompted |
| 3 | Sum to zero | avoided | core terms; requirement |
| 4 | Payer outside the split | avoided | test-coverage ground rule; proposal |
| 5 | Malformed amounts | avoided | spec drafting (R3) |
| 6 | Unknown or foreign members | avoided for unknown and foreign; **fell in for "no one to share it"** | the agent's own `asked:` line decided "empty = everyone", never asked |
| 7 | Duplicate names | avoided | proposal open question |
| 8 | Partial write | avoided | proposal question; requirement; risk 6 |
| 9 | Large amounts | avoided | spec R3; design D1; Sam fixed the boundary in task 3.3 |

## Workarounds used
Polling helpers for long waits (harness); finishing steps from the CLI; three messages typed into the implementing session (stay inside, avoid chains, tick tasks); a trigger injected into a judge database copy for the partial-write test.
