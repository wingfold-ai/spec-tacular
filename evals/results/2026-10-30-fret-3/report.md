# Evaluation: fret-3 — time tracker

(Written by the orchestrating session from the evaluator's hand-back: the evaluator could not write this file itself. Full notes are in log.md and prompts.log.)

## Scores (1–5)
| Area | Score | Evidence |
|---|---|---|
| Setup (start to first change) | 5 | Start → Set up instant; first change created from slice 1 with no extra steps. |
| Vision, interview and roadmap | 4 | Good restatement, 5 sensible slices, `m` merge worked; only 1 interview question; merged text naively joined. |
| Ground rules | 4 | 12 questions, mostly ⇐ confirm, clean ctrl+r diff; two stale ⇐ proposals (SQLite after JSON chosen; wrong subcommands). |
| Quality of drafted artifacts | 5 | Proposal raised 10 open questions; concrete risks; design answered every risk; tasks with show-red methods; every redraft exact. |
| Reviewing requirements (and risks etc.) | 4 | Diff-based revise with glossary changes above the diff; "Reads as" exposed a wrong formula; MC/DC flagged a coupled condition. False-positive vague-word flags; 32-row matrix hard to read. |
| Implementing from the tool | 3 | One key opened Claude Code; 35/35 tasks in ~35 min; but 45 permission prompts (each `bun test … \| grep` variant asks); trust dialog defaults to "No, exit". |
| Finishing the change (evidence, archive, …) | 2 | Guards with sub-bullets counted as not shown red (parser bug); survivors only allowable from the CLI; evidence 0/24 until `evidence --run` by hand. |
| The produced code works | 5 | 189/189 tests, tsc and biome clean, every manual scenario and edge case correct. |
| The produced code matches the accepted specs | 5 | All 19 requirements implemented with tagged passing tests; 33/33 matrix rows. |
| Code and test quality | 4 | Clean hexagonal layering enforced by a test, pure decisions, atomic writes; heavy for a timer CLI; tests pin wording. |
| Confidence the result is correct | 4 | Specs reviewed line by line, guards shown red, mutation check timer 26/32, storage 17/32, listing 2/6; survivors allowed on the agent's claim. |
| Overall experience | 4 | Working, well-tested software and trusted specs; the rigor tail after implementing is costly and only partly in the TUI. |

## Totals
- Wall clock ~1 h 24 min (11:53 → 13:17).
- Cost shown $5.81 (32 requests) excluding implementing; implementing shown as 17.5M in · 128.5k out, cost not reported.
- 7 artifact drafts, 7 AI revisions; 19 requirements (15 accepted first time, 4 rejected → revised); 6 risks (1 made Unmitigated); 3 harness bindings accepted.
- 45 permission prompts (1 trust + 44 Bash), 0 denied.

## Main friction
- 45 permission prompts: commands piped into grep/head/tail don't match the pre-approved prefixes.
- `(shown red: …)` after a task's sub-bullets and paragraph not seen by the guard parser.
- Surviving mutants only allowable via CLI; many were in `src/adapters/memory/…` test doubles not matched by the default exclusions.
- Evidence not collected automatically after implementing.
- Archive refusal panel rendered over old text.
- Evaluator's own slip: a stray waiver with reason "test" left in the evidence log.
