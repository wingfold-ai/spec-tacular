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
static binary of about 4 MB** — `x86_64-unknown-linux-musl`, stripped, nothing
dynamically linked. You copy it onto a machine and it runs. (It was 0.8 MB
through stage 2, before anything ran a subprocess; the async runtime that drives
OpenSpec, the background jobs and the TUI's event loop, and the TUI itself, are
the rest. Two orders of magnitude is still the point.)

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
  agent/         driver.rs, claude.rs, opencode.rs, structured.rs
  render/        text.rs, requirement.rs — shared by `--print` and the TUI
  tui/           the Ratatui shell:
                   mod.rs       the tokio event loop (keys, mouse, resize,
                                a 70 ms animation tick, a 2 s job poll)
                   app.rs       the state, and events → state + effects
                   view.rs      drawing: pure functions of `&App`
                   home.rs      the start screen; logo.rs its wordmark
                   jobs.rs      the job pane; guide.rs the help and empty states
                   ports.rs     the `Ports` trait (the TypeScript `TuiInput`)
                                and its real implementation
                   terminal.rs  raw mode, alternate screen, mouse — and always
                                restoring them (Drop guard, panic hook)
                   editor.rs    `$VISUAL`/`$EDITOR`/nano/vim/vi at a line
                   widgets.rs, theme.rs, input.rs
                   fake.rs, tests.rs   an in-memory `Ports` and the end-to-end
                                tests that drive the app by keystroke
```

The TUI is the Elm shape Ratatui suits. `App` holds what the TypeScript's
Solid signals held; a key, a click, a tick or a message goes in, the state
changes, and what comes out is a list of `Effect`s — work to spawn on the
runtime (an OpenSpec call, a dispatch), or the editor to run. The loop spawns
them and feeds their results back as messages. Drawing is a pure function of
`&App` that also reports where each clickable thing landed, which is all a
mouse click needs. Nothing in `app.rs` waits, draws or touches a terminal, so
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
| 6 | `rust/06-review` | TUI review screen, document viewer, editor integration |
| 7 | `rust/07-setup` | guided setup: project stages, ground-rules screen, describe-then-name new change |
| 8 | `rust/08-advisor` | AI advisor: structured requests, follow-ups/options/derived answers/help, name proposals, vision interview and slicing, draft opens when done, redraft with feedback |
| 9 | `rust/09-acp` | ACP agent integration: permission prompts in the UI, live tool/diff events, session resume |
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

**ctrl+j opens the job pane from anywhere**, the start screen included; the
TypeScript only listened for it on the overview. The pane also takes `p`,
which clears finished jobs (`core::jobs::prune_jobs`, which stage 4 ported for
it).

**The first frame does not wait for OpenSpec.** The TypeScript awaited
`loadPipelines` before mounting the app, so the first frame arrived after an
`openspec status` subprocess. Here the start screen draws at once with
"Reading the project…" where its buttons go, and they appear when the answer
does; `q` works meanwhile.

**Stand-ins until the screens they need land.** Stage 5 ships the shell, not
every screen, and says so rather than pretending:

- *The ground rules* (stage 7): Start sets the folder up and opens the
  overview, whose banner counts the answered questions; `f`, "Ground rules"
  and "Continue ground rules" open the next unanswered question in `$EDITOR`
  at its line — the same file the ground-rules screen will edit.
- *The vision interview* (stage 8): a new project at the vision step is
  offered "Start your first change" instead of "Describe your vision", and the
  overview shows the first-change guide.
- *The review screen and the document viewer* (stage 6): `r` on a change with
  specs says the review arrives in stage 6; `v` and "Read the …" are absent,
  exactly as they were in the TypeScript when no `readArtifact` was wired; and
  the running-agent block says you will be told when the draft is done rather
  than that it opens for you.
- *Name proposals from a model* (stage 8): the name is the instant one from
  the description's own words; `Ports::propose_names` is the hook, and the
  prompt already shows suggestions, tab-cycles them and never overwrites a
  name being edited.

**The logo is coloured per letter.** The TypeScript passed the gradient to
opentui's `ascii_font` meaning one colour per letter, but opentui applies a
colour array to a font's *tones* — the block face's fill and shadow — so what
it drew was two-tone. The glyphs are the same `block` and `tiny` shapes; the
gradient drifts across the letters as the code intended.

**Button rows wrap.** A row of buttons too wide for its panel continues on the
next line instead of being squeezed, as a flex row that is allowed to wrap
would.

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
