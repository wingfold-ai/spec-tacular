# Contributing to spec-tacular

Thanks for taking the time to contribute. This guide covers how to report a
problem, set up the repository, run the checks, and get a change merged.

## Ways to contribute

- **Report a bug** with the bug report form in the
  [issue tracker](https://github.com/wingfold-ai/spec-tacular/issues/new/choose).
- **Suggest a feature** with the feature request form. Describe the problem
  first; the solution can follow.
- **Ask a question** in an issue. Read the
  [documentation](https://spec-tacular.app/docs) first; many answers are there.
- **Improve the documentation.** Small fixes need no issue first.
- **Fix an issue.** Issues labelled `good first issue` are a good place to
  start; `help wanted` marks work the maintainer would like help with.

For anything larger than a small fix, open an issue before you write the code,
so we can agree on the approach first.

Security problems are the exception: never open a public issue for them.
Follow [SECURITY.md](SECURITY.md).

## Read these first

You do not need all of it before your first change.

1. [`README.md`](README.md): what spec-tacular does, every command, every
   environment variable, and the source layout.
2. [`docs/architecture.md`](docs/architecture.md): stack, layering, data
   model, state machine.
3. [`docs/tui-design.md`](docs/tui-design.md): screens, layout, keybindings.
   Read it before you change a screen.
4. [`schemas/spec-tacular/schema.yaml`](schemas/spec-tacular/schema.yaml): the
   OpenSpec schema that enforces the order of the artifacts.
5. [`docs/proposals/`](docs/proposals/README.md): the larger changes, written
   as OpenSpec proposals, and which of them are implemented.

The layering in short: `src/adapter/` is the only code that knows OpenSpec
exists, `src/core/` decides, `src/tui/` only draws, and `src/agent/` builds
agent commands but never talks to a model itself.

## Development setup

You need:

- [Bun](https://bun.sh) 1.4.2. CI and the release builds use this version.
- Git.
- The [OpenSpec](https://github.com/Fission-AI/OpenSpec) CLI, to run
  spec-tacular against a real project. CI tests against 2.0.0 (1.x works too):

  ```bash
  npm i -g @fission-ai/openspec
  ```

  `bun install` also installs it as a dev dependency, so `bunx openspec` works
  inside the repository.
- Claude Code (`claude`) or opencode (`opencode`), only to use the app for
  real. The tests need neither.

Then:

```bash
git clone https://github.com/wingfold-ai/spec-tacular.git
cd spec-tacular
bun install
```

## Running from source

```bash
# The TUI, on an OpenSpec project (run `openspec init` there first)
bun run src/cli.ts --cwd /path/to/project

# The same overview as text
bun run src/cli.ts --cwd /path/to/project --print

# Every command and option
bun run src/cli.ts --help
```

`bunfig.toml` preloads the Solid JSX transform. Without it the TUI draws once
and never updates, so always start it through `bun`, not `node`.

To build the standalone binary:

```bash
bun run build   # writes dist/spec-tacular for this machine
```

## Checks

Run these before you push. CI runs the same on Linux and macOS.

```bash
bun run typecheck       # tsc --noEmit
bun test                # every test
bun test --coverage     # the same, with a coverage table
```

Run one file while you work:

```bash
bun test test/hazards.test.ts
```

**Coverage.** CI fails a pull request when total coverage drops below 90% of
lines or 88% of functions (the "Coverage floor" step in `ci.yml`). New code
comes with tests, and a change should not lower the coverage of the files it
touches.

**How the tests avoid real agents.** No test calls Claude Code, opencode or a
model, and none needs an API key or the network:

- `test/support/fake-stream-agent.ts` stands in for `claude -p` with
  stream-json input and output. The message text steers it: `DIE`, `HANG`,
  `FAIL`, or an echo.
- `test/support/fake-opencode.ts` stands in for `opencode serve`: the HTTP
  endpoints the driver uses, on a local port.
- `test/support/app-harness.tsx` mounts the whole TUI against a temporary
  project and a stubbed OpenSpec. The `*-e2e.test.tsx` files drive it by
  keystroke and assert on the rendered terminal frame.

A new test that needs an agent uses one of these fakes. A few tests need
`git` or `openspec` on the `PATH` and are skipped without them.

**Evaluations** in [`evals/`](evals/README.md) are different: an agent uses
the real binary with a real Claude Code session to build a small app. They
cost money and take a long time, so they are not part of CI and not expected
in a pull request.

## The website

The site at [spec-tacular.app](https://spec-tacular.app), including the
documentation at `/docs`, lives in [`website/`](website/README.md). It is a
Nuxt app and needs Node 22.13 or later and pnpm (the version is pinned in
`website/package.json`):

```bash
cd website
pnpm install
pnpm dev        # http://localhost:3000
pnpm generate   # the static site in .output/public
```

The documentation pages are Markdown in `website/content/docs/`. A pull
request that changes what a user sees updates them, and the README, in the
same pull request. Every claim on the site is checked against `src/` and the
README.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Keep the change focused. One pull request does one thing.
3. Add or update tests for the behaviour you change.
4. Update the README and `website/content/docs/` when behaviour changes.
5. Run the checks above.

### Commit and pull request titles

Pull requests are squash-merged, so the **pull request title** becomes the
commit message on `main`. Write it as a
[Conventional Commit](https://www.conventionalcommits.org/):

```
feat(ui): Show why a draft stopped and how to get it written
fix(agent): Restart a session that died mid-turn
docs(repo): Explain each pipeline stage
```

- **Type:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
  `chore`, `revert` or `style`.
- **Scope:** the part of the repository it touches: `core`, `ui`, `cli`,
  `agent`, `release`, `deploy`, `tests` or `repo`.
- **Subject:** starts with a capital letter, has no trailing period, and the
  whole title is at most 72 characters. CI checks this.
- **Breaking change:** add `!` before the colon (`feat(cli)!: …`) and say in
  the description what users have to change.

The maintainer labels each pull request with its type (`type: feat`,
`type: docs`, …) and the version bump it implies (`semver: minor`,
`semver: none`, …).

## How a release happens

A release is a version bump merged into `main`:

1. A pull request that should ship raises `version` in `package.json`. Below
   1.0, a feature or a breaking change raises the minor version, a fix the
   patch version.
2. When it is merged, `.github/workflows/auto-release.yml` tags the merge
   commit `v<version>`, then calls `.github/workflows/release.yml`.
3. The release workflow checks that the tag matches `package.json`, builds
   and smoke-tests a binary on each platform (Linux and macOS, x64 and
   arm64), and publishes the archives with a `SHA256SUMS` file as a GitHub
   release.

A merge that leaves the version alone releases nothing. Most pull requests do
not bump it; the maintainer decides when to release.

## Opening a pull request

- Fill in the pull request template: Summary, Changes, Test plan, and Risk &
  rollout. Link the issue it resolves.
- CI must pass. If a check fails for a reason unrelated to your change, say
  so in the pull request.
- spec-tacular has one maintainer, so a review can take a while. Expect a
  first response within two weeks; a comment on the pull request is welcome
  if it takes longer.
- Push follow-up commits rather than force-pushing, so the review can see
  what changed. They are squashed on merge anyway.

A good pull request:

- says what problem it solves and why this is the right fix;
- changes one thing, with tests that fail without it;
- updates the README and the docs pages it makes wrong;
- says how you tested it, including by hand in the TUI when a screen
  changed.

## Licensing of contributions

By contributing you agree that your contribution is licensed under the
project's [MIT License](LICENSE).

## Code of Conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By taking part
you agree to uphold it.
