# Evaluations: spec-tacular used for real

Unit and e2e tests check that spec-tacular does what its code says. These
evaluations check what it is like to *use*: an agent plays a new user, builds
a small app with the real binary from an empty folder to implemented code,
and reports on the experience and on the code that came out — scored, with
evidence, in the same shape every time so versions can be compared.

## What is here

- `scenarios/` — what to build and as whom, the steps, the limits, how to
  judge the code, and the report's shape. `time-tracker.md` is the first.
- `../.claude/agents/spec-tacular-evaluator.md` — the evaluating agent.
- `tools/tui.py` — a headless terminal (a pseudo-terminal and the `pyte`
  emulator) an agent drives one command at a time: start a program, read the
  screen, send keys. No tmux, no desktop.
- `tools/shims/` — what makes a run self-contained: a `tmux` stand-in so
  spec-tacular's implementing session opens in another headless terminal
  rather than a desktop window, and a `claude` wrapper that passes every
  call through — what the implementing session may do without asking is the
  version under test's own choice.
- `setup.sh` — prepares a run directory: an empty git repository with
  OpenSpec initialised, the environment, and a `start.sh`.

## Running one

Needs `bun`, `uv`, `claude` (signed in) and OpenSpec (`openspec`, or this
repository's dev dependency).

```sh
# A binary of the version under test.
bun run build --outfile /tmp/eval/bin/spec-tacular

# A run directory for it.
evals/setup.sh /tmp/eval/run-1 /tmp/eval/bin/spec-tacular README.md
```

Then, in Claude Code, ask for the `spec-tacular-evaluator` agent with the run
directory, a label and the scenario, e.g.:

> Use the spec-tacular-evaluator agent: run directory /tmp/eval/run-1,
> label `fret`, scenario evals/scenarios/time-tracker.md.

It writes `log.md` and `report.md` into the run directory, with the run's
measurements from `tools/metrics.py` (`metrics.json`, `metrics.md`): drafting
jobs and their cost, the implementing session's tokens from Claude Code's own
transcripts, what was reviewed, the questions answered and left for later,
per-phase time spent waiting on an agent, and the produced code's size and
test results — measured from the run, the same way for every version.
Scores are levels with stated conditions (the scenario's *Scoring*), and two
ledgers record whether each upfront question and each assurance step paid
off.

Run directories live wherever you put them, often a temporary folder. To
keep a run, copy it into the repository: `evals/tools/keep.sh <run-dir>
<label>` puts its report, log, measurements and prompts under
`evals/results/<date>-<label>/`. `evals/tools/compare.py evals/results/*/`
prints their measurements side by side. To compare two
versions, prepare a run for each (another binary, another README) and run
the agent on both — in parallel is fine, each run is isolated.

## What to keep in mind

- A run uses real models: spec-tacular's advisor and drafting agents, the
  implementing session, and the evaluator itself. Expect an hour or more and
  a noticeable cost per run.
- Two runs differ by chance as well as by version: the drafts, the
  evaluator's answers, the implementation. Compare patterns, and read the
  friction logs, rather than a single score.
- The harness is part of the experience it measures: a problem caused by the
  headless terminal, not by spec-tacular, is reported as such.
