# spec-tacular

A terminal UI for spec-driven development that builds **on top of** [OpenSpec](https://github.com/Fission-AI/OpenSpec).

OpenSpec gets the artifacts right: proposals, specs, design, tasks, archive. What it
does not give you is a **review surface**. Everything is a folder of Markdown you read
in your editor, and "done" means "the file exists". spec-tacular adds the missing half:
a keyboard-driven review loop, an explicit accept/reject state per requirement, and a
pipeline that is always visible.

## What it changes

| OpenSpec today | spec-tacular |
| --- | --- |
| Artifact is "complete" when its file exists | Artifact is complete when a human **accepted** it |
| `design` only requires `proposal` — both can be written at once | `design` requires **accepted** specs and risks; strict `proposal → specs → risks → design → tasks` |
| Risks are a prose section nobody accepts or tests | Each **risk** is reviewed on its own, answered by name in the design, and guarded by a test **shown to fail** without its mitigation |
| Nothing says what a change may touch | The proposal declares a **boundary**; files changed outside it are flagged |
| Review = reading N spec files in your editor | Review = one requirement (or risk) at a time: `a` accept / `x` reject / `d` defer, or revise it with AI (`r`) |
| Design decisions stay local to a change | Cross-cutting decisions are **promoted to global ADRs** |
| No project ground rules before the first change | A **Foundation** phase: stack, architecture style, conventions, ADRs |
| Greenfield = 15 changes proposed at once | A **Roadmap** layer that sequences an idea into reviewable slices |
| Drafting blocks the terminal | Drafts are written in the **background** while you keep reviewing; implementing opens your agent itself, right in the TUI |
| A task needing a deployed env blocks archive | That task is **deferred**; the rest of the change archives |

## Install

spec-tacular is a single binary for Linux and macOS (x64 and arm64); it needs no
Bun or Node of its own. It drives the [OpenSpec](https://github.com/Fission-AI/OpenSpec)
CLI, which you install separately:

```bash
npm i -g @fission-ai/openspec
```

**With the GitHub CLI** — works while the repository is private, as long as `gh`
is signed in with access to it:

```bash
gh api repos/mhoegger/spec-tacular/contents/install.sh -H 'Accept: application/vnd.github.raw' | sh
```

The script picks the build for your OS and CPU, checks it against the
release's `SHA256SUMS`, and installs `spec-tacular` to `~/.local/bin`. Set
`SPECTACULAR_VERSION=v0.1.0` for a particular release and
`SPECTACULAR_INSTALL_DIR` for another directory. Without `gh` it downloads with
`curl` from github.com, which works once the repository is public. Run it again
to update. Until 0.3.0 the command was called `spectacular`; the script removes
that old copy when it installs `spec-tacular`.

**By hand** — download `spec-tacular-<version>-<os>-<arch>.tar.gz` and
`SHA256SUMS` from a release, then:

```bash
gh release download -R mhoegger/spec-tacular -p 'spec-tacular-*-linux-x64.tar.gz' -p SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS   # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
tar -xzf spec-tacular-*-linux-x64.tar.gz
install spec-tacular-*-linux-x64/spec-tacular ~/.local/bin/
```

**From source** — needs [Bun](https://bun.sh):

```bash
bun install && bun run build   # writes dist/spec-tacular
```

### Releasing

Bump `version` in `package.json` in the pull request and merge it into
`ts/main`: that is the whole release. The auto-release workflow tags the merge
`v<version>` and runs the release. A merge that leaves the version alone
releases nothing. Tagging by hand still works too:

```bash
git tag v0.3.0 && git push origin v0.3.0
```

The release workflow checks the tag matches `package.json`, builds and
smoke-tests each platform on its own runner, and publishes the archives with
`SHA256SUMS`. A tag with a hyphen (`v0.2.0-rc.1`) makes a pre-release. A pull
request that touches the workflow or `scripts/` runs the same builds as a dry run.

## Try it

```bash
bun install

# First run `openspec init` in the folder and pick your agent (Claude Code or
# opencode): spec-tacular will not start without it. Then open the TUI there.
# It opens on a start screen with a Start button, then walks you through:
#   1. Set up        installs the spec-tacular schema
#   2. Vision        (new projects) describe what you are building; an AI
#                    interviews you, then splits it into a roadmap of slices
#   3. Ground rules  domain, stack, architecture, conventions — one question at a
#                    time, proposed from the vision (or, without one, the domain)
#   4. First change  the first slice — or, on an existing project, describe a change
# After that, every change shows its next step as buttons, and ? lists every key.
bun run src/cli.ts --cwd /path/to/project
```

A new project describes its vision first — what you are building, and for
whom, in your own words, followed by a short AI interview — because that is
the one thing only you know, and most of the ground rules follow from it.
As soon as the interview ends — while you review the roadmap — the advisor
proposes an answer for every ground rule the vision states or implies, the
domain as much as the stack, so the ground rules open with their answers
waiting and are mostly confirming (⇐, enter). Without a vision (an existing
project, or one that skipped it) the ground rules start with the domain
question instead, and the rest is proposed from that. On a new project only
what can be answered on day one is asked; the rest is left for later:

| | Questions |
| --- | --- |
| Asked | What the system is for, and who uses it |
| Proposed from the vision or the domain (⇐, enter confirms) | the core terms · language and runtime · framework · datastore · package manager and tools · architecture style · layers and which may depend on which · where business rules live · naming · what a test must cover |
| Left for later | domain invariants · out of scope · what is ruled out · error handling · configuration and secrets · code review · comment style · what newcomers get wrong |

Questions left for later stay in `spec-tacular/foundation/`, saying *Decide
later*: they are not asked, do not block the first change (the gate lists
them as warnings), and every agent reads that they are not settled. An
existing project is asked all nineteen, domain first.

With an AI advisor alongside:

- **The rest is proposed from the domain.** Once you have said what it is
  for, the advisor proposes an answer for each question marked for it — a
  sensible, current choice for a project like yours — shown ⇐ and
  pre-selected, so most of the setup is reading and pressing enter. A
  confirmed proposal moves straight on.
- **An architecture style decides its own rules.** Choose Clean Architecture
  and the layers question is already answered, instantly and without a model:
  *entities ← use cases ← interface adapters ← frameworks & drivers,
  dependencies point inward only, an inner layer never imports an outer one*,
  with folder names, and where business rules and I/O live (dependency
  inversion at every boundary). Hexagonal / ports & adapters, layered, MVC,
  modular monolith and vertical slices have their rules too
  (`src/core/derivations.ts`); the advisor then fits them to your project.
- **It keeps the setup short.** After each answer it looks at what the
  answer leaves open. At most one question the first change cannot do without
  is asked next; every other detail it notices is written into the Foundation
  as *Decide later*, like the questions above, and a change that depends on
  it raises it then. A follow-up raises no follow-ups of its own. Enter moves
  on without waiting.
- **Common answers need no waiting.** A small table of presets
  (`src/core/presets.ts`) knows what "Python", "TypeScript", "Rust", "Go",
  "Postgres", "hexagonal" and friends mean for the questions still ahead, so
  their options (uv / poetry / pip, pytest, FastAPI, …) appear the instant you
  answer, marked ◇; what they leave open (the Python version, the Rust
  edition, …) is recorded for later, not asked. The advisor refines the
  options in the background but never moves the one you have selected or
  touches a question you already answered. Presets never carry version
  numbers: those are always looked up.
- **It proposes whole answers.** Questions come with options for your
  project so far, and answers that already follow from earlier ones are
  derived and pre-selected, marked ⇐. An option has a short name for the list
  and a complete answer — for a broad question, every layer and which may
  depend on which, or each tool with its role — shown in full under the list
  for the one highlighted. Picking it writes that answer. Nothing is written
  until you pick one or type your own.
- **Pick, then adjust it with AI.** `ctrl+r` on an option (or on the answer
  already given, or a draft you typed) opens the same conversation as
  revising a requirement: say what should change, see the diff, accept, ask
  again, or discard. Only an accepted revision is saved.
- **Not sure?** Press `?`, type "help" or "not sure", or just press enter on
  an empty answer: you get a plain-words explanation, examples for your
  project, and simpler questions to answer first — whose answers often derive
  the hard one.
- **Not decided yet?** Every question lists *Skip* as its first choice (tab
  or typing "skip" do the same). It is never the pre-selected one: a ⇐
  derived answer is, else the ★ recommendation, else writing your own. A
  pass ends once every question is answered or skipped — skipped questions
  are never asked again in the same pass — and `ctrl+f` (or typing "done")
  ends it early. Whatever is still open is then left for later, so setup
  always moves on to the vision or the first change. `ctrl+d` drops a
  question the advisor added that is not relevant.

A new project starts from its vision rather than a change — there is nothing
to change yet, and it comes before the ground rules. (If you answered the
Domain question first, the description starts from that answer, so nothing is
described twice: add to it or press enter.) The AI restates what
it understood and asks one question at a time, with options — at least one,
however complete the description — until it has
enough or you say "done" (Skip, the first choice, tab or "skip" pass on a
question). It then proposes 3–8
slices in build order, the first the smallest thing a user can do end to end.
The selected slice is shown in full. Reshape them before anything is written:
`space` drops one, `m` merges it with the next into one change, `shift+↑↓`
moves it (never before a slice it builds on), `e` rewords what it does. The
rest become `spec-tacular/roadmap.yaml`;
the vision and interview go to `spec-tacular/vision.md`, which every agent
reads. The first slice becomes your first change, and the ground rules come
next, proposed from the vision; its proposal is drafted once they are settled.

Drafts are for reading. While an agent drafts, its progress streams into the
change panel; when it lands, the draft opens: scroll through it, then
accept it (`a`), redraft it with feedback (`r`) — the agent revises it with
what you typed — or edit it (ctrl+e). Accepting starts nothing by itself: the
next artifact waits on the overview until you draft it (`w`). `v` reads it
again later.

An agent stops rather than design around accepted requirements that
contradict each other or leave the decision open. When it does, it writes a
report instead of the artifact, and the TUI opens that report: each conflict
or gap, with the full text of every requirement involved underneath, so you
can see the contradiction for yourself. `s` opens the review on the first of
those requirements to revise it, `r` answers the agent (say, which side to go
with) and drafts again, and `w` simply tries again. Until the next draft, the
overview keeps the warning up, and `o` reopens the report.

The same interaction has the same key everywhere: `a` accepts, `r` revises
with AI (ctrl+r on the screens where you type), ctrl+e opens `$EDITOR`, `y`
copies and `q` goes back. `?` lists every key.

The proposal, design and tasks are accepted as a whole, the specs
requirement by requirement; either way the next artifact waits for it, and
the stage is ticked off only then. An acceptance holds for the text you read:
edit or redraft the document and it is waiting to be read again (ticking
tasks off while implementing does not count as a change).

Requirements are reviewed one at a time: `a` accepts, `x` rejects (asking
why), `d` defers (asking what would verify it). `r` revises the requirement
with AI, in conversation: say what should change ("make the timeout
configurable", "split it into two scenarios") and the agent answers with the
revised requirement, shown as a diff against the file. Then `a` writes it
into the spec — replacing that requirement's block, every other byte of the
file left as it was — `r` asks for more changes (as many rounds as you like;
the agent sees every earlier request and proposal), and `q` discards it.
Nothing is written before `a`, and ctrl+c while the agent works leaves the
file untouched. A rejected requirement's prompt starts from why you rejected
it. A revised requirement is pending again, cursor on it, for its new text to
be accepted; the other requirements keep their decisions, a rename included.
ctrl+e (or `E`) still opens it in `$EDITOR`, and `y` copies it.

Once the specs are accepted, the change lists its **risks** in `risks.md`:
what it could break, each with its hazard, the requirements it threatens,
the situation it arises in, a severity, the guard that rules it out and how a
test checks it. They are reviewed in the same queue, after the requirements,
one at a time (`a` / `x` / `d`), and an edit sends one back to pending. A risk
left knowingly unmitigated says why in an `Unmitigated:` line instead. Then each
risk is followed through, and the overview names whichever one is not:

```
risks: 2/2 accepted
! the design does not answer risk "Export leaks other users"
! guard ticked off without being shown red: "Export leaks other users"
! 1 file changed outside the boundary: lib/oops.ts
```

- The **design** must answer every risk by its name.
- The **tasks** carry a guard task per risk, `(guard: <risk>)`, whose test
  must be shown to fail with the mitigation removed. The agent records how,
  `(shown red: …)`, and a guard ticked off without it still counts as open.
  Recording it does not send the accepted tasks back to be read again.
- The **proposal** names a `## Boundary`: the paths the change expects to
  touch. Once implementing has started, files changed on the branch outside
  it are listed. Advisory: only a person can tell whether reaching further was
  right.

Not every change deserves the same rigor. `spec-tacular/classes.yaml` sorts the
code by what a failure would cost, P0 (highest) to P3, and a change is in the
highest class it touches — by its boundary, and again by the files it actually
changed, which are named if they raise it:

```yaml
default: P2                      # code no area names
classes:
  P0:
    why: a wrong decision here lets unreviewed work through
    paths: [src/core/gate.ts, src/auth/]
tailoring:                       # a rule waived for a class, never without why
  - class: P0
    rule: diff-review
    reason: one developer; every merge is pair-reviewed
```

Each class turns rules on. Today there are two:

- **P0 — `diff-review`**: the agent wrote the code, so it cannot be the one to
  certify it. Ticking the last task off is not the end: a person reads the
  implementation diff (`v` on the overview, or `spec-tacular diff <change>`)
  and accepts it (`a`, or `--accept`). Like every acceptance it holds for
  that text — a later change to the code sends it back — and archiving is
  refused until it is done.
- **P0 and P1 — `guard-high-risks`**: a high-severity risk cannot be left
  `Unmitigated:`; the design is refused until it has a guard.

A waived rule is named wherever it would have applied, with its reason.
`spec-tacular classes` prints the map, the rules and every change's class;
agents read the same. Without a `classes.yaml` nothing changes: no change has
a class, and no class rule applies.

A ticked task is a claim; a passing test is **evidence**. Tests name what they
verify in their own name — `[req:<capability>#<slug>]` for a requirement,
`[risk:<change>#<slug>]` for a risk's guard — in any language. Tell
spec-tacular how to run them, in `spec-tacular/verification.yaml` — `init`
writes it with the lines for common runners commented out (evidence stays off
until one is uncommented, and the tasks of a first change fill it in):

```yaml
command: bun test --reporter=junit --reporter-outfile=.spec-tacular/junit.xml
report: .spec-tacular/junit.xml   # any JUnit XML: vitest, jest, pytest --junitxml, …
```

`spec-tacular evidence --run` runs them and appends what it found — per item,
with the hash of the item's text and of the test's file — to
`.spec-tacular/evidence/<change>.jsonl`. Nothing in it is ever rewritten. Then
`spec-tacular evidence [<change>]` prints the verification matrix:

```
add-export  1/2 verified
  passing  test          export#export-data  Export data
           [req:export#export-data] exports the caller's data
  missing  test          risks#export-leaks-other-users  Export leaks other users
           name a test with [risk:add-export#export-leaks-other-users]
```

- **States** are kept apart: `missing`, `passing`, `failing`, `stale` (the
  item's text or the test file changed since it passed) and `excepted`.
- **Not everything is a test.** A requirement can say `**Verified by:**
  analysis`, `inspection` or `demonstration`; a person records it with
  `--sign <item> --method <m> --note "<what was checked>"`.
- **Waiving** takes a reason: `--waive <item> --reason "<why>"`. A deferred
  requirement is excepted by its deferral; a risk left `Unmitigated:` needs
  none.
- **Orphans**: a test naming a requirement or change that does not exist is
  listed by `--run`.
- **No-Go until proven**: with `verification.yaml` in place, archiving is
  refused while any accepted requirement or risk is not passing or excepted,
  and `spec-tacular evidence` exits non-zero — usable in CI.
- The review flags a requirement whose scenarios are all the happy path: a
  negative test needs a scenario that says what must not happen.

Risks outlive their change. When a change is archived, each accepted risk
joins the **hazard register** in `spec-tacular/hazards/` — one numbered file
per hazard, like the ADRs: what must not happen, its causes, what it affects,
the controls put in place and the guard tests that verify them. A later risk
of the same hazard names it, `- **Known hazard:** HAZ-0003`, and updates that
entry instead of adding a second. Every risks draft starts from the register.

A hazard's status follows its guards, which keep running after their change
is gone:

```
$ spec-tacular hazards
HAZ-0001  open        high     Export leaks other users
           guard failing: [risk:add-export#export-leaks-other-users]
HAZ-0002  unmitigated low      Huge export
           out of scope until pagination
```

*Mitigated* holds only while every guard passed its latest run; one never run
leaves the hazard *unverified*, and a failing one makes it *open* again —
said on every `--print` overview, and `spec-tacular hazards` exits non-zero.
An entry not looked at for 90 days is listed as due for review;
`spec-tacular hazards --reviewed HAZ-0001` records a look.

Fixing something is a change of its own kind. `b` on the overview (or
`spec-tacular defect <name> --description "…"`) asks what went wrong and
creates a **defect change**, with its own schema — installed by `init` next
to the main one — whose stages have the same names, so every review, gate and
evidence rule applies:

- **The report** (proposal) says what was observed, what was expected, how to
  reproduce it — and first of all `**Whose bug:** code`, `requirement` or
  `gap`. Most defects trace to a requirement that allowed what happened, so
  the report decides this before anything is fixed.
- **The specs** follow from the answer. A code bug repeats the violated
  requirement unchanged, for a person to confirm it was right; a requirement
  bug corrects it; a gap adds the missing one, with a scenario that is the
  defect. The overview flags a spec that does not fit the report — *a code
  bug changes no requirement, but this one changes "Export data"*.
- **The risks** start with the defect itself, its guard the reproducer: a
  test that fails on the code as it is. At archive it joins the hazard
  register, or updates the hazard it is a recurrence of.
- **The fix** (design) names the proximate cause, the root cause and the
  contributing factors — and why the tests did not catch it.
- **The tasks** begin with the reproducer, shown red before the fix.

Prose can be read two ways. Where a requirement turns on a decision or on
timing, it can carry a **formal form** — after its text, in a fenced block
that is part of what is accepted:

````markdown
```formal
decision: archive_allowed = tasks_applied AND specs_accepted AND NOT stop_open
fret: upon request_sent Client shall within 3 ticks satisfy response | timeout_error
asked: Does a deferred task count as open? — No; deferred tasks are excused.
```
````

- `decision:` defines an output by a boolean condition (`AND`, `OR`, `NOT`,
  `XOR`, `->`, `<->`, comparisons); `fret:` is NASA FRET's structured English
  — scope, condition, component, timing, response.
- Its variables come from `spec-tacular/glossary.yaml`: each with its role
  (mode, input, output, internal), type, meaning, and where its value comes
  from. `spec-tacular glossary` lists them, what uses each, and which have no
  source and so cannot be observed. Its **constraints** say which
  combinations cannot happen, so the matrix does not ask for tests of them:

  ```yaml
  variables:
    timer_running: { role: input, type: bool, meaning: a timer is running, source: the data file }
    same_project:  { role: input, type: bool, meaning: started on the running timer's project }
    file_version:  { role: input, type: int, range: [1, 3], meaning: the data file's schema version }
  constraints:
    - same_project -> timer_running      # same project as the running one needs a running one
  ```

  Types are `bool`, `int`, `float` and `enum` (with `values:`); `boolean`,
  `integer` and `number` are read as the first three.
- The review reads it back in plain words, with what each variable means —
  *archive_allowed is true exactly when tasks_applied and specs_accepted and
  not stop_open* — so a wrong formula is caught as a wrong sentence.
- `asked:` lines are the questions formalizing forced; their answers go into
  the prose, which stays what the specs promise.
- A formula that cannot be read, names a variable the glossary does not have,
  or defines an output differently from another requirement holds up the
  design, with the combination where they differ.
- A requirement without one is flagged for the words it leaves undefined:
  *promptly*, *large*, *gracefully*.

A formal form's tests are not chosen; they are generated. `spec-tacular matrix
<change>` derives its **test matrix**, shown in the review under the formula:

```
Matrix (3 conditions): alarm = armed & voltage > 9 & voltage < 20
  × D1   armed=F, voltage > 9=F, voltage < 20=F: cannot happen — no value of voltage makes …
    D2   armed=F, voltage=9 → alarm=F
  ◆ D6   armed=T, voltage=9 → alarm=F    [MC/DC: voltage > 9]
  ◆ D8   armed=T, voltage=10 → alarm=T   [MC/DC: armed, voltage > 9, voltage < 20]
    B4   armed=T, voltage=19 → alarm=T   (edge of voltage < 20)
```

- **A decision** gets every combination of its conditions, each made
  concrete — a comparison at its boundary — with the output the formula
  requires. Rows nothing can produce, or the glossary's constraints rule out,
  are marked `×` and not run. `◆` marks the MC/DC rows, where one condition
  alone changes the outcome; a condition with no such row is reported as dead
  or coupled. Boundary rows walk each comparison across its edge.
- **A FRETish requirement** gets step sequences — the trigger firing once,
  never, held, again while the first is pending, late, outside its scope —
  with checks over the response: at a step, at some, every or no step of a
  window. Responses that break the checks come with it, to test the checker.
- `--write` writes the matrix to `spec-tacular/matrix/` (it outlives the
  change), copies a dependency-free runner into the project, and writes a
  table-driven test per matrix. The one part written by hand is the
  **harness**: how to set each input in the real code and read each output.
- Each row is a test named `[req:…] [row:D7]`. Its consequence class decides
  which rows must pass for the requirement to count as verified: every row
  for P0 (or without classes), MC/DC and boundary rows for P1. A matrix whose
  formula or glossary changed is out of date, and the overview says so.

A green matrix proves nothing if the harness answers for the code, or reads
the wrong place. So a matrix's results count only once its harness is
**connected**:

- **A mapping, not code, where it can be.** `<component>.mapping.yaml` binds
  each variable to an export or a field of the production module — data,
  which cannot compute an answer:

  ```yaml
  module: src/archive/decide.ts
  inputs:
    tasks_applied: { arg: tasksApplied }
  outputs:
    archive_allowed: { call: archiveAllowed }
  ```

  Harness code is the fallback, and must import production code and never
  the matrix.
- **Inputs read back.** With a `probe`, every input is read back after each
  drive; a drive that moved another input fails the row, which would
  otherwise pass for the wrong reason.
- **`spec-tacular harness <change> --check`** runs the matrix tests with
  coverage — they must execute the code the harness names — and then with
  **mutants** of the code they ran (`&&` → `||`, a `!` dropped, `>` → `>=`,
  …), each of which some row must catch. What is mutated is every source
  file the coverage report shows executed, not only what the harness
  imports — the decision logic is usually a layer further in — and only its
  executed lines; test files and test doubles (`test-support/`, `fakes/`,
  `in-memory-…`) never, nor what `matrix.exclude` in `verification.yaml`
  lists. The budget (`matrix.mutants`, 32) is shared out over the files, and
  the check reports per file how many changes it got and how many were
  caught. Mutants run in a scratch copy; the real
  source is never written. A harness that computes the answer itself passes
  every row and catches no mutant:

  ```
  archive  NOT CONNECTED  (code: test/support/harness/archive.ts)
      - the matrix tests never execute src/archive/decide.ts
      - 3 of 3 changes to the code went unnoticed — the matrix does not reach
        that code, or the requirements allow what the change does …
  ```

  A surviving mutant is a question about the requirements as much as the
  harness: a client that always "responded" met *within 3 ticks satisfy
  response*, which is how a missing requirement shows up. It is one finding
  for the component, settled once: add the requirement, or — where the code
  is free to differ, say a CLI flag no requirement is about — allow it with
  `spec-tacular harness <change> --allow-survivors "<why>"`, recorded with
  the survivors it allowed (new ones are asked again). A matrix that caught
  none of its changes cannot be allowed: its harness does not reach the code.
- **Each matrix by its own tests.** Every item's matrix tests must themselves
  catch some mutant the others catch; one matrix with a harness that answers
  for the code does not make its neighbours *not connected*.
- **Each binding is reviewed** in the change's review queue — once the
  harness is written, the overview's next step is reviewing it; from a
  shell, `spec-tacular harness <change> --accept` — beside what its
  variable means — *tasks_applied: every task ticked or deferred · Set by:
  arg tasksApplied in src/archive/decide.ts* — and an edit sends it back.

Until all of it holds, and still holds for the harness and the code as they
are now, the requirement's evidence is *not connected* rather than passing,
and archiving waits for it.

spec-tacular reads FRETish with its own semantics, and every matrix inherits
that reading — so it is checked against **NASA FRET** itself:

- `spec-tacular fret check [<change>]` takes FRET's own finite-trace formula
  for each FRETish requirement (`fretcli formalize -l ft-fin`) and compares
  it with spec-tacular's verdict on the matrix's sequences and thousands of
  seeded random traces, naming any trace they disagree on. Set `fret.cli` in
  `verification.yaml` to the command before `formalize` (for example
  `npm run --silent --prefix ~/fret/fret-electron start-cli --`); its answers
  are cached in `spec-tacular/fret/formulas.json`, so once committed the
  check also runs where FRET is not installed.
- `spec-tacular fret export [<change>]` writes the FRETish requirements and
  the glossary — as FRET's Mode/Input/Output/Internal variables — for FRET's
  realizability checking, simulator and test generation;
  `spec-tacular fret realizability <project> <component>` runs FRET's own
  check on them.
- `spec-tacular monitor <run.jsonl> [<change>]` checks a recorded run — one
  JSON object of variable values per step, from an end-to-end test or
  production — against every formal requirement, decisions and FRETish
  alike, whose variables it records: the offline half of runtime
  verification. Requirements that could not be monitored on a running system
  (an unbounded *eventually*) are flagged.


Copy and paste work like elsewhere, within what a terminal allows:

| Key | Does |
| --- | --- |
| drag, then ctrl+c | Copies the text selected with the mouse. Without a selection ctrl+c is *back*, as everywhere — and any other key ends a selection, so a later ctrl+c is back again. |
| ctrl+v | Pastes the clipboard into the text being typed: a new change's description, a ground-rules answer, your vision, a rejection reason, a redraft's feedback, a revise prompt. |
| ctrl+shift+v, middle click | The terminal's own paste works too, several lines at once; no line of it counts as enter. One-line inputs join the lines with spaces. |
| `y` | Copies the requirement under review, or the draft being read. |

The clipboard is `wl-copy` / `wl-paste` on Wayland, `xclip` or `xsel` on X11,
`pbcopy` / `pbpaste` on macOS. Without them — or over SSH, where they would
reach the remote machine's clipboard — copying goes through the terminal
(OSC 52, which most terminals and tmux support), and pasting through the
terminal's own paste. A line in the corner says what was copied, or why not.

On an existing project, new changes start from what you want, not a name: describe it in a sentence
or two, and a name is proposed from it (instantly, then a better one from the
AI) for you to adjust. The description is what the agent drafting the
proposal starts from.

The advisor, the vision interview, change naming and revising a requirement
talk to the agent you chose with `--driver` (default `claude`), through
sessions that stay open while you answer (revising warms its session when a
review opens):

- **Claude Code** runs as `claude -p --input-format stream-json
  --output-format stream-json`, one process per kind of request (model, tools
  and JSON schema are fixed when it starts). The first message carries the
  instructions and the project so far; every later one only what changed and
  the new request. The advisor's sessions start as soon as a project that
  still needs setting up opens — on the start screen, before anything is
  answered — and are *primed*: sent their instructions and the project so far
  with a request for nothing, so the first real question is a small delta
  and one short model turn. Measured with haiku, the first request on screen
  went from 2.2 s to 1.3–1.5 s. Priming is invisible, never waits, is
  skipped with `SPECTACULAR_NO_ADVISOR`, and is never retried as a one-shot
  process. The vision interview is primed the same way, and naming warmed
  when you start describing a change. If
  a session dies or errors it is restarted with the full context; if that
  fails too, a one-shot `claude -p` answers. All of them are stopped when
  spec-tacular exits, ctrl+c and SIGTERM included.
- **opencode** runs one headless `opencode serve` (local port, own password)
  with a conversation per kind of request, using its read-only `plan` agent
  and a JSON schema per message. A reply that ignores the schema still has
  its JSON found in the text, checked, and asked for again once with what
  was wrong. Its conversations are primed the same way, and deleted again on
  exit.

Web search is used only when a request touches the stack or tooling
(versions, frameworks, package managers, datastores); everything else is
answered without tools, and told not to quote versions from memory. Extended
thinking is off for these requests — measured on one follow-up, it was most
of the time taken for no better options.

| Variable | Effect |
| --- | --- |
| `SPECTACULAR_NO_ADVISOR=1` | No AI during setup, the interview, naming or revising a requirement |
| `SPECTACULAR_ADVISOR_MODEL` | Claude model for the advisor, interview and revising (default: Claude Code's own model) |
| `SPECTACULAR_QUICK_MODEL` | Claude model for naming changes (default: Claude Code's own model) |
| `SPECTACULAR_NO_MCP=1` | Start no MCP servers (faster sessions). By default the agents load your Claude Code MCP servers and may call their tools unattended |
| `SPECTACULAR_MCP_DENY` | MCP servers the agents may not call, space or comma separated and matched by name, e.g. `godaddy google_drive` |
| `SPECTACULAR_ADVISOR_THINKING=1` | Let Claude use extended thinking again (slower) |
| `SPECTACULAR_OPENCODE_MODEL` | opencode model, `provider/model`, e.g. `openrouter/anthropic/claude-sonnet-4` (default: opencode's own) |
| `SPECTACULAR_OPENCODE_QUICK_MODEL` | opencode model for naming (default: `SPECTACULAR_OPENCODE_MODEL`) |
| `SPECTACULAR_DEBUG_LOG=/path` | Append each advisor request's session, delta/full and time — and each priming turn — to a file |

Opencode's free tier (`opencode/*-free` models) rejects any request whose tool
set was narrowed, which is why tools are not restricted per request there;
the `plan` agent keeps it from editing anything.

Agents drafting artifacts run as `claude -p` with `--permission-mode
acceptEdits` and read-only `openspec` commands allowed — headless, nobody is
there to approve a tool call, so without it every write is denied. To allow
more (running tests during `apply`), add flags with `SPECTACULAR_CLAUDE_ARGS`.

Everything the TUI does is also a command:

```bash
# Overview of every change
bun run src/cli.ts --cwd /path/to/an/openspec/project --print

# Install the schema that sequences design after specs
bun run src/cli.ts init --cwd /path/to/project

# Ask for an artifact — refused while its prerequisites are unreviewed
bun run src/cli.ts instructions design -c <change> --cwd /path/to/project

# Dispatch an agent in the background; returns immediately
bun run src/cli.ts run design -c <change> --cwd /path/to/project
bun run src/cli.ts jobs --cwd /path/to/project

# Ground rules and durable decisions
bun run src/cli.ts foundation --cwd /path/to/project
bun run src/cli.ts adr --cwd /path/to/project

# Close a change, and the work it left unverified
bun run src/cli.ts archive <change> --dry-run --cwd /path/to/project
bun run src/cli.ts pending --cwd /path/to/project
bun run src/cli.ts roadmap --cwd /path/to/project
```

Drop `--print` for the TUI; `enter` opens the review queue for the selected
change. `--print` renders the same model as text, so the overview also works
over a pipe and in CI.

## Status

**M0–M8 done** (M1 mostly; M7 has one stated gap). Every structural problem
from the original analysis is addressed. The review loop works: open a change, walk its
requirements one at a time, and accept (`a`), reject (`x`) or defer (`d`) each one from
the keyboard, or revise it with AI (`r`) or in your editor (ctrl+e). Decisions persist immediately, drift is detected when a
reviewed requirement is edited afterwards, and reopening resumes where you
stopped.

Sequencing is enforced. `spec-tacular init` installs a schema where `design`
requires `specs` (OpenSpec's own has it require only `proposal`), and
`spec-tacular instructions design -c <change>` is refused — exit 1 — while any
spec requirement is unreviewed.

Drafting agents run in the background. `spec-tacular run <artifact> -c <change>`
dispatches Claude Code or opencode and returns immediately, so you keep
reviewing while it works. `ctrl+j` pulls up the job pane mid-review without
losing your place: what each agent read, ran and wrote, and every tool call it
was refused.

The AI itself stays in view. A sidebar shows which driver and model is
answering, what it has cost, and what it is doing right now — the running step
while an agent drafts. `ctrl+b` (or the button in the sidebar) expands it into
the per-model and per-job breakdown. It is there from the start screen on —
through the setup's questions and the vision interview too — once the
terminal is wide enough (130 columns), so it never squeezes them; on a narrower
terminal `ctrl+b` still opens the details full width. Cost and tokens come
from the agents themselves — Claude reports actual USD, opencode its own cost
— so there is no price table to keep current. The total is kept in
`.spec-tacular/usage.jsonl`, so a restart does not reset it. The implementing
session runs in Claude Code itself, which reports no cost for an interactive
session: its tokens are read from its transcript and shown as *+ implementing*
— its `/cost` there says what it cost.

Premature specificity gets questioned. A requirement naming an endpoint, a
column or a class it has not earned is flagged during review, and `m` marks a
value as `{{example: ...}}` — an illustration rather than a contract. Advisory
only: it never blocks a stage.

```
 The system SHALL let a user export their data in a portable format CSV,
 exposed as POST /v1/export and persisted to the user_exports table by
 `ExportController`.

   examples, not contracts: CSV

   1. names an HTTP endpoint: POST /v1/export
   2. names a field or table: user_exports
   3. names a class or symbol: ExportController
```

Ground rules come first. `spec-tacular init` scaffolds a Foundation — domain,
stack, architecture, conventions — with every question left as `TBD` on
purpose (on a new project, those nobody can answer yet say *Decide later*
instead), and refuses to start a change until the `TBD`s are answered. Once
answered they enter every agent's context.

Architectural decisions outlive their change. Mark one `**Scope: global**` in a
design and `p` promotes it to a numbered ADR under `spec-tacular/decisions/`,
leaving a reference behind. Later changes get it as a rule:

```
$ spec-tacular adr
ADR-0001  accepted   Errors are values
```

Deployment-dependent work stops blocking a change. Defer a requirement that
needs a running environment and the change archives without it: the verified
requirements merge into `openspec/specs/`, the deferred one waits in
`spec-tacular/pending-validation.md` with what would verify it.

In the TUI, a change whose tasks are all ticked off offers **Archive it**
(`A`): it shows what archiving would do — or why it may not be archived yet —
and archives on enter.

```
$ spec-tacular archive add-export
1 requirement(s) merge into the baseline
1 divert to pending validation
  data-export: Export completes against a deployment — a deployed instance to run against

$ spec-tacular verify data-export --requirement "Export completes against a deployment"
Verified into openspec/specs/data-export/spec.md
Specification 'data-export' is valid
```

Greenfield gets sequenced. `spec-tacular/roadmap.yaml` holds the vision and an
ordered list of slices; one is being specified at a time, so the review queue
never exceeds a single change. Once a slice's proposal and specs are accepted,
the next one can be specified (`s` in the TUI) — without waiting for anything
to be built. It need not be the next in line: the slices without a change
follow the changes in the TUI's list, so ↓ (or a click) picks any of them to
read its summary and what it depends on, and `s` starts it — or it says why it
cannot yet, such as a dependency not specified. Its design, tasks and implementing wait until the slices before it
are applied, since they build on that code: applied means every task ticked
off, except those marked `(defer: …)` that need a deployment to verify. An
applied slice turns ✓ on its own.

Implementing is your agent's own session. *Implement it* opens Claude Code (or
opencode) on the change's apply instructions in a new tab — tmux, kitty,
WezTerm, GNOME Terminal, Konsole, iTerm — or, in a terminal that cannot open
tabs (an IDE's), a new window of the desktop's terminal. It is exactly as if
you had started it yourself, with two exceptions: editing the project's files
is pre-approved, and so are its test commands (from `verification.yaml`),
spec-tacular's own checks and OpenSpec's read-only commands — so what it does
ask about is worth reading: anything outside the project, installing. It is
told to write files with its edit tools, not the shell, and to use the
installed toolchain. spec-tacular stays open, shows the change being implemented, and follows
the tasks as they are ticked off. Only when no tab or window can be opened does
the agent take over spec-tacular's own terminal until it exits.

Tune the linter per project with `spec-tacular/lint.json`:

```json
{ "allow": ["tasks.md", "proposal.md", "openspec"] }
```

Verified against the largest change in the OpenSpec repo — 26 requirements,
reviewed end to end by keystroke in tests that assert on the real rendered
terminal frame.

The plan:

- [`docs/problem-analysis.md`](docs/problem-analysis.md) — each pain point traced to its
  root cause in the OpenSpec source, and what the fix has to be.
- [`docs/architecture.md`](docs/architecture.md) — stack, layering, data model, state machine.
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — milestones M0–M8 with exit criteria.
- [`docs/tui-design.md`](docs/tui-design.md) — screens, layout, keybindings.
- [`schemas/spec-tacular/schema.yaml`](schemas/spec-tacular/schema.yaml) — the custom OpenSpec
  schema that enforces the sequencing. This one is already runnable.

Start with `docs/implementation-plan.md`.

Source layout:

| Path | What |
| --- | --- |
| `src/adapter/` | The only module that knows OpenSpec exists. Reads its `--json` CLI; never writes a file OpenSpec owns. |
| `src/core/` | Pure domain logic — requirement parsing, review state, drift detection, stage derivation. Schema-agnostic and terminal-free. |
| `src/render/` | Headless text rendering, so the overview is testable and pipe-friendly. |
| `src/agent/` | Agent drivers (Claude Code, opencode). Build a command; never talk to a model directly. |
| `spec-tacular/` | What the tool writes for humans: foundation, ADRs, roadmap, pending-validation register. |
| `src/tui/` | OpenTUI + Solid screens. Deliberately thin — they draw, `core/` decides. |
