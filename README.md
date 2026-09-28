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
| `design` only requires `proposal` — both can be written at once | `design` requires **accepted** specs; strict `proposal → specs → design → tasks` |
| Review = reading N spec files in your editor | Review = one requirement at a time, `a`ccept / `r`eject / `d`efer, or revise it with AI (`e`) |
| Design decisions stay local to a change | Cross-cutting decisions are **promoted to global ADRs** |
| No project ground rules before the first change | A **Foundation** phase: stack, architecture style, conventions, ADRs |
| Greenfield = 15 changes proposed at once | A **Roadmap** layer that sequences an idea into reviewable slices |
| `apply` blocks the terminal | `apply` runs in the **background** while you keep reviewing |
| A task needing a deployed env blocks archive | That task is **deferred**; the rest of the change archives |

## Try it

```bash
bun install

# Open the TUI in any folder — an empty one is fine. It opens on a start
# screen with a Start button, then walks you through:
#   1. Set up        runs `openspec init` and installs the spec-tacular schema
#   2. Ground rules  domain first, then stack, architecture, conventions — one
#                    question at a time, most of them proposed from the domain
#   3. Vision        (new projects) describe what you are building; an AI
#                    interviews you, then splits it into a roadmap of slices
#   4. First change  the first slice — or, on an existing project, describe a change
# After that, every change shows its next step as buttons, and ? lists every key.
bun run src/cli.ts --cwd /path/to/project
```

The ground rules start with the domain — what you are building, and for
whom — because that is the one thing only you know, and most of the rest
follows from it. On a new project only what can be answered on day one is
asked; the rest is left for later:

| | Questions |
| --- | --- |
| Asked | What the system is for, and who uses it |
| Proposed from the domain (⇐, enter confirms) | the core terms · language and runtime · framework · datastore · package manager and tools · architecture style · layers and which may depend on which · where business rules live · naming · what a test must cover |
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
- **It digs in before moving on.** After each answer it looks at what the
  answer leaves open and asks that next — answer "Python" and the next
  question is which version, with the latest stable release (looked up, not
  remembered) marked ★ recommended. Enter moves on without waiting.
- **Common answers need no waiting.** A small table of presets
  (`src/core/presets.ts`) knows what "Python", "TypeScript", "Rust", "Go",
  "Postgres", "hexagonal" and friends leave open, so their follow-ups and
  options (uv / poetry / pip, pytest, FastAPI, Node / Bun / Deno, …) appear
  the instant you answer, marked ◇. The advisor refines them in the
  background — adding questions, replacing options — but never moves the
  option you have selected or touches a question you already answered.
  Presets never carry version numbers: those are always looked up.
- **It proposes.** Questions come with options for your project so far
  (uv, pytest, FastAPI, …), and answers that already follow from earlier ones
  are derived and pre-selected, marked ⇐. Nothing is written until you pick
  one or type your own.
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
to change yet. The description starts from what you told the Domain question,
so nothing is described twice: add to it or press enter. The AI restates what
it understood and asks one question at a time, with options, until it has
enough or you say "done" (Skip, the first choice, tab or "skip" pass on a
question). It then proposes 3–8
slices in build order, the first the smallest thing a user can do end to end.
Drop the ones you do not want, and the rest become `spec-tacular/roadmap.yaml`;
the vision and interview go to `spec-tacular/vision.md`, which every agent
reads. The first slice becomes your first change.

Drafts are for reading. While an agent drafts, its progress streams into the
change panel; when it lands, the draft opens: scroll through it, then
*looks good* (draft the next artifact), *edit it*, or *redraft with feedback*
— the agent revises it with what you typed. `v` reads it again later.

Requirements are reviewed one at a time: `a` accepts, `r` rejects (asking
why), `d` defers (asking what would verify it). `e` revises the requirement
with AI, in conversation: say what should change ("make the timeout
configurable", "split it into two scenarios") and the agent answers with the
revised requirement, shown as a diff against the file. Then `a` writes it
into the spec — replacing that requirement's block, every other byte of the
file left as it was — `i` asks for more changes (as many rounds as you like;
the agent sees every earlier request and proposal), and `d` discards it.
Nothing is written before `a`, and ctrl+c while the agent works leaves the
file untouched. A rejected requirement's prompt starts from why you rejected
it. A revised requirement is pending again, cursor on it, for its new text to
be accepted; the other requirements keep their decisions, a rename included.
`E` (or ctrl+e) still opens it in `$EDITOR`, and `y` copies it.

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
| `SPECTACULAR_ADVISOR_MODEL` | Claude model for the advisor, interview and revising (default `sonnet`) |
| `SPECTACULAR_QUICK_MODEL` | Claude model for naming changes (default `haiku`) |
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
requirements one at a time, and `a`ccept / `r`eject / `d`efer each one from the
keyboard, or revise it with AI (`e`) or in your editor (`E`). Decisions persist immediately, drift is detected when a
reviewed requirement is edited afterwards, and reopening resumes where you
stopped.

Sequencing is enforced. `spectacular init` installs a schema where `design`
requires `specs` (OpenSpec's own has it require only `proposal`), and
`spectacular instructions design -c <change>` is refused — exit 1 — while any
spec requirement is unreviewed.

Agents run in the background. `spectacular run <artifact> -c <change>`
dispatches Claude Code or opencode and returns immediately, so you keep
reviewing while it works. `ctrl+j` pulls up the job pane mid-review without
losing your place.

The AI itself stays in view. A sidebar shows which driver and model is
answering, what it has cost, and what it is doing right now — the running step
while an agent drafts. `ctrl+b` (or the button in the sidebar) expands it into
the per-model and per-job breakdown. It appears once the terminal is wide
enough (130 columns), so it never squeezes the review surface; on a narrower
terminal `ctrl+b` still opens the details full width. Cost and tokens come
from the agents themselves — Claude reports actual USD, opencode its own cost
— so there is no price table to keep current.

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

Ground rules come first. `spectacular init` scaffolds a Foundation — domain,
stack, architecture, conventions — with every question left as `TBD` on
purpose (on a new project, those nobody can answer yet say *Decide later*
instead), and refuses to start a change until the `TBD`s are answered. Once
answered they enter every agent's context.

Architectural decisions outlive their change. Mark one `**Scope: global**` in a
design and `p` promotes it to a numbered ADR under `spec-tacular/decisions/`,
leaving a reference behind. Later changes get it as a rule:

```
$ spectacular adr
ADR-0001  accepted   Errors are values
```

Deployment-dependent work stops blocking a change. Defer a requirement that
needs a running environment and the change archives without it: the verified
requirements merge into `openspec/specs/`, the deferred one waits in
`spec-tacular/pending-validation.md` with what would verify it.

```
$ spectacular archive add-export
1 requirement(s) merge into the baseline
1 divert to pending validation
  data-export: Export completes against a deployment — a deployed instance to run against

$ spectacular verify data-export --requirement "Export completes against a deployment"
Verified into openspec/specs/data-export/spec.md
Specification 'data-export' is valid
```

Greenfield gets sequenced. `spec-tacular/roadmap.yaml` holds the vision and an
ordered list of slices; one is active at a time, so the review queue never
exceeds a single change.

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
