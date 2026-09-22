# The Rust port

spec-tacular was written in TypeScript on Bun. It is being rewritten in Rust on
Ratatui. The TypeScript implementation stays on the `claude/vibrant-fermat-s72fcs`
branch as the reference; nothing on it is deleted until the port is at parity.

## Why

Four reasons, in the order they started to hurt.

**Startup.** `spectacular` took **2.9 s** to reach a first frame. This is a tool
you open to check where a change is and close again, dozens of times a day, and
a three-second pause turns that into something you avoid. The Rust binary
answers `--help` in **under a millisecond** and opens the TUI as fast as the
terminal can clear.

**Size.** The TypeScript build needed **127 MB** of `node_modules`, plus a Bun
or Node runtime, present and at the right version. The Rust build is a **single
static binary under 3 MB** — `x86_64-unknown-linux-musl`, stripped, nothing
dynamically linked. You copy it onto a machine and it runs. (It was 0.8 MB
through stage 2, before anything ran a subprocess; the async runtime that drives
OpenSpec, and will drive the background jobs and the TUI's event loop, is the
rest. Two orders of magnitude is still the point.)

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
  tui/           the Ratatui shell
```

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
| 4 | `rust/04-jobs` | background jobs, agent drivers (claude/opencode), `archive`/`pending`/`verify`/`roadmap` |
| 5 | `rust/05-tui` | TUI shell: event loop, theme, widgets, start screen, overview, help, jobs pane (ctrl+c never quits) |
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
messages are reproduced rather than reinvented. Four places knowingly differ.

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
