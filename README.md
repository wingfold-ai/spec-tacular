# spec-tacular

A terminal UI for spec-driven development, built on
[OpenSpec](https://github.com/Fission-AI/OpenSpec). An agent drafts each
artifact of a change — proposal, specs, design, tasks — and you review every
requirement before anything is built: accept, reject with a reason, defer with
what would verify it. Ground rules are settled before the first change, drift
after acceptance is flagged, and nothing is archived that nobody agreed to.

One static binary, written in Rust with [Ratatui](https://ratatui.rs).

## Install

Download a release for your platform (Linux x86_64/aarch64 static musl,
macOS x86_64/Apple silicon), check it, and put `spectacular` on your `PATH`:

```sh
VERSION=v0.1.0 TARGET=x86_64-unknown-linux-musl
curl -LO https://github.com/mhoegger/spec-tacular/releases/download/$VERSION/spectacular-$VERSION-$TARGET.tar.gz
curl -LO https://github.com/mhoegger/spec-tacular/releases/download/$VERSION/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
tar xzf spectacular-$VERSION-$TARGET.tar.gz
install spectacular-$VERSION-$TARGET/spectacular ~/.local/bin/
```

Or build it (Rust 1.88 or later):

```sh
rustup target add x86_64-unknown-linux-musl   # the default target, see .cargo/config.toml
cargo install --path . --bin spectacular   # not the test-only fake-acp-agent
```

### Requirements

- **OpenSpec CLI** — `npm install -g @fission-ai/openspec` (tested with 1.13).
- **An agent**, optional: [Claude Code](https://claude.com/claude-code)
  (`claude`, the default driver) or [opencode](https://opencode.ai)
  (`--driver opencode`). Without one you write the artifacts yourself; the
  review works the same.
- **For drafting in the TUI with Claude**: its ACP adapter,
  `npm install -g @agentclientprotocol/claude-agent-acp`. opencode speaks ACP
  itself. Without the adapter, drafts run as background jobs instead.

## A quick tour

```sh
cd my-project && openspec init   # once, if it is not an OpenSpec project yet
spectacular init                 # install the spec-tacular schema and the Foundation
spectacular                      # the TUI
```

1. **Start screen** — open the project, start a new change, or go to the
   ground rules.
2. **Ground rules** — the Foundation's questions (stack, domain, architecture,
   conventions), one at a time, with an AI advisor proposing options and
   follow-ups. No change can be created until they are settled.
3. **Vision or first change** — on a new project, describe what you are
   building; the advisor interviews you and splits it into slices on a
   roadmap, and the first slice becomes a change. On an existing one, describe
   a single change and pick a name.
4. **Drafts** — `w` lets an agent draft the next artifact. Its reply, tool
   calls and diffs stream in, it asks before it writes, and the draft opens for
   you to read when it is done: looks good, edit it, or redraft with feedback
   in the same session.
5. **Review** — `r` walks the specs one requirement at a time: `a` accept,
   `r` reject, `d` defer, `e` edit in `$EDITOR`. Design needs accepted specs.
6. **Archive** — `spectacular archive <change>` merges the accepted
   requirements into the baseline and diverts deferred ones to the pending
   register (`spectacular pending`, `spectacular verify`).

```
                           █▀▀ █▀█ █▀▀ █▀▀ ▄▄ ▀█▀ ▄▀█ █▀▀ █ █ █   ▄▀█ █▀█
                           ▄▄█ █▀▀ ██▄ █▄▄     █  █▀█ █▄▄ █▄█ █▄▄ █▀█ █▀▄

              spec-driven development — every requirement reviewed before it is built

                                              1 change

                 ╭──────────────────╮ ╭──────────────╮ ╭────────────────╮ ╭────────╮
                 │  ▶ Open project  │ │  New change  │ │  Ground rules  │ │  Quit  │
                 ╰──────────────────╯ ╰──────────────╯ ╰────────────────╯ ╰────────╯

                                             ~/todo-app
                           ←/→ choose · enter select · q quit · or click
```

An agent drafting a proposal and asking to write it (here the scripted test
agent, `fake-acp-agent`, standing in for Claude Code; middle rows trimmed):

```
 spec-tacular  ~/todo-app                                                           jobs: 1 running
╭─ Changes · 1 ──────────────────╮╭─ add-due-dates ────────────────────────────────────────────────╮
│ ▸ add-due-dates            0/4 ││                                                                │
│                                ││ ◉ proposal ── ○ specs ── ○ design ── ○ tasks ── ○ apply        │
│                                ││                                                                │
│                                ││ ⠹ fake-acp-agent is drafting the proposal · 2s · $0.01 · waiti │
│                                ││                                                                │
│                                ││ │ Reading the ground rules.                                    │
│                                ││ │ Drafting the proposal.                                       │
│                                ││ │ plan 2/2 · Write openspec/changes/add-due-dates/proposal.md  │
│                                ││ │ ○ Write openspec/changes/add-due-dates/proposal.md           │
│                                ││ │   ± proposal.md +9 −0                                        │
│                                ││                                                                │
│ ╭ ✦ fake-acp-agent asks ───────────────────────────────────────────────────────────────────────╮ │
│ │ fake-acp-agent wants to write openspec/changes/add-due-dates/proposal.md                     │ │
│ │ 1 allow once · 2 allow always · 3 deny                                                       │ │
│ │ ╭────────────────╮ ╭──────────────────╮ ╭──────────╮                                         │ │
│ │ │  1 allow once  │ │  2 allow always  │ │  3 deny  │                                         │ │
│ │ ╰────────────────╯ ╰──────────────────╯ ╰──────────╯                                         │ │
╰─╰──────────────────────────────────────────────────────────────────────────────────────────────╯─╯
 fake-acp-agent is drafting the proposal — it opens for you when done
  ←→  action   enter  go   x  cancel   n  new change   f  ground rules   ctrl+j  jobs   ?  help   q
```

## Keys

| Key | Action |
| --- | --- |
| `enter`, `←`/`→`, click | press the selected button; everything on screen is clickable |
| `w` / `e` / `v` | let an agent draft the next artifact · write it yourself in `$EDITOR` · read the latest draft |
| `r`, then `a` `r` `d` `s` `e` | review · accept, reject, defer, skip, edit the requirement |
| `n` / `f` | new change · the ground rules |
| `1` `2` `3` | answer an agent's permission request: allow once, allow always, deny |
| `x` | cancel the agent's turn or the selected job |
| `ctrl+j` | the job pane, from anywhere |
| `ctrl+c` | cancel or go back one level — **never quits** |
| `?` / `q` | help · back, or quit from the start screen and the overview |

Every binding, screen by screen: [`docs/tui-design.md`](docs/tui-design.md#keybindings).

## Command line

```
spectacular                                 the TUI
spectacular --print                         the overview as text
spectacular init [-f]                       install the schema and the Foundation
spectacular instructions <artifact> -c <change>
                                            what to write, refused until its prerequisites are accepted
spectacular run <artifact> -c <change>      draft it with an agent as a background job
spectacular jobs [--job <id> [--cancel]]    list jobs, tail one, stop one
spectacular foundation                      the ground rules and what is unanswered
spectacular adr                             architectural decision records
spectacular archive <change> [--dry-run]    merge accepted requirements, divert deferred ones
spectacular pending                         requirements waiting on validation
spectacular verify <capability> --requirement <name>
spectacular roadmap [--promote <slice> | --done <slice>]
```

Global options: `--cwd <dir>`, `--openspec-bin <path>`, `--driver claude|opencode`, `-V`.

## Environment

| Variable | Effect |
| --- | --- |
| `SPECTACULAR_NO_ADVISOR` | Any non-empty value turns every model request off: no advisor, no vision interview, no name proposals. |
| `SPECTACULAR_ADVISOR_MODEL` | Model for the advisor and the vision interview (claude driver). Default `sonnet`. |
| `SPECTACULAR_QUICK_MODEL` | Model for name proposals. Default `haiku`. |
| `SPECTACULAR_CLAUDE_ARGS` | Extra arguments for the claude driver's jobs. |
| `SPECTACULAR_AGENT_MODE` | `acp` (default) or `jobs`: how the TUI's drafts reach an agent. `spectacular run` always uses a job. |
| `SPECTACULAR_ACP_COMMAND` | The ACP agent's command line, instead of `opencode acp` or `claude-agent-acp`. |
| `VISUAL`, `EDITOR` | The editor for `e` (falls back to nano, vim, vi). |

## Performance

The release build (`x86_64-unknown-linux-musl`), measured in a pty on an
OpenSpec project:

| | |
| --- | --- |
| Launch to first frame | about 14 ms (median of 10; 4 ms at best) |
| Memory | 5.0 MB resident on the start screen, 5.1 MB on the overview |
| `--help` | under 1 ms |
| Binary | 6.0 MiB, static, no runtime (aarch64: 4.9 MiB) |

The TypeScript version took 2.9 s to its first frame and needed 127 MB of
`node_modules` plus Bun.

## Port status: complete

spec-tacular was rewritten from TypeScript to Rust in ten stacked stages;
all ten are done. [`docs/rust-port.md`](docs/rust-port.md) has why, the
stages, what deliberately changed, and how to build (including without a C
toolchain). The TypeScript implementation is kept for history on the
`claude/vibrant-fermat-s72fcs` branch.

## Development

```sh
cargo test
cargo fmt --check && cargo clippy --all-targets -- -D warnings
cargo build --release
```

CI (`.github/workflows/ci.yml`) runs these on every pull request, the tests
on stable and on 1.88. Pushing a tag `vX.Y.Z` that matches `Cargo.toml`'s
version runs `.github/workflows/release.yml`, which builds the four binaries
and publishes the release. More: [`docs/architecture.md`](docs/architecture.md),
[`docs/tui-design.md`](docs/tui-design.md),
[`docs/problem-analysis.md`](docs/problem-analysis.md).

## Licence

MIT — see [`LICENSE`](LICENSE).
