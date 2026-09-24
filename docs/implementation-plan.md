# Implementation plan

Nine milestones. Each is independently useful — M0–M3 already give you a working
review tool, and every milestone after that is an addition you could stop before.

Ordering principle: **the review loop comes before everything else.** It is the
core value (problem analysis §2, §3) and it is what all later features attach
to. Foundation and Roadmap are deliberately *not* first, even though they come
first in the user-facing flow, because building them before the review loop
exists would mean building them twice.

---

## M0 — Skeleton  ✅ done

**Goal:** `spectacular` launches, reads a real OpenSpec project, exits cleanly.

- Bun + TypeScript project; `spectacular` binary.
- OpenTUI + Solid shell: full-screen app, one pane, quit on `q`/`Ctrl-C`.
- OpenSpec adapter v0: `openspec status --all --json` → typed model.
- Project detection; a real error message when `openspec/` is absent.

**Exit:** run it in the OpenSpec repo itself (it has ~25 active changes and ~35
specs — a good stress case) and list the changes.

**Result:** met. Reads all 26 active changes in the OpenSpec repo. Delivered:

- `src/adapter/` — typed subprocess adapter over `openspec --json`, the single
  coupling point to OpenSpec.
- `src/core/pipeline.ts` — schema-agnostic stage derivation, so this works
  unchanged with `spec-driven`, spec-tacular's schema, or any fork.
- `src/render/text.ts` — headless renderer. `--print` makes the overview work
  over a pipe and in CI, and makes the layout unit-testable without a terminal.
- `src/tui/app.tsx` — OpenTUI + Solid shell with the constant frame.
- 19 tests, typecheck clean.

Also landed early, from M1: the pipeline bar, change list sorted least-complete
first, and prerequisite-gap reporting.

---

## M1 — The always-visible pipeline  ◐ partly done

**Goal:** your "clear overview at all times" requirement, standalone.

- ✅ **Pipeline bar**, persistent on every screen: stages with the current one
  highlighted. Stages are derived from the change's schema rather than
  hardcoded, so a custom schema renders correctly with no code change.
- ✅ Change list with stage and blocked reason. (Acceptance progress needs M2.)
- ☐ Header breadcrumb (`project › change › artifact › requirement`) — the
  opencode hierarchy cue.
- ☐ Live refresh on filesystem change (watch `openspec/`).
- ☐ Per-stage counts (blocked on M2's acceptance state).

**Exit:** at any moment, without scrolling, you can see which stage the active
change is in and how much of it is accepted.

---

## M2 — Review state  ✅ done

**Goal:** acceptance becomes real state. No UI yet beyond display.

- Requirement parser: flatten a change's specs into an ordered queue of
  `{ id, capability, name, text, scenarios }`.
- Normalization + `sha256` hashing of requirement text.
- `.spec-tacular/review/<change>.json` read/write, schema-versioned.
- Drift detection: hash mismatch → `pending` + a *changed* marker.
- Rollup: requirement states → artifact state → change state.

**Exit:** hand-edit a state file, restart, see it reflected; edit a requirement's
Markdown, restart, see it drop back to `pending`.

**Result:** met, verified end to end on a real change. Accepting its requirement
moved the stage to `+ specs` and advanced `next` to `design`; a whitespace-only
edit left it accepted; a wording change dropped it to `0/1 accepted · 1 pending
! 1 changed since review` and sent `next` back to review.

The parser was cross-checked against OpenSpec's own: across all 26 active
changes in the OpenSpec repo it finds **138 requirements to OpenSpec's 138, with
zero mismatches** in spec, operation or text. That agreement matters — a
requirement this parser cannot see is one nobody can review, and one it invents
is one that does not exist.

---

## M3 — The review loop  ✅ done

**Goal:** the thing the whole product exists for.

- Single-requirement view: one requirement plus its scenarios, full width.
- `a` accept · `r` reject (with reason) · `e` edit in `$EDITOR` · `d` defer
  (with reason) · `s` skip · `n`/`p` navigate · `?` help. Cancel is `ctrl+c`,
  not escape — see the note below.
- Queue progress always on screen: `17/42 · 3 rejected · 2 deferred`.
- Rejections collect into a revision instruction bundle for the agent.
- Resume exactly where you left off.

**Exit:** review a real 40-requirement change end to end using only the
keyboard, quit halfway, resume in place.

**Result:** met, against the largest change in the OpenSpec repo
(`simplify-skill-installation`, 26 requirements). Accepting all 26 by keyboard
reports complete; stopping after 7 and reopening from disk alone resumes at the
same requirement; a mixed accept/reject/defer/skip pass persists every decision
with its reason.

The screens are driven in tests by real keystrokes against the real component
tree, with assertions on the rendered terminal frame — OpenTUI's test renderer
is the same renderer, so this is not a mock of the UI.

**Two findings worth carrying forward:**

- **A lone `escape` cannot be delivered.** It is the prefix of every escape
  sequence, so a terminal parser has to wait to see what follows: pressed
  alone it produces no event, and pressed before `x` it arrives as alt-x.
  `ctrl+c` is the reliable cancel; `escape` is still accepted where a terminal
  does resolve it, but nothing depends on it.
- **`onKeyDown` on a `<box>` never fires**, even with `focused`. `useKeyboard`
  is the working API. The M0 shell used the former, so its `j`/`k`/`q` bindings
  were dead on arrival — invisible without a TTY, and caught only once the
  screens were driven by real key events.

---

## M4 — Gating and the custom schema  ✅ done

**Goal:** `proposal → specs → design → tasks`, enforced.

- Ship `schemas/spec-tacular/schema.yaml` (already drafted in this repo) with
  `design.requires: [specs]`; install it into a target project on `init`.
- Core gate: an artifact is generatable only when its prerequisites are
  **accepted**, not merely present.
- Blocked stages render the reason (*"specs: 6 of 42 requirements pending"*).
- Warn when an accepted upstream artifact drifts after a downstream one exists
  — the exact failure mode of writing design before specs settle.

**Exit:** with pending spec requirements, generating `design` is refused and the
UI says precisely why.

**Result:** met, verified against a real project. `spectacular init` installs
the schema, OpenSpec itself validates it (`openspec schema validate
spec-tacular` → valid), and a change created afterwards reports
`design <- [specs]` where `spec-driven` reports `design <- [proposal]`.

```
$ spectacular instructions design --change try-gating
Refused: design is not ready to be written
  - specs: 2 pending of 2 requirements
$ echo $?
1
```

Accepting both requirements opens the gate and OpenSpec's real instructions
flow through. Editing an accepted requirement afterwards re-blocks it and
flags the downstream artifact:

```
try-gating   * proposal  * specs  * design  > tasks  o apply
             specs: 1/2 accepted · 1 pending  ! 1 changed since review
             ! design may be stale — specs changed after review (1 requirement)
```

That last line is the failure the whole sequencing argument is about, and
OpenSpec cannot see it: both files exist, so it reports the change as fine.

**One honest limitation.** Acceptance is enforced only where it can be
measured. Only `specs` carries per-requirement review, so a prose artifact
(proposal, design, tasks) is still gated on existence alone. Requiring
acceptance there would block every change forever; assuming it would be a lie.
Document-level review — accepting `design.md` decision by decision — is the
missing piece, and it belongs with the design-review screen in M7.

---

## M5 — Agent drivers and background jobs

**Goal:** generation and `apply` stop blocking you.

- `AgentDriver` interface; Claude Code driver first, opencode driver second.
- Job runner: spawn, stream, persist to `.spec-tacular/jobs/`, cancel, reattach
  after restart.
- Job pane: detachable, tailing, collapsible — review stays interactive while a
  job runs.
- Context bundle assembly (foundation + accepted ADRs + accepted specs) injected
  into every agent call.
- One-writer-per-change lock.

**Exit:** start `apply` on change A and review change B at the same time, in one
terminal.

---

## M6 — Concreteness linter

**Goal:** stop premature specificity without another paragraph of instructions.

- `{{example: …}}` notation; parser support; distinct rendering in review.
- Rules: URL paths, HTTP verb+path pairs, `CamelCase`/`snake_case` identifiers,
  file paths, library names absent from the Foundation stack.
- Findings shown inline on the requirement during review, with one keystroke to
  mark a flagged span as an example.
- Per-project allowlist; advisory only, never blocking.
- Schema instruction updates teaching the agent the notation.

**Exit:** tuned against real specs from the OpenSpec repo to a tolerable false
positive rate; no finding can ever block a stage.

---

## M7 — Foundation and global decisions

**Goal:** ground rules before the first change (§9), and decisions that outlive
a change (§6).

- `spectacular init`: guided Foundation — language, framework, architecture
  style, layering, testing strategy, conventions — written to
  `spec-tacular/foundation/` and reviewed through the same accept loop.
- No change can be proposed until Foundation is accepted.
- ADR store at `spec-tacular/decisions/`, numbered, with supersede support.
- **Promote:** `p` on a design decision lifts it to a global ADR, leaving a
  reference behind in `design.md`.
- ADR browser screen; accepted ADRs enter every context bundle.

**Exit:** a decision promoted in change A demonstrably appears in the context of
change B's design generation.

---

## M8 — Deferral, archive split, and roadmap

**Goal:** the last two structural gaps.

- `pending-validation` register: deferred requirements with change, requirement,
  and what is needed to verify them.
- Archive split: `accepted` requirements merge into `openspec/specs/` via
  OpenSpec's archive; `deferred` ones divert to the register. The change
  archives with unfinished deployment-dependent work, without `--yes` erasing
  the record of what was never verified.
- A screen for the register; verifying an entry later merges it into the specs.
- **Roadmap:** `spec-tacular/roadmap.yaml`, vision → ordered slices, reviewed as
  a list before any change opens. Slices promote to changes one at a time.

**Exit:** a change whose only incomplete tasks require a deployed environment
archives cleanly, and those requirements are visible in the register afterwards.

---

## Sequencing notes

- **M0–M3 is the first real release.** It is a review tool for OpenSpec projects
  and it is useful with nothing else built.
- **M4 needs M2**, because gating on acceptance requires acceptance to exist.
- **M5 is independent of M4** and can be built in parallel if there are two of you.
- **M7 before M8.** The roadmap's slices should be shaped by the Foundation;
  building roadmap first would mean sequencing work before knowing the
  architecture it has to fit.
- **M6 can move anywhere after M3.** Pull it earlier if over-specific
  requirements are hurting more than the sequencing is.

## Validating the plan itself

Build spec-tacular using spec-tacular from M4 onward. It is the same trick
OpenSpec uses on itself, and it surfaces review-loop friction immediately —
while the cost of changing the design is still low.
