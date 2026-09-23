# The Rust port

spec-tacular was written in TypeScript on Bun. It is being rewritten in Rust on
Ratatui. The TypeScript implementation stays on the `claude/vibrant-fermat-s72fcs`
branch as the reference; nothing on it is deleted until the port is at parity.

## Why

Four reasons, in the order they started to hurt.

**Startup.** `spectacular` took **2.9 s** to reach a first frame. This is a tool
you open to check where a change is and close again, dozens of times a day, and
a three-second pause turns that into something you avoid. The Rust binary
answers `--help` in **under a millisecond** and draws the TUI's first frame
**about 15 ms** after launch, at **about 4 MB** resident — it draws first and
asks OpenSpec about the project in the background, rather than making you
wait for a subprocess before anything appears.

**Size.** The TypeScript build needed **127 MB** of `node_modules`, plus a Bun
or Node runtime, present and at the right version. The Rust build is a **single
static binary of about 6 MB** — `x86_64-unknown-linux-musl`, nothing
dynamically linked. You copy it onto a machine and it runs. (It was 0.8 MB
through stage 2, before anything ran a subprocess, and about 4 MB through stage
8; the async runtime that drives OpenSpec, the background jobs and the TUI's
event loop, the TUI itself, and from stage 9 the ACP SDK, are the rest. Two
orders of magnitude is still the point.)

**Distribution.** "Install Bun, then install this" is a worse first step than
"download this file". A static binary is also what makes a release workflow
trivial: build, upload, done.

**ctrl+c.** The design requires that ctrl+c never quits — it cancels the
running job and nothing else, because losing a half-finished review to a reflex
keystroke is exactly the kind of thing that makes people stop using a tool. In
Node that fights the runtime's signal handling at every turn. With crossterm in
raw mode, ctrl+c arrives as an ordinary key event and the application decides
what it means.

## The rule the port must not break

Carried over from `docs/architecture.md`, and the reason the module layout is
what it is:

> **`core/` has no terminal code and no subprocess code. `adapter/` is the only
> module that knows OpenSpec exists.**

`core/` takes plain data in and returns plain data out. That is what lets the
review loop, the gate and the pipeline be tested without driving a terminal,
and it is why `--print` and the TUI are two renderings of one model rather than
two implementations of one feature. `adapter/` holds every fact about
OpenSpec's CLI and file layout, so replacing, versioning or stubbing OpenSpec is
a change to one directory.

A pull request that reaches for `ratatui` or `std::process` from `core/`, or
that writes to `openspec/` from outside `adapter/`, is rejected on that ground
alone.

## Module layout

```
src/
  main.rs        entry point
  cli.rs         argument parsing and dispatch (clap)
  commands.rs    what each verb prints and exits with, over core/ and adapter/
  adapter/       openspec.rs, types.rs — the only OpenSpec-aware code
  core/          the model: markdown, requirements, review, session, pipeline,
                 gate, change_review, examples, mark, concreteness, revision,
                 context, foundation, decisions, init, jobs, archive, pending,
                 verify, roadmap, guide, naming, advisor, vision
                 (advisor: the Foundation advisor whole — prompts, parsers,
                 its sidecar, follow-ups written into the files; vision: the
                 interview, its saved session, slicing and the roadmap it
                 writes; naming: the instant name and the model's. All three
                 reach a model through an injected `Ask`)
  agent/         driver.rs, claude.rs, opencode.rs, structured.rs
                 (structured: one-shot requests, and `driver_ask` — the real
                 `Ask`, in research, think or quick mode)
    acp/         the interactive agent layer (see "ACP" below):
                   mod.rs     which agent to talk to, and whether to
                              (`SPECTACULAR_AGENT_MODE`,
                              `SPECTACULAR_ACP_COMMAND`)
                   client.rs  one agent process and its session, over the
                              `agent-client-protocol` SDK
                   events.rs  `session/update` as the few things shown
                              (`AcpEvent`), permission requests, the log
                   run.rs     a session drafting one change, each turn
                              recorded as a job
  render/        text.rs, requirement.rs — shared by `--print` and the TUI
  tui/           the Ratatui shell:
                   mod.rs       the tokio event loop (keys, mouse, resize,
                                a 70 ms animation tick, a 2 s job poll)
                   app.rs       the state, and events → state + effects
                   view.rs      drawing: pure functions of `&App`
                   home.rs      the start screen; logo.rs its wordmark
                   review.rs    the review screen: one requirement or
                                decision at a time, its keys and drawing
                   document.rs  the document viewer: a drafted artifact,
                                read in full, and what to do next
                   foundation.rs the ground rules: one Foundation question
                                at a time, the advisor's options, follow-ups
                                and help, its keys and drawing
                   vision.rs    a new project's vision: described (or
                                pasted), interviewed one question at a time,
                                split into slices you review, its keys and
                                drawing
                   acp.rs       drafting over ACP: the session's state, its
                                events, the running block, the permission
                                overlay, cancel, the same-session redraft
                   jobs.rs      the job pane; guide.rs the help and empty states
                   ports.rs     the `Ports` trait (the TypeScript `TuiInput`)
                                and its real implementation, with the advisor,
                                the interviewer and name proposals over the
                                chosen driver (the TypeScript `advisorFor` and
                                `visionFor`)
                   terminal.rs  raw mode, alternate screen, mouse — and always
                                restoring them (Drop guard, panic hook)
                   editor.rs    `$VISUAL`/`$EDITOR`/nano/vim/vi at a line
                   widgets.rs, theme.rs, input.rs
                   fake.rs      an in-memory `Ports` (real files for the
                                specs, the sidecar and the Foundation)
                   tests/       the end-to-end tests that drive the app by
                                keystroke: the harness, then one file per
                                TypeScript suite, and acp.rs against the
                                scripted ACP agent
tests/
  cli.rs         the binary, end to end
  support/       fake_acp_agent.rs — a scripted ACP agent (a second binary,
                 `fake-acp-agent`, built with the tests; never shipped in
                 use, never costs anything)
```

The TUI is the Elm shape Ratatui suits. `App` holds what the TypeScript's
Solid signals held; a key, a click, a tick or a message goes in, the state
changes, and what comes out is a list of `Effect`s — work to spawn on the
runtime (an OpenSpec call, a dispatch), or the editor to run. The loop spawns
them and feeds their results back as messages. Drawing is a pure function of
`&App` that also reports where each clickable thing landed, which is all a
mouse click needs. Even file reads stay off the drawing thread: the job list
and log tails the 2 s poll wants are read by `Ports::read_jobs` on a blocking
thread and arrive as a message, like any other result. Nothing in `app.rs` waits, draws or touches a terminal, so
the tests drive the whole interface against a fake `Ports` and assert on a
`TestBackend` frame.

It mirrors the TypeScript tree one-for-one, deliberately: while both exist,
being able to open the same filename in each is worth more than a tidier
arrangement.

## The stages

The port lands as a stack of pull requests, each branched from the last, each
reviewable on its own.

| # | Branch | Contents |
| --- | --- | --- |
| 1 | `rust/01-skeleton` | Cargo project, CLI parsing, docs, `--help` |
| 2 | `rust/02-core` | markdown/requirement parsing, review state and drift, session, revision bundle, pipeline, gate, concreteness linter, foundation, decisions/ADRs, requirement rendering |
| 3 | `rust/03-adapter-commands` | OpenSpec adapter, context bundle, init, `--print` overview, `instructions`/`foundation`/`adr` |
| 4 | `rust/04-jobs-agents` | background jobs, agent drivers (claude/opencode), `archive`/`pending`/`verify`/`roadmap` |
| 5 | `rust/05-tui-shell` | TUI shell: event loop, theme, widgets, start screen, overview, help, jobs pane, describe-then-name new change, `$EDITOR` (ctrl+c never quits) |
| 6 | `rust/06-review-document` | TUI review screen, document viewer, editor integration |
| 7 | `rust/07-guided-setup` | guided setup: the ground-rules screen (intro, one question at a time, options, follow-ups, help, derived answers, done), Start → ground rules → overview routing, `core::advisor` complete behind an injected model |
| 8 | `rust/08-ai-advisor-vision` | AI advisor: the real ports reach a model (structured requests in research/think/quick mode, `SPECTACULAR_NO_ADVISOR`), follow-ups/options/derived answers/help live, name proposals, the vision screen (describe or paste, interview, slices review, roadmap and first change), Start → ground rules → vision routing |
| 9 | `rust/09-acp` | ACP agent integration: `w` and the redraft talk to the agent over ACP (`agent::acp`, `tui::acp`) — its reply, tool calls and diffs streamed into the running block, permission requests answered in an overlay, `x` cancelling through `session/cancel`, a redraft continuing the same session, every turn recorded as a job; detached jobs kept for `spectacular run` and as the fall-back |
| 10 | `rust/10-release` | CI workflow, release build, README |

### The stacked-PR workflow

Each stage branches from the previous stage's branch, not from `main`:

```sh
git checkout rust/01-skeleton
git checkout -b rust/02-core
# … work …
gh pr create --base rust/01-skeleton
```

Only stage 1 targets `main`. Every later PR targets the branch below it, so its
diff shows that stage's work and nothing else. When a stage merges, GitHub
retargets the PR above it automatically. If a stage is revised after review,
rebase the stages above it (`git rebase --onto`) rather than merging downward,
so the stack stays a stack.

Stages are not merged as they are approved; the whole stack merges bottom-up
once it is green, so `main` never carries a half-ported binary.

## Building

Normally:

```sh
cargo build
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo build --release
```

Every dependency is pure Rust. Nothing in the tree compiles C, and nothing may
be added that does — partly to keep cross-compilation free, partly because of
the next section.

### Building without a C toolchain

`.cargo/config.toml` targets `x86_64-unknown-linux-musl` by default, linked
with rustc's bundled `rust-lld` and a self-contained sysroot:

```toml
[build]
target = "x86_64-unknown-linux-musl"

[target.x86_64-unknown-linux-musl]
linker = "rust-lld"
rustflags = ["-C", "target-feature=+crt-static", "-C", "link-self-contained=yes"]
```

That needs `rustup target add x86_64-unknown-linux-musl` and nothing from the
system — no `cc`, no `ld`, no libc headers — and it is also what produces the
static release binary. If you do have a C toolchain, `cargo build --target
x86_64-unknown-linux-gnu` still works; nothing in the source depends on either.

There is one gap it cannot close. Build scripts and proc-macro crates (the
`clap`, `serde`, `thiserror` and `tokio` derives) are compiled for the *host*
triple, and cargo offers no way to redirect that — on a host with no `cc` they
fail to link before any of this project's code is reached. For that case:

```sh
. scripts/no-cc.sh   # source it, then run cargo normally
cargo test
```

`scripts/no-cc.sh` writes a small `rust-lld` wrapper into `target/no-cc/` that
supplies what a `cc` driver would have supplied for the host — glibc's crt
objects, the library search paths, the dynamic loader — and points the host
target's linker at it. It is a no-op when `cc` exists, and it touches nothing
outside `target/`. Installing a real toolchain (`build-essential` on Debian and
Ubuntu) is better in every way; the script is there so a missing compiler is
not a blocker.

## Deliberate differences from the TypeScript version

The port is meant to be a faithful one — the help text, the exit codes and the
messages are reproduced rather than reinvented. These places knowingly differ.

**Flags are scoped to the subcommand they belong to.** The TypeScript parser
scanned the whole command line into one flat struct, so every flag was accepted
everywhere and quietly ignored where it meant nothing: `spectacular pending
--cancel` ran `pending` as though the flag were not there, and a `--requirement`
typed on the wrong command vanished. clap scopes `--job`/`--cancel` to `jobs`,
`--requirement` to `verify`, `--promote`/`--done` to `roadmap` and `--dry-run`
to `archive`, so using one elsewhere is a usage error and exits 2. A flag that
silently does nothing is a flag you believe worked; being told is better than
being ignored, and this is the moment to fix it rather than reproduce it.
`tests/cli.rs` has a regression test pinning the behaviour. The genuinely
global options — `-p`, `-c`, `--cwd`, `--openspec-bin`, `--driver`, `-f` — stay
accepted before or after a subcommand, as they were.

**The schema is compiled into the binary.** The TypeScript `initProject` copied
`schemas/spec-tacular/` out of the installed package at runtime, which a single
downloaded file cannot do. `core::init::BUNDLED_SCHEMA` holds each of the five
files through `include_str!`, so what `spectacular init` writes is what the
repository ships — pinned byte for byte by a test — and the binary still needs
nothing beside it. `bundled_schema_dir()` survives as the answer to "which
files does that mirror", for that test alone.

**A failed install says what failed.** The TypeScript `runInit` let an I/O error
propagate out of `main`, which printed a stack trace. Here it prints the error
and exits 1: a tool that could not write a file should say which one, not paste
its own internals over the terminal.

**`adr` takes no arguments.** It lists; promotion is a review action you reach
by pressing `p` on a decision in the TUI, which is where you are when you
discover a decision is architectural. That matches the TypeScript `runAdrs`.

**There is a `-V`/`--version`.** The TypeScript had none: you found out which
build you were running by looking at `package.json` next to it, which a single
downloaded binary does not have. `spectacular --version` prints the crate
version and exits 0.

**A finished job is reaped by whoever is still watching it.** The TypeScript
spawned detached and let Node's runtime collect the child through `SIGCHLD`.
Rust has no such runtime, and an unwaited child of a live process stays a
zombie — whose pid still answers `kill(pid, 0)`, so `list_jobs` would report a
job as `running` forever and the TUI would never see one finish. `start_job`
therefore waits on the child from a thread and records the outcome, exactly as
the TypeScript's `child.on('exit')` did. Nothing about detachment changes:
`spectacular run` still exits immediately, the agent still has its own session
through `setsid`, and the `.exit` file the wrapper writes is still how an
outcome is recovered when no spec-tacular process is left to see it.

**`q` asks once while an ACP turn is running.** Everywhere else `q` quits
the start screen and the overview without asking, because jobs outlive the
TUI. An ACP session does not: quitting ends it. With a turn running, the
first `q` says so ("… q again quits and cancels it") and only a second `q`
quits; any other key keeps the session.

**ctrl+c never quits.** The TypeScript TUI quit on ctrl+c from the start
screen and the overview, and cancelled one level everywhere else. Here it only
ever cancels or goes back one level — the new-change prompt, the help, the job
pane, a pending "cancel this job?" — and where there is no level left, on the
start screen and the overview, it says that `q` quits. `q` quits from those two
without asking: jobs run detached and outlive the TUI, so there is nothing to
confirm. A reflex keystroke should never be the thing that ends a session;
that is the whole design (docs/tui-design.md), and with crossterm in raw mode
it is a key like any other rather than a signal. SIGTERM and SIGHUP — the
terminal window closing — quit cleanly, terminal restored.

**ctrl+j opens the job pane from anywhere**, the start screen and the ground
rules included; the TypeScript only listened for it on the overview. The pane also takes `p`,
which clears finished jobs (`core::jobs::prune_jobs`, which stage 4 ported for
it).

**The first frame does not wait for OpenSpec.** The TypeScript awaited
`loadPipelines` before mounting the app, so the first frame arrived after an
`openspec status` subprocess. Here the start screen draws at once with
"Reading the project…" where its buttons go, and they appear when the answer
does; `q` works meanwhile.

**The model's work stays off the drawing thread, and dies with the TUI.**
The TypeScript ran the advisor's and the interview's file reads and writes
inline around each model call. Here each request's whole future — read the
questions, ask, write the sidecar or the Foundation file — is driven on a
blocking thread, and the model request itself is spawned back onto the
runtime (`agent::structured::driver_ask`). A request abandoned by quitting
is cancelled with the runtime, and it kills the agent's whole process group,
not only the direct child: quitting mid-question returns at once and leaves
nothing running.

**No model, no pretend call.** The TypeScript `visionFor` started the
interview anyway when there was no model, caught the failure, and then saved
the vision. Here, without a model, the description is kept as the vision
(`VisionInterviewer::keep_without_interview`: `vision.md`, an empty roadmap,
and the session marked as not a new project) without asking anything, and
the app goes on to describing a single change, as the TypeScript did.

**A late name proposal is checked against the description it was for.**
The TypeScript dropped a proposal only when the prompt was no longer on its
name step; a prompt cancelled and started again for another change would
take the first one's names. Each proposal carries a request number, and one
for an earlier description is dropped. The same guard covers every step of
the vision interview.

**The interview does not slice behind your back.** The TypeScript went on to
split the vision into slices as soon as an answer that ended the interview
came back, wherever you were. Here that happens only if you are still on the
vision screen; otherwise the screen says "Press enter to ask again" when you
return, and enter slices it then. Writing the roadmap and creating the first
change show a spinner, where the TypeScript showed nothing and took a second
enter as a second roadmap.

**Pastes are pastes.** Bracketed paste is switched on with the terminal, so a
pasted vision arrives as one event, line breaks and all, rather than as
keystrokes whose newlines would each press enter. Only the vision's text
boxes take a paste, as in the TypeScript.

**The logo is coloured per letter.** The TypeScript passed the gradient to
opentui's `ascii_font` meaning one colour per letter, but opentui applies a
colour array to a font's *tones* — the block face's fill and shadow — so what
it drew was two-tone. The glyphs are the same `block` and `tiny` shapes; the
gradient drifts across the letters as the code intended.

**The start screen has a line for notices.** The TypeScript start screen
showed only an error under its buttons; the ctrl+c hint needs somewhere to
appear there too, so a notice gets its own line in the same place. Everything
else on that screen is placed as the TypeScript placed it, down to Yoga's
rounding — a text line's edge floored, any other box's rounded half up.

**The review shows its notices.** The TypeScript drew the notice line only in
the overview's key bar, which the review screen replaces, so "promoted to
ADR-0001", a refused mark ("the file changed since it was read") or a failed
editor were set and never seen until you left the review. Here the review
draws the notice above its progress bar, and the document viewer in its key
bar.

**Reading the queue is not done on the drawing thread.** `Ports::open_review`,
`reparse`, `mark_example`, `promote` and `read_artifact` are futures whose
real implementations read and write on a blocking thread, as `read_jobs` does;
the TypeScript called them inline. A queue that arrives after you have left
the overview does not pull you into it, and a fresh draft opens by itself only
if you are still idle on the overview when it has been read — the TypeScript's
condition, checked again when the file arrives. `save_session` alone stays
synchronous: every decision is written before the next key is read, in order,
which is what makes a crash mid-review lose nothing.

**A stale answer never replaces a fresher one.** Reloads, re-parses of the
review queue and document reads each carry a request number, and an answer
older than the newest request of its kind is dropped — what it carried
besides its data (a notice, a selection, a finished job) is handed on rather
than lost. Without it, a reload started while a review was open could land
after the one leaving the review asked for and show the specs as unreviewed
again: `w` then said there was nothing to draft.

**Reasons are typed with the shared line editor.** The reject and defer
prompts, and the redraft feedback, take `ctrl+u` and `ctrl+w` like the
new-change prompt. The TypeScript review prompts knew only backspace.

**A page is what was drawn.** The TypeScript document viewer guessed its text
height from the terminal's (13 or 16 rows less, for the chrome); here the
viewer records where its text was drawn last frame, and `space`, `G` and the
scroll percentage use that — so a page is exactly a page at any size. Lines
are still wrapped where the TypeScript wrapped them, at the terminal's width
less 8 (never under 30).

**Buttons are measured in cells.** "📄 Read the proposal" has an emoji two
cells wide; a button's width counts display cells, not characters, so its
border closes where it should.

**`v` is in the help.** The overview's help lists `v`, reading the latest
draft; the TypeScript bound the key but never mentioned it.

**The review end to end runs everywhere.** The TypeScript `review-e2e` read a
checkout of OpenSpec at a fixed path and skipped when it was absent — which it
was on every machine but one. Its 26-requirement change is copied into
`tests/fixtures/simplify-skill-installation/`, with OpenSpec's MIT licence
beside it, so the test always runs.

**The ground rules read off the drawing thread, and write on it.** The
questions and the advisor's memory are re-read by `Ports::questions` and
`Ports::advisor_meta` on a blocking thread after every answer and every piece
of advice, and a re-read older than the newest one asked for is dropped. An
answer is written synchronously, as a review decision is: it is a decision,
it must be on disk before the next key is read, and a refusal — the section
was renamed in the file — has to leave you on the question with your answer
still typed, which a write that finished later could not. What the screen was
waiting on when advice or help comes back (the follow-up to go to, the
simpler question to ask first) is kept in its state and acted on when the
re-read that includes those questions lands, so it is never acted on against
a list that does not have them yet.

**The ground rules keep their button in a short terminal.** The intro and the
done panel are centred as the TypeScript centred them; where the terminal is
too short for all of the text, the text is cut and "▶ Begin" or "▶ Continue"
stays, rather than the other way round.

**The advisor's memory is the TypeScript's file.** `.spec-tacular/foundation-advice.json`
is read and written with the same camelCase keys and absent fields left out,
so a project opened by either keeps what the advisor proposed. Keys come out in
a fixed order rather than the order the TypeScript happened to set them in.

**Button rows wrap.** A row of buttons too wide for its panel continues on the
next line instead of being squeezed, as a flex row that is allowed to wrap
would.

**A reference bug the port does not reproduce: "AI is off" on the vision
screen.** The TypeScript passed `unavailable={vision?.unavailable ?? 'no
vision support'}` to the vision screen (`src/tui/app.tsx:970` on
`claude/vibrant-fermat-s72fcs`). `unavailable` is `null` exactly when there
is a model, and `??` turns that `null` into the truthy string, so the
describe panel always read "(AI is off: no vision support — your description
is saved as the vision.)" — even when the interview then ran normally. Here
the panel says "✦ Then an AI asks a few questions to sharpen it…" when there
is a model, and "AI is off: <why>" only when there is none.

**A long vision is one line in `roadmap.yaml`.** The file is written in the
TypeScript's layout, key for key, and a roadmap from either implementation
loads in the other. The bytes differ in one case: when the `vision:` scalar
is longer than 80 columns, the TypeScript's `yaml` package folds it over
several lines and `core::roadmap::save_roadmap` does not. Both are the same
YAML value, so this only shows in a diff of the file.

## ACP

Stage 9 makes the Agent Client Protocol the TUI's interactive agent layer.
A job hands an agent a prompt and reads its output back from a file:
one-way, headless, pre-approved. An ACP session is a conversation over the
agent's stdio: its reply streams as it is written, its tool calls arrive as
structured events with the diffs they make, it asks before it writes and a
person answers, and the session stays open, so a redraft is a follow-up in
the same conversation rather than a stranger starting over.

**Which agent.** `opencode` speaks ACP itself (`opencode acp`). Claude Code
needs its adapter: `claude-agent-acp` when it is on `PATH`, else `npx
--no-install @agentclientprotocol/claude-agent-acp` — `--no-install`, so the
TUI never downloads a package behind your back. `SPECTACULAR_ACP_COMMAND`
replaces either with any command line. `SPECTACULAR_AGENT_MODE=jobs` turns
ACP off. Otherwise ACP is used whenever the command resolves; when it does
not, drafting goes to a detached job and the notice says why
(`… (as a background job: `claude-agent-acp` is not installed)`). An agent
that is found but will not start or open a session falls back the same way,
for that draft.

**The client** (`agent::acp::client`) spawns the command in the project, in
a process group of its own, and speaks JSON-RPC over its pipes through the
`agent-client-protocol` crate (pure Rust): `initialize` (no file-system or
terminal capabilities are advertised — both Claude's adapter and opencode
read and write with their own tools, restricted by their own permission
checks, so the client needs neither), `session/new` in the project
directory, then `session/prompt` per turn. The connection runs on a task of
its own; a prompt returns at once and its end arrives as an event, so cancels
and permission answers get through while a turn runs. `session/update` is
mapped to a small `AcpEvent`: reply and reasoning chunks, tool calls (title,
kind, status, diffs as `+added −removed` line counts, locations), the plan,
the session's cost when the agent reports it (`usage_update`), and the stop
reason. `session/request_permission` is parked with its responder and
surfaced with the agent's own options, normalised to allow once, allow
always, deny, deny always — so `1` is always "allow once". `session/cancel`
answers any open request as cancelled, as the protocol requires. Unknown
notifications (Claude's adapter sends `_auth/status_update`) are ignored.
Dropping the last handle, closing the session, or the runtime going away
kills the agent's whole group (`core::jobs::signal_group`): `npx …` is a tree
of processes, and killing only the direct child leaves the rest running.

**Recorded as jobs** (`agent::acp::run`). Every turn — the first draft and
each redraft on the same session — is a job record under
`.spec-tacular/jobs/` with driver `acp`, the agent's pid, `running` until the
turn ends and then `succeeded`, `cancelled` or `failed`, and a log of the
rendered events (the reply's lines, a line per tool call when its title,
state or diff changes, the plan, each permission asked and how it was
answered, the session's cost, how it ended). So `ctrl+j` and `spectacular
jobs` list them, and the one-writer-per-change rule holds across both kinds:
an ACP draft is refused while a detached job writes to the change, and the
other way round. The log is written by a thread of its own; the TUI never
waits on a file for it.

**In the TUI** (`tui::acp`). "✦ Let an agent draft it" (`w`) and "↻ Redraft
with feedback" open a session and the change's running block shows it
live: the last six lines of the reply (or "thinking…"), the plan's current
step, the last five tool calls with a status glyph (`○` pending, `◐`
running, `✓` done, `✗` failed) and their diffs (`± proposal.md +42 −0`), the
elapsed time and the cost. A permission request is an overlay — "Claude Code
wants to write openspec/changes/…/proposal.md — 1 allow once · 2 allow
always · 3 deny", its options clickable — that blocks only that decision:
the rest of the UI carries on, and the number keys answer it everywhere a
number is not text being typed (while you type, the overlay moves to the top
and says to click or answer from the overview). `x`, "Cancel  x", or the job
pane's `x` then `y` on the session's turn send `session/cancel`; the session
outlives a cancelled turn. When the turn ends the overview is re-read and the
draft opens, as a job's does. The redraft is the next prompt on the live
session — only the feedback (`commands::feedback_prompt`), since the agent
already has the context and wrote the draft — or, when the agent is gone, a
new session with the full prompt and the feedback block. Drafting the next
artifact ("✓ Looks good — draft the specs") starts a fresh session: a new
artifact is a new task, with the context it needs composed for it.

**What stays on jobs.** `spectacular run` always dispatches a detached job,
because a job outlives the process that started it and an ACP session, being
a conversation with the TUI, does not. Quitting the TUI ends a live session
(its turn is recorded as `cancelled`); with a turn running, the first `q` says
so and a second quits. The running block says it too: detached jobs are the
way to keep work going after you quit. `SPECTACULAR_AGENT_MODE=jobs` gives
the TUI the stage-8 behaviour, and the fall-backs above use it.

## Environment

| Variable | Effect |
| --- | --- |
| `SPECTACULAR_NO_ADVISOR` | Any non-empty value turns every model request off: no advisor on the ground rules, no vision interview (the description is kept as the vision), no name proposals. The screens say "turned off by SPECTACULAR_NO_ADVISOR". |
| `SPECTACULAR_ADVISOR_MODEL` | The model for the advisor (research) and the vision interview (think) with the claude driver. Default `sonnet`. |
| `SPECTACULAR_QUICK_MODEL` | The model for name proposals (quick). Default `haiku`. |
| `SPECTACULAR_CLAUDE_ARGS` | Extra arguments for the claude driver's jobs. |
| `SPECTACULAR_AGENT_MODE` | `acp` (the default) or `jobs`: how the TUI's `w` and redraft reach an agent. With `acp`, ACP is used when its command resolves, else a detached job with a notice saying why. `spectacular run` always uses a job. |
| `SPECTACULAR_ACP_COMMAND` | The ACP agent's command line, split on whitespace, instead of the driver's default (`opencode acp`; `claude-agent-acp`, else `npx --no-install @agentclientprotocol/claude-agent-acp`). |

Without the variable, the advisor is on when the chosen driver (`--driver`,
default `claude`) answers structured requests and its binary is on `PATH`;
otherwise the screens say why (`opencode cannot answer structured requests`,
`` `claude` is not installed ``).

## What is not being ported

The TypeScript tests are not translated mechanically. Each stage brings its own
Rust tests for the behaviour it lands, written against the same cases the
TypeScript suite covers, because a test suite ported without being re-read
tends to encode the old implementation rather than the requirement.

One suite is the exception, and it is generated rather than written:
`core/compat.rs` pins the requirement ids, the scenario splits, the `sha256:`
hashes and the review sidecar's bytes against values produced by *running* the
TypeScript implementation over `tests/fixtures/`. Agreeing about what a
requirement is and what its hash is are correctness requirements — a hash that
differs by one byte marks every requirement in a project as changed since it
was accepted — so those expectations are taken from the reference rather than
restated by hand. When one of them fails, the Rust side is wrong.
