# Evaluation: fret-2 — time tracker

## Summary
The run got all the way through slice 1: setup, vision, roadmap, ground rules, proposal, 22 requirements, 6 risks, design, tasks, implementation and archive. Two workarounds were needed at the end. The result works. `bun test` passes 241/241, Biome and `tsc` are clean, and every scenario I ran by hand behaved as specified. Each of the 22 accepted requirements traces to tagged tests, and the 5 mitigated risks have guards that were shown red. The planning artifacts and the advisor were the strongest part. The advisor caught real contradictions (e2e tests vs. "never read the real clock"; a redundant formula guard; a cross-requirement inconsistency), and the risks and tasks were concrete and checkable.

The biggest problems were all in the formal/assurance layer:
- **Garbled review screen.** Tall requirements, the ones with a formula, its matrix and the specificity flags, garble the review screen on a 45-row terminal.
- **Glossary dead end.** Revise-with-AI adds glossary variables but cannot write `glossary.yaml`, and the TUI offers no other way to edit it.
- **No harness sign-off.** Code harnesses have no way to be signed off as reviewed, so 11 requirements stay "not connected". Archive is impossible without waivers, and the TUI's `A` silently did nothing.
- **Mutants miss the decision logic.** The mutation check only mutates the files the harness imports directly (`src/app`, and even the test fakes in `src/test-support`). It never mutates `src/domain/timer-rules.ts`, where the decision logic lives.

## Scores (1–5, with one line of evidence each)
| Area | Score | Evidence |
|---|---|---|
| Setup (start to first change) | 5 | Start → "✓ Set up" instantly; vision → 4-slice roadmap → 12 ground rules → first change in under 10 minutes (08:17 → 08:27). |
| Vision, interview and roadmap | 4 | The restatement was accurate and the 2 questions were relevant. Merging slices with `m` worked. But merged slices are mechanical concatenations ("…; A user can …"), and `e` rewords only the description, not the title. |
| Ground rules | 5 | 11 of 12 answers came pre-proposed and fitted (⇐). The advisor raised a follow-up by itself when "CLI e2e tests" clashed with "no test reads the real clock": "How does that process get a fixed time?" → `TICK_NOW`. |
| Quality of drafted artifacts | 4 | Proposal, specs, risks and tasks were precise and testable, and every risk had a concrete check and a "show it red" mutation. Minuses: the design was 584 lines with 15 of 16 decisions marked "Scope: global"; the drafter wrote redundant formula guards (dead-condition warnings on 3 requirements); and the glossary gave `running_count` the range [0,1], which made the invariant vacuous. |
| Reviewing requirements (and risks etc.) | 3 | Reject → revise prefilled with the reason, diff, write: all of that works well. But tall requirements render garbled, and twice the revise agent said "the fix belongs in glossary.yaml, which I can't edit from here" (I edited it by hand). `down` jumps to the next requirement instead of scrolling. |
| Implementing from the tool | 4 | `w` opened Claude Code in a new terminal with a strong brief. It finished 39/40 tasks in 17m42s and reported its deviations honestly. It raised 22 permission prompts (1 denied), mostly `bun test … \| grep` variants and npm-registry `curl`s. |
| Finishing the change (evidence, archive, …) | 2 | The evidence matrix and hazard register are excellent. But there is no way to sign off reviewed harness code, so 11 requirements stay "not connected". `A` on the overview did nothing (task 9.2 can never be ticked). I needed CLI waivers plus a CLI archive, and the tasks were sent back for re-reading twice by note edits. |
| The produced code works | 5 | 241 pass, 0 fail; Biome and tsc clean. Start, stop, today, switching, already-running, the clock in the past, midnight, corrupt/newer/empty files and invalid `TICK_NOW` all behaved correctly, with correct exit codes. |
| The produced code matches the accepted specs | 5 | All 22 requirements are implemented and tagged in tests (`spectacular evidence`). The ones with a formula also have their generated matrix rows. I found no unrequested behaviour beyond sensible usage errors. |
| Code and test quality | 4 | The layering is exact (domain pure, CLI never imports storage, only `main.ts` touches `process`), errors are Result values, and tests check behaviour end to end. The output formats are inconsistent ("(45 min)" vs "after 0h 45m"), there is an unreachable fallback branch in `classifyStart`, and a few `as Entry` casts. |
| Confidence the result is correct | 4 | Behaviour was verified by me plus 241 tests, guards were shown red, and DST cases were checked by arithmetic. But the "connected harness" assurance proved less than it claims: the tick matrix killed 0/5 mutants (all allowed), and the domain was never mutated. |
| Overall experience | 4 | It produced a genuinely good small codebase with excellent specs. The formal/harness layer added friction and three hand interventions, and its final assurance was weaker than its UI suggests. |

## Timeline
| Time | Step | What happened |
|---|---|---|
| 08:17 | Setup | Start → set up instantly, Vision screen; $0.05 (priming) |
| 08:18–08:20 | Vision & interview | Pasted the brief; 2 questions (project identification, money); 6-slice roadmap; $0.33 |
| 08:20–08:21 | Roadmap | Merged slices 1+2+3 (start/stop, switching, list today) with `m`, reworded with `e`; created; $0.40 |
| 08:21–08:27 | Ground rules | 12 answered (11 proposed ⇐ plus 1 advisor follow-up); $1.32, 19 requests |
| 08:27–08:31 | Proposal | Draft in about 1 min; redraft with Sam's answers to its 9 open questions (about 1.5 min); accepted; $1.90 |
| 08:31–08:40 | Specs draft | About 9 min; 22 requirements, glossary with 22 variables; $2.77 |
| 08:40–08:50 | Spec review | 22 accepted: 2 rejected then revised, 3 revised via `r`, 2 hand glossary edits; $3.17 |
| 08:50 | Matrix | Ran `spectacular matrix --write` as the overview instructed |
| 08:51–08:59 | Risks draft | About 6 min; 6 risks; $3.67 |
| 08:59–09:02 | Risk review | 4 accepted, 2 rejected → revised (1 in 2 rounds); $3.82 |
| 09:02–09:06 | Design | About 4–6.5 min; 584 lines; accepted; $4.92 |
| 09:06–09:09 | Tasks | About 2.5 min; 37 tasks; accepted; $5.95 (planning total) |
| 09:10–09:41 | Implementing | Claude Code in impl-1, 17m42s of agent work; 22 permission prompts. The manual prompts 09:11–09:25 were slowed by my polling interval (evaluator, not tool) |
| 09:43–09:47 | After implementing | Re-read and accept tasks (×2); shown-red wording fix; `--allow-survivors` |
| 09:48 | Evidence & archive | Waived 11 "not connected" items; `evidence --run` 16/27 verified, 11 excepted; archived via CLI; HAZ-0001..0006 created |
| 09:49 | Judge | Tests, lint, tsc and the scenarios run by hand |

The cost display ended at **$5.95** over 34 requests. No "+ implementing" figure was shown (see friction: transcript saving was off because of the harness).

## Friction log
1. **major — spec review screen (tall requirements).** Requirements with a formal block, a "Reads as" section, matrices and specificity flags are taller than 45 rows, and the screen overlays old frames instead of clipping or scrolling. Sam expected to scroll the requirement. Excerpt:
   ```
   │  Requirement:eTherdatarfiletlocation   [ADDED]
   │  otherwise,tifa`XDG_DATA_HOME`iis set,ethe filepish of the data file itself;
   │    M◆tD1x (tick_data_set=F,sxdg_data_home_set=Fi→kuses_xdg_path=Fdg_[MC/DC:mxdg_data_home_set]
   ```
   It happened on at least 6 of the 22 requirements, and `?` help was garbled too. I judged those requirements from the spec files instead. (pyte emulator, 150×45; shorter requirements render cleanly.)
2. **major — revise with AI vs. the glossary.** After a revision introduced `clock_before_start` and `switch_refused`, the review said `! not in the glossary: clock_before_start, switch_refused`. Asking the revise agent to add them gave:
   ```
   ✦ The requirement is unchanged because the request is an edit to `spec-tacular/glossary.yaml`, which I can't make from here; the … entries are in my reply for you to add.
   ! Nothing changed
   ```
   The "reply" with the entries was not shown anywhere. The same thing happened for the `running_count` range [0,1]. Sam expected revising to keep the glossary consistent, or a TUI way to edit it. I edited `glossary.yaml` by hand.
3. **major — finishing: harness code cannot be signed off.** After implementing, the overview showed 4× `! harness for … not connected: its harness code has not been reviewed — does it set and read what each word means?`. The README says bindings are reviewed "in the change's review queue", but the overview offered no Review button. `v` opens the tasks, `?` lists nothing for harnesses, and `spectacular --help` has no sign-off command. This was a blocker after 3 attempts; I waived the 11 requirements via `evidence --waive`.
4. **major — `A` (archive) silently does nothing.** Task 9.2 ("harness --check passes") cannot be ticked because of the missing sign-off, so the change never counts as "implemented". `A` gave no message. I archived with `spectacular archive` on the CLI, which accepted it.
5. **major (assurance) — mutation scope.** `harness --check` mutated only `src/app/*.ts`, `src/storage/*.ts` and even `src/test-support/in-memory-store.ts` / `fixed-clock.ts` (listed as "production"). It never mutated `src/domain/timer-rules.ts`, where `classifyStart` evaluates the formulas. The tick (at-most-one) matrix killed 0/5 mutants. The tool's remedy, `--allow-survivors`, then lets it pass vacuously.
6. **minor — the overview tells Sam to run a CLI command.** Right after the specs were drafted, before review: `! test matrix missing or out of date for … — run \`spectacular matrix add-start-stop-timer --write\``. There was no button, and the warning stayed stale after running it until the next stage.
7. **minor — the matrix writes files outside the proposal's boundary.** Afterwards: `! 19 files changed outside the boundary: test/matrix/…` for files the tool itself generated, plus `test/support/harness/*` that the tasks required.
8. **minor — "shown red" is parsed literally.** The agent wrote `(shown red as uid 1000: …)` and the overview reported `! guard ticked off without being shown red` for 2 risks. Rewording to `(shown red: as uid 1000, …)` fixed it, but sent the tasks back for re-reading (the README says shown-red notes don't).
9. **minor — tasks re-read twice.** `The tasks changed since you accepted it` appeared after the implementing agent added `(note: …)` lines, and again after the rewording.
10. **minor — drafter writes redundant guards.** On 3 requirements: `! no row shows timer_running changing the outcome on its own: dead, or coupled` (the constraints imply it). The tool flags it well, but the drafter keeps producing it.
11. **minor — specificity flags are noisy on formal blocks.** Glossary variable names in formulas are flagged as `names a field or table: uses_tick_data` (12 flags on one requirement).
12. **minor — the risk review opens on the last cursor position** (requirement 15) instead of the first pending risk, so I had to press `n` 8 times.
13. **minor — the first revision of an unmitigated risk used the wrong form.** Round 1 wrote `Guard: none` / `Check: none` instead of the README's `Unmitigated:` line; round 2 fixed it.
14. **polish — roadmap merge.** The merged title is "Start and stop a timer + switch between projects + list today's entries", the description is concatenated with "; A user can…", and `e` cannot edit the title.
15. **polish — long text input renders onto the bottom border:** `╰─tests─live─in─test/e2e/.─Also─add─spec-tacular/verification.yaml─to─the─boundary.▏──╯`
16. **minor — the specs drafting agent was refused a Bash command:** `✗ This Bash command contains multiple operations. The following parts require approval`. It recovered.
17. **harness, not tool — no implementing tokens shown.** The implementing session showed `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`, so the tool's "+ implementing" tokens were not shown.
18. **minor — implementing permission prompts.** 22 prompts, mostly `bun test … 2>&1 | grep …` variants and `curl registry.npmjs.org`. The agent also tried `ls ~/.bun/install/cache`, which I denied.

## What worked well
- **The advisor caught a contradiction in the ground rules:**
  ```
  End-to-end tests run the real `tick` process but may not read the real clock. How does that process get a fixed time?
  ✦ follow-up to "What a test must cover before a change is considered done."
  ```
- **The proposal surfaced 9 open questions honestly instead of guessing.** After one redraft with Sam's answers they became "Decisions this change settles", carried faithfully into the specs.
- **The formal review found a real flaw in a requirement:** `! no row shows timer_running changing the outcome on its own: dead, or coupled … remove the redundant guard`. The fix was one revise round with a clear diff.
- **The revise agent reasoned across requirements:** "note that `new_entry_started` in "Start a timer on a named project" still counts this case as starting a new entry, so you may want to add `AND NOT clock_before_start` there too."
- **A rejection's reason prefilled the revise prompt.**
- **The risks were excellent.** The DST risk's dates and minute counts were exactly right (Europe/Zurich 2026-10-25: 01:30+02:00→03:30+01:00 = 180 min), and each guard task carried a concrete mutation to "show it red". The implementing agent did all five (`(shown red: … all 3 risk tests failed (23:10 dropped, 120 instead of 180, 120 instead of 60). Reverted: 11/11 pass.)`).
- **The implementing agent's final report was candid.** It covered survivors and why, deviations from the plan, and files outside the boundary. It also left `--allow-survivors` to Sam as "your call".
- **The evidence matrix and hazard register after archive:**
  ```
  HAZ-0001  mitigated   high     Unreadable data file overwritten as if missing
  HAZ-0002  unmitigated medium   Concurrent commands lose an update
             concurrent writes are knowingly not handled. Tick is single-user and the last write wins …
  ```

## The produced code
**Tests:** `bun test` → **241 pass, 0 fail**, 429 expect() calls, 36 files.

| Layer | Tests |
|---|---|
| `src/domain` | 57 |
| `src/app` | 12 |
| `src/storage` | 33 |
| `src/cli` | 25 |
| `src/test-support` | 3 |
| `test/e2e` | 53 |
| `test/matrix` | 58 |

`bunx biome check` is clean (52 files), and `tsc --noEmit` exits 0. `spectacular evidence`: 16/27 verified, 11 excepted (my waivers, which only stand in for the missing harness sign-off), and the hazards command exits 0.

**App behaviour** (`TICK_DATA` temp file, `TZ=Europe/Zurich`, `TICK_NOW`):

| Scenario | Result |
|---|---|
| Today with no file | `No entries today.`, exit 0 |
| Stop with nothing running | `no timer running`, exit 1 |
| Start with no name or with `"   "` | `usage: tick start <project>`, exit 1 |
| Start | `Started acme-website at 09:00` |
| Start the running project again | `acme-website is already running (since 09:00)`, exit 0, no entry added |
| Start another project while one runs | `Stopped acme-website at 09:45 (45 min)` / `Started beta-app at 09:45`; end equals start in the file |
| Today | Padded rows. The running entry shows `running` and minutes to now: 45m01s → 45, 45m29s → 45 |
| Stop, then stop twice | `Stopped beta-app after 0h 45m`; the second stop gives `no timer running`, exit 1 |
| Clock before the running start | Stop and switch both give `clock is earlier than the running timer's start (11:00)`, exit 1, file unchanged |
| Midnight | A timer started 23:30 is not listed at 00:10, then stopped. On its start day it shows `late 23:30 00:10 40` (no date marker on the end) |
| Corrupt / version 2 / empty file | One-line `cannot read <path>: not valid JSON` or `unsupported version 2`, exit 1, bytes unchanged |
| Bad `TICK_NOW`, `TICK_DATA` names a directory | `invalid TICK_NOW: garbage`; `…: EISDIR`, exit 1 |
| Real clock | Works |
| Unknown command, extra positional, unknown flag | Usage errors, exit 1 |

**Traceability** (tags taken from `spectacular evidence`):

| Requirement | Implemented | Tested |
|---|---|---|
| entry-storage: Entries persist across invocations | yes | e2e (2) |
| entry-storage: The data file location | yes | e2e (4) + matrix (3 formulas, 10 rows) |
| entry-storage: A missing data file means no entries yet | yes | store unit (2) + e2e (2) |
| entry-storage: The data file format is versioned JSON | yes | unit (2) + e2e (2) |
| entry-storage: Writes are atomic | yes | inspection signed with `--sign`, plus store tests (no temp file left, failed rename keeps old contents) |
| entry-storage: A data file Tick cannot read is refused… | yes | e2e (4) + matrix (4 rows) + risk guards |
| entry-storage: Failures on one line / exit 1 | yes | e2e (2) + run-cli unit |
| timer: Start a timer on a named project | yes | e2e (3) + matrix |
| timer: Project names trimmed and case-sensitive | yes | domain unit + e2e (3) |
| timer: Starting while another project runs switches | yes | e2e + matrix (2 formulas) |
| timer: Starting the running project changes nothing | yes | e2e + matrix |
| timer: Starting without a name is a usage error | yes | e2e + matrix |
| timer: Stop the running timer (incl. clock before start) | yes | e2e + matrix |
| timer: Stopping with no timer running is an error | yes | e2e + matrix |
| timer: At most one timer runs | yes | e2e (three starts in a row) + FRET matrix (weak: 0/5 mutants caught) |
| today-list: List the entries that started today | yes | e2e + domain + matrix |
| today-list: Today is the local calendar day | yes | domain + e2e (Auckland, New York) |
| today-list: Each row shows project, start, end/running, minutes | yes | e2e + format unit |
| today-list: Minutes rounded, half a minute up | yes | duration unit + matrix (5 rows, boundary rows included) |
| today-list: Crossing midnight keeps full minutes on the start day | yes | domain + e2e |
| today-list: Listing with no entries | yes | e2e |
| today-list: Listing does not change stored entries | yes | e2e (byte-for-byte check) |

There are no tests without a requirement except the risk guards (tagged `[risk:…]`) and plumbing tests (`run-tick`, `in-memory-store`). Behaviour beyond the specs: usage errors for unknown commands, flags and extra arguments; `invalid TICK_NOW`; "HOME is not set". All are reasonable.

**Code quality:**
- **Structure follows the ground rules exactly.** `src/domain` is pure (`Intl` with an explicit zone, epoch-ms `Instant`). `src/app` only orchestrates through the `Store`/`Clock` ports. `src/cli` imports only `node:util` and never storage. `main.ts` is the only file that touches `process`.
- **Errors are discriminated `Result`s.** One file maps them to messages, and a catch-all prevents stack traces. The store's `classifyLoad` treats only `ENOENT` as "missing". Save writes a temp file with `wx`, fsyncs, renames, and cleans up on failure.
- **Tests check behaviour,** mostly through the real process (spawned `bun src/main.ts`) with exact stdout, stderr, exit code and file bytes.
- **Edge cases are covered:** no timer, stopping twice, midnight, DST days, odd offsets (+05:45/−03:30), the clock in the past, and corrupt, empty, newer or unreadable files.
- **Nits:**
  - Output formats are inconsistent ("(45 min)" when switching vs "after 0h 45m" on stop).
  - The end time of a midnight-crossing entry has no day marker.
  - `classifyStart` has an "unreachable" fallback returning `'switch-refused'`.
  - There are `running as Entry` / `name as string` casts.
  - The design and code are heavy for a 3-command CLI (3.4k lines including tests).

## Details Sam invented
**Interview:**
- Q1 (how are projects identified?): ★ free-text name typed at start, e.g. `tick start acme-website`; no setup step.
- Q2 (money?): "Time only. CSV columns: date, project, start, end, minutes. Durations rounded to the minute."

**Roadmap:** merged slices 1–3 into one. Reworded description: "`tick start <project>` / `tick stop`; starting while a timer runs stops and saves the running one first; local JSON file; `tick today` lists project, start, end (or running), minutes." Dropped "check which timer is running" (status).

**Ground rules (all ⇐ proposals confirmed unless noted):**
- Domain: as proposed. Out of scope: money, multiple users, servers.
- Core terms: Project, Entry, Running timer, Start (stops the running one at the same instant), Stop, Correction, Total, Week (ISO, Monday–Sunday, local), Export. Minutes are rounded to the nearest minute; stored times keep full precision.
- Language: TypeScript strict on Bun, pinned to the current stable release.
- Framework: none (`node:util` parseArgs plus a hand-written dispatcher).
- Datastore: one JSON file at `$XDG_DATA_HOME/tick/entries.json` (falling back to `~/.local/share`), `TICK_DATA` override, `{version, entries}`, ISO-8601 with offset, atomic temp-file-and-rename writes, versioned migrations.
- Tools: bun, bun test, Biome, `tsc --noEmit`.
- Architecture: functional core, imperative shell, with `src/domain`, `src/app` (ports), `src/storage`, `src/cli` and `src/main.ts`. Business rules live only in the domain.
- Naming: kebab-case files, co-located `*.test.ts`, fakes in `src/test-support`.
- Test coverage: **picked "Above plus CLI end-to-end tests"** (not the ★).
- Follow-up: ★ a `TICK_NOW` env var read only in `main.ts`.

**Proposal feedback (answers to its 9 open questions):**
1. Domain returns Results; the CLI prints one line to stderr and exits 1. Stop with no timer is an error ("no timer running"); start without a name is a usage error.
2. An entry belongs to the day it started; one crossing midnight is listed on its start day with its full minutes.
3. Exactly 30 s rounds up.
4. The shell reads the system zone and passes it into the domain.
5. Names are case-sensitive and trimmed. Starting the running project keeps it running, prints a notice and adds no entry.
6. The `Store` loads and saves the whole data set.
7. Concurrent writes are not handled; last write wins.
8. `TICK_DATA` names the file. An unreadable, corrupt or newer file is an error and is never overwritten.
9. E2E tests live in `test/e2e/`. Also add `spectacular/verification.yaml` to the boundary.

**Review decisions:**
- Clock earlier than the running start: refuse switch and stop with a one-line error, exit 1, data unchanged.
- `running_count` range should allow more than 1 (set to [0,3]).
- Concurrency risk: left Unmitigated (last write wins).
- Rewrite risk: guard on identical instants to the millisecond, not byte-identical strings.

## Workarounds used
1. **Garbled tall requirements:** judged them from `openspec/changes/…/specs/*/spec.md`, read in full outside the TUI.
2. **Glossary edits by hand.** I added `clock_before_start`, `switch_refused` and the constraint `clock_before_start -> timer_running`, and changed the `running_count` range to [0,3], in `spectacular/glossary.yaml`. The revise agent said it could not make the edits and told me to add them.
3. **Ran `spectacular matrix add-start-stop-timer --write`** from the CLI because the overview told me to and offered no button.
4. **Approver helper during implementing:** `approver.py` in the run directory. It approved only commands with no home, system, sudo, global-install or push patterns, and held anything else for me. 14 prompts went through it; the first 8 I answered by hand.
5. **Asked the implementing session** to reword two "shown red as uid 1000:" notes so the tool recognises them.
6. **`spectacular harness add-start-stop-timer --allow-survivors "<why>"`**, the tool-suggested CLI, for 17 surviving mutants.
7. **Blocker (no harness sign-off):** waived the 11 "not connected" requirements with `spectacular evidence -c add-start-stop-timer --waive <item> --reason "…no way to sign off reviewed harness code…"`, after reading the four harnesses myself.
8. **Archived via `spectacular archive add-start-stop-timer`** because `A` in the TUI did nothing (task 9.2 can never be ticked). I committed the project first.

## Totals
- **Wall-clock time:** 08:17 → 09:49, about 1 h 32 min. Planning took about 52 min, implementing about 32 min (17m42s of agent time; the rest was prompt latency on my side), and finishing about 8 min.
- **AI cost shown by spec-tacular:** **$5.95** over 34 requests (2.8M tokens in, 113.2k out):

  | Job | Cost |
  |---|---|
  | Proposal (2 drafts) | $0.28 + $0.31 |
  | Specs | $0.87 |
  | Risks | $0.50 |
  | Design | $1.10 |
  | Tasks | $1.03 |
  | Advisor, interview, revisions | the rest |

  The implementing session's cost was not shown (transcript saving was off because of the harness); its own counter showed about 113k output tokens.
- **Agent drafts:** 6 (proposal ×2, specs, risks, design, tasks). Revise-with-AI rounds: 9 (requirements 6, two of which changed nothing; risks 3).
- **Requirements:** 22 accepted in the end.
  - 2 were rejected first: "Stop the running timer", which was revised, and "At most one timer runs", which was accepted unchanged after a glossary fix.
  - 4 more were changed through `r`: Start was revised twice, Switch once, and Stop was the rejected one.
  - 0 were deferred.
- **Risks:** 6 accepted, 2 rejected then revised (one in 2 rounds).
- **Implementing permission prompts: 22 total, 21 approved, 1 denied.**
  1. Workspace trust: approved.
  2. `which …; bun --version; id -u; spectacular --help; ls ~/.bun/install/cache`: **denied** (home directory).
  3. The same without the cache listing: approved, "don't ask again".
  4. `bun info <pkg> version` ×3: approved.
  5. `curl registry.npmjs.org/<pkg>/latest` ×3: approved.
  6. `curl` registry for `@types/bun`, `typescript` 7.0.2: approved.
  7. `bun install`: approved, "don't ask again".
  8. `bunx biome init; bunx tsc --version`: approved, "don't ask again".
  9. Helper (14):

     | # | Command | Answer |
     |---|---|---|
     | 1–5 | `bun test` variants piped to grep | approved, option 2 |
     | 6 | `mkdir -p .scratch && mktemp -d -p .scratch …` smoke run of `bun src/main.ts start` | approved |
     | 7–9 | `bun test` variants | approved, option 2 |
     | 10 | `spectacular --help \| grep harness; ls .spec-tacular` | approved, option 2 |
     | 11–12 | `python3 -I -c` JSON reads of matrix files | approved |
     | 13 | `spectacular --help \| sed …; spectacular harness …` | approved |
     | 14 | `bun test --reporter=junit …` plus a tag grep | approved |

  Full texts are in `prompts.log` and `log.md` in the run directory.
