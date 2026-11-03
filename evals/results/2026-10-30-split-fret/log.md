# Log — fret — expense splitter (Robin)

## Timeline
- 14:00:30 start; read scenario, rubric, README-under-test
SETUP_START=14:00:50
- 14:00:59 setup done: pressed Start; schema installed silently, landed on Vision screen. 1 decision. No friction.
- 14:01:15 vision start: pasted brief, enter
- Q1 (interview): "When someone actually pays back a friend after a settle-up suggestion, how does Kitty learn about it?" (says why: decides whether settlements are own record). Options: Record settlement ★ / Log as expense / Not tracked.
  Answer (typed): "Settling up only suggests transfers for now; recording a payment is a later slice of its own."
- 14:03 roadmap proposed (7 slices) after only 1 interview question. Slice 1 was "Groups and equal-split expenses" (no balances); balances was slice 2. Robin merged 1+2 with `m` (1 decision). Merge kept change name `record-equal-expense` (polish: name no longer covers balances).
- Roadmap: 1 groups+equal expenses+balances; 2 settle-up; 3 edit/delete; 4 exact/share splits; 5 record repayments; 6 members leave. Accepted as is (1 decision).
- 14:02:58 vision done; ground rules start (11 proposed)
- GR1 Domain: proposed from vision (incl. out of scope list) -> confirmed
- GR2 Core terms: proposed 12 terms incl. 'Amount: integer minor units' and 'balances sum to zero' -> confirmed
- GR3 Language/runtime: ⇐ TS strict on Bun, pin Bun version -> confirmed. (Note: a domain follow-up was added, counter now /12)
- GR4 (advisor follow-up, Domain) "When an equal split doesn't divide evenly, who gets the leftover minor units?" Says why: first change must produce shares that add up exactly. ★ one each in fixed order (e.g. by member id).
  Robin typed: "One cent each to the participants in the order they were listed on the expense, starting with the first. Shares always add up exactly to the amount." -> PITFALL 2 raised by the tool itself.
- GR5 Framework: ⇐/★ Hono; Robin picked 'None: Bun.serve routes' (changed from proposal)
- GR6 (follow-up of framework) error JSON shape + status map: ★ {error:{code,message,details?}}, 400/404/409/422/500 -> accepted ★
- GR7 Datastore: ⇐ bun:sqlite, SQL migrations, FK on, WAL, :memory: tests, money INTEGER minor units -> confirmed
- GR8 Tools: ⇐ bun, bun test, Biome, tsc --noEmit -> confirmed
- GR9 (follow-up of datastore) ID form: ★ UUIDv7 via Bun.randomUUIDv7 -> accepted
- GR10 Architecture: ⇐/★ functional core hexagonal; Robin picked 'Classic layered' (handlers -> services -> repositories)
- GR11 Layers: ⇐ src/http, src/services (pure split.ts etc), src/repositories, src/model, src/main.ts -> confirmed. (polish: ★ still recommends domain/app/http/db against the layered choice I just made)
- GR12 Business rules: ⇐ in src/services, pure split.ts/settle-up.ts; 'Money is never a float anywhere' -> confirmed (PITFALL 1 in ground rules)
- GR13 Naming: ⇐ kebab-case role files, PascalCase, money suffix Minor, snake_case DB -> confirmed
- GR14 Test coverage: ⇐ pure calcs unit tests incl leftover cents, payer outside split; invariants sum-to-amount and balances sum to zero; services on :memory:; HTTP tests each failure -> confirmed (PITFALLS 2,3,4 named)
- 14:11:47 ground rules done (14 answered: 11 proposed + 3 follow-ups; 2 changed from proposal, 1 typed). Not asked: amount format, zero/negative, duplicate names, PORT/KITTY_DB.
PROPOSAL_START=14:12:03
- 14:12:03 proposal: pressed w (let an agent draft)
- 14:12 proposal draft landed (~1 min). Good: integer minor units, leftover-cent order as answered, payer need not participate, balances sum to zero, 400/404/422. Lists 7 "open questions" (raised, not answered):
  PQ1 money type: Minor-suffix int vs Money type; and JSON amount format integer minor vs decimal string
  PQ2 who opens the SQLite transaction for expense + participant rows
  PQ3 repos return model types or rows; DI; may balances service call other services
  PQ4 how error helper learns code/status; validation hand-written vs schema lib
  PQ5 where SQLite file lives / path config; TS version
  PQ6 must requests say which member is acting (assumes no)
  PQ7 group with no members, or two members of same name
  Robin answers via r (redraft with feedback).
- 14:13:32 redraft feedback (Robin): Answers to the open questions: (1) Amounts in JSON are decimal strings with at most two decimals, e.g. "12.50", in requests and responses; stored and computed as integer cents (bare integers with the Minor suffix). Zero and negative amounts are refused; refunds come later as their own feature. (2) The service opens the transaction: an expense and its participant rows are written together or not at all. (3) Repositories return model types; services get their repositories passed in via the constructor; the balances service reads repositories only. (4) Validation is hand-written; each typed error class carries its own code and status. (5) Port from the PORT env var, default 3000; SQLite file path from KITTY_DB, default ./kitty.db. TypeScript: whatever current stable is. (6) No acting member, no auth. (7) A group needs at least one member when created; member names are unique within a group, compared case-insensitively.
- 14:14 redraft landed (~1 min). All 7 answers incorporated; JSON amounts decimal strings; zero/negative refused; all-or-nothing write; PORT/KITTY_DB. It also flagged that my answer (4) (error class carries HTTP status) departs from the architecture ground rule, offered an alternative. Also raised JPY/KWD currencies minor-digit question (left open). Good catch. Robin accepts (keeps own answer; lives with the departure). 
- 14:14:52 proposal accepted (decisions: draft w, feedback, accept =3). specs: w
- ~14:19 specs landed (~4 min drafting): 13 requirements in groups(3)/expenses(8)/balances(2) + glossary.yaml with 20 variables and constraints; formal `decision:` forms on 4 reqs with `asked:` lines. Read all fully.
  Self-raised by drafts: case-insensitive dup names (P7), zero/negative (P5), JSON number/1e3/three decimals (P5), too-large amount refused never rounded (P9), member of another group = not member (P6), all-or-nothing with fault scenario (P8), leftover cents order (P2), balances sum zero (P3), payer outside split (P4), exactness (P1). "abc" and missing amount covered generally.
  Invented by draft: empty participants = everyone in creation order; description required; duplicate participant -> 400; any currency code accepted.
SPECS_START(review)=$(date +%T)
- R1 balances/Member balances in a group: accept (scenarios exact, incl. payer outside split, leftover cents)
- R2 balances/Balances sum to zero: accept (property-style scenario, a bit loose on 'different payers' but THEN is checkable)
- 14:21:30 R3 Amounts as decimal strings: revise (r): Two things. (1) Responses must always write exactly two decimals ("12.50", "0.00", "-3.34"), not "at most two" — the phone app parses them; make that the contract, not an example. (2) The matrix says amount_is_string and amount_format_ok never change the outcome on their own because of the glossary constraints, so the formula is really just amount_positive. Make the formal form honest: one condition for "a well-formed amount string" and one for "greater than zero", or whatever reads right — and keep the zero/negative rule consistent with the separate "greater than zero" requirement.
- R3 revision returned in ~20s: exactly two decimals in responses as contract + new scenario; formula now amount_well_formed AND amount_value_positive with 2 new glossary vars (shown above diff). Good.
  FRICTION (minor, rendering): the revise diff screen shows garbled lines where stale characters of my typed prompt interleave with the text:
    "│  rounde1w·t“Two:things.s(1)eResponsesdmustdalways writegexactly two decimals ..."
    "│  │ + ThepsystemHSHALLvwriteoeveryaamountaindafresponsemasha JSONtstringfholdingnardecimalinumberdof the group's"
    "│  │   zerotor negativelSHALLbbe refusedrtheisameHway,bwithfstatush400aandwthe error bodydnaming theuamounttfield,"
  Persisted across re-reads; may be the headless terminal emulator, not certain. Had to read the file to be sure of the text.
- R3 after revision: matrix 4 rows, 3 MC/DC, dead-condition warning gone -> accept (1 revise round). ASSURANCE: matrix dead/coupled-condition flag caught a degenerate formula.
- R4 Amount > 0: accept (overlaps R3 now, but consistent)
- 14:23:33 R5 Record an expense: revise (r): The prose is right. But the matrix again says group_exists and expense_request_valid never change expense_recorded on their own, because the glossary constraints make payer_is_member imply them. Make the formal form consistent with the prose so the matrix actually tests the 404/400/422 order — e.g. membership as plain inputs without those constraints. Do not change the behaviour.
- R5 revision (~30s): new unconstrained vars payer_in_group/participants_in_group; matrices now 16/2/4/16 rows, no dead warning. Garbled diff rendering again. Old vars payer_is_member/participants_are_members likely orphaned in glossary. -> accept (1 revise round)
- R6 Participants default to every member: accept. Note: the 'asked:' lines (empty list = everyone; creation order) were answered by the agent itself, never asked to Robin; Robin finds them defensible. (Relevant to P6 'no one to share it')
- R7 Equal split leftover cents: accept (exact, testable, 6 scenarios)
- R8 All or nothing: accept (fault-injection scenario; 500 without internals)
- R9 List expenses: accept ('stable order' with oldest-first only as example is a bit soft; acceptable)
- R10 Expenses kept across restarts: accept
- R11 Create group: accept (case-insensitive unique names, >=1 member). Matrix 32 rows for a 5-way AND — heavy for what it is. Polish: nested {{example: `{...}`}} not stripped in render. Whitespace-only/trim names not covered.
- R12 Read group: accept
- 14:26:21 R13 Groups kept across restarts: REJECT: The 'Refused group not stored' scenario cannot be checked through the API: a refused request returns no id and there is no way to list groups. Say what is observable (e.g. a test looks at the data file and finds no group or member rows from it) or drop that scenario.
- 14:27:47 R13 revision (~30s) accepted, then accepted R13. All 13 accepted. specs phase decisions: w + 13 accepts + 1 reject + 3 revise prompts + 3 revision accepts = 21
- 14:27:58 risks: w
- 14:30 risks drafted (~3 min): 6 risks — float parsing (high), sign lost on -0.xx (high), member/participant order not kept (high), member of another group as participant (med), valid-JSON-not-object -> 500 (med), half-created group (med). Each with hazard/affects/boundary/causes/severity/guard/check. Strong; found gaps the specs leave (sign of -0.01, ordering by position, group-creation transaction, wrong-type bodies).
- 14:32:07 risks: 'Looks good' on draft, then accepted all 6 in queue (read in full in risks.md first; checked the arithmetic of the checks for risks 2 and 3 — correct). Small inconsistency: risk 1 check says "12.5" formats back to "the same" string, but responses write "12.50". Not worth a round. Decisions: w + looks good + 6 accepts = 8.
- 14:32:16 design: w
- 14:36 design landed (~5 min, 404 lines). D1 bigint minor units + regex ^[0-9]+(\.[0-9]{1,2})?$ + cap at 2^63-1 (P1,P9); D2 pure decide functions per formal form; D3 hand-written validation in http, validation result passed to service so 404 precedes 400; D4 errors carry code+kind (NOT status) — design chose to keep the settled ground rule instead of my proposal answer, said so openly; D5 splitEqually/computeBalances pure; D6 schema with position columns, composite FKs (group_id, member_id) so foreign members cannot be stored (P6), CHECK amount>0; D7 injected runInTransaction (P8); D8 routes/shapes; D9 fault injection via SQLite trigger. Every risk answered by name. Open questions: status on errors, whitespace-only names, case folding (ß), JSON number message — each with a default. Robin accepts as is (defaults fine).
- 14:37:05 design accepted (2 decisions). Did not promote global decisions to ADRs (p) — Robin sees no need now. tasks: w

## Question ledger (running)
| # | Asked in | Question | Why given? | Answer | 
|1|interview|How does Kitty learn about a repayment?|yes|suggest only; recording later slice|
|2|GR domain|What the system is for (⇐)|n/a proposed|confirmed|
|3|GR domain|Core terms (⇐)|proposed|confirmed|
|4|GR follow-up|Who gets leftover minor units?|yes|listed order, first first|
|5|GR stack|Language/runtime (⇐)|proposed|confirmed|
|6|GR stack|Framework (⇐ Hono)|proposed|changed to Bun.serve|
|7|GR follow-up|Error JSON shape/status map|yes|★ accepted|
|8|GR stack|Datastore (⇐)|proposed|confirmed|
|9|GR stack|Tools (⇐)|proposed|confirmed|
|10|GR follow-up|ID form|yes|★ UUIDv7|
|11|GR arch|Style (⇐ hexagonal)|proposed|changed to layered|
|12|GR arch|Layers (⇐)|proposed|confirmed|
|13|GR arch|Where rules live (⇐)|proposed|confirmed|
|14|GR conv|Naming (⇐)|proposed|confirmed|
|15|GR conv|Test coverage (⇐)|proposed|confirmed|
|16-22|proposal OQ|7 open questions (money type/JSON format; transaction owner; repos/DI; error helper/validation; db path/TS version; acting member; empty group/dup names)|yes, each "this slice has to settle"|answered in one feedback|
Design open questions (4) — left at their defaults, not answered.
- 14:39:15 tasks landed ~14:38 (~2 min). 7 sections, 40 tasks, guard tasks per risk with 'verify red', tags per req. DEFECT found: 3.3 says refuse '9223372036854775.08' (= 922337203685477508 cents < 2^63-1). Redraft: Task 3.3 has the boundary wrong: "9223372036854775.08" is 922337203685477508 cents, far below 2^63-1, so it must be accepted, not refused. The value just above the limit is "92233720368547758.08". Fix that example; everything else is fine.
- 14:39:53 tasks redraft (~30s) fixed exactly 3.3; accepted. 3 decisions (w, feedback, accept). implementing: w
IMPL_START=14:40:28; prompt 1 workspace trust -> approve
- 14:43:38 told impl agent: stay inside project; carry on
- 14:54:24 queued note to impl agent: avoid export PATH and chains (each triggers a prompt)

## Assurance ledger (running)
- Reviewing requirements: 13 items, ~13 min Robin (14:14:52-14:27:47 incl. revisions), agent ~1.5 min (3 revisions ~20-30s each). Caught: response format "at most two decimals" vs exactly two (R3); untestable "refused group not stored" scenario (R13).
- Formal forms + read-back: 4 reqs with decision forms (R3,R5,R6,R11); read-backs read fine; `asked:` lines answered by agent itself (not Robin).
- Test matrices (in review): flagged dead/coupled conditions twice (R3 amount, R5 record expense) -> two revisions to make formulas non-degenerate. Caught: degenerate formal forms due to glossary constraints (would have produced matrices that test nothing of 404/400 order).
- Risks: 6 items, ~3 min Robin; agent ~3 min. Caught (beyond specs): -0.01 sign formatting; explicit position ordering; group-creation transaction; non-object JSON -> 500.
- Tasks review: caught a wrong boundary value in 3.3 (Robin's own arithmetic, not the tool).
- 15:35:32 IMPL QUESTION: agent found server.fetch(new Request) skips Bun.serve routes table in Bun 1.4.2 (repro), so design D8's harness/conventions' 'call fetch handler directly' doesn't work. Options: network fetch to port 0 (rec) / hand router / stop for design update. Robin picks 1 (network fetch). DEFECT IN DESIGN surfaced later (D8).
- 15:42:19 impl agent finished its turn (started 14:41, 'Cogitated 18m47s' last turn). 40/42 ticked; 2.3 and 7.2 open. Reports: surviving mutants (expenses 13/19 caught, groups 19/24), harnesses need --accept, impossible groups rows, departures (network fetch; float guard extended above 2^53 since 0..100 sweep can't fail Math.round).
FINISH_START=15:41:56; overview shows: 1 file outside boundary src/main.test.ts; evidence 0/19; harness expenses/groups not connected (not reviewed). Next: Review the harness: 2 bindings
- 15:43:14 harness review: read test/support/harness/expenses.ts and groups.ts in full; real production functions, outputs read from result. Small flaw: in expenses harness participants_given=F with participants_in_group=F still sends [stranger] (a given list) — not driven in any matrix together, so harmless. Accepted both (2 decisions).
- 15:44:24 Robin verified each survivor's reason in the code/tests, then ran: spec-tacular harness record-equal-expense --allow-survivors "Checked each survivor: amount-json.ts:17 (> vs >= at the 2^63-1 cap) is pinned by the unit test in src/http/amount-json.test.ts:37-38; split.ts:8 is the splitEqually precondition, unreachable from decideRecordExpense (validation guarantees amount > 0, groups have >= 1 member) and tested in split.test.ts:41-42; json-body.ts malformed-JSON / non-object branches have no glossary variable and are covered by group-routes.test.ts, expense-request.test.ts and the non-object risk guard."
- 15:44:51 spec-tacular evidence record-equal-expense --run: 19/19 verified (13 req + 6 risks), exit 0.
- 15:45:03 told impl agent: harness accepted, survivors allowed, tick 7.2, why is 2.3 open?
- 15:47:01 archived via A + enter: 13 reqs into baseline, 6 risks -> hazards HAZ 0001-0006. finishing decisions 7 (2 harness accepts, allow-survivors, evidence --run, msg to agent, A, enter).
- 15:47-15:52 judging: bun test 200 pass / 0 fail (24 files); tsc 0; biome clean. Server on PORT=4102 KITTY_DB=judge/kitty.db: all slice-1 flows and pitfalls checked with curl (judge/run.out). Empty participants list -> 201 split among all (accepted spec R6; pitfall 6 expects refusal). Partial write via injected trigger -> 500 internal_error, nothing stored, balances unchanged. 19.99 stored as integer 1999 and listed unchanged after restart. Server binds *:4102 (all interfaces), no hostname set. Server stopped.
