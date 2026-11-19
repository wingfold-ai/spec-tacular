# TUI screenshots

Real screens of the spec-tacular TUI for the docs, captured headless and
written as SVG to `public/docs/shots/`.

```bash
cd website
pnpm shots                      # every shot
pnpm shots --only qs-05-review  # one (or several) by name
pnpm shots --text               # also print each screen as text
```

Needs `bun`, `uv`, `git` and the `openspec` CLI on the PATH, and
`bun install` run once in the repo root. A full run takes about a minute.

## How it works

- `fixture.py` builds a demo project (`~/my-app`, with `$HOME` pointed at a
  temp dir) for each shot: `git init`, `openspec init --tools claude`,
  `spec-tacular init`, ground rules answered, and the change
  `add-user-login` with as many of its artifacts as the shot's stage needs.
  Everything is plain files; nothing calls an AI.
- `shots.py` is the shot list: per shot the stage, the terminal size, the
  keys to press and what to wait for. Accepting the proposal, the
  requirements, the design and the tasks is done there with the real keys.
- `capture.py` runs `bun run src/cli.ts` from this repo in a pseudo-terminal
  (the approach of `evals/tools/tui.py`), feeds its output to a
  [pyte](https://github.com/selectel/pyte) screen, and renders every cell:
  backgrounds as rects, text as runs of equal style, box-drawing lines and
  block characters as vector shapes, so borders join whatever font the
  reader has. Each text run carries a `textLength`, so a fallback font
  cannot shift the columns.

Every run sets `SPECTACULAR_NO_ADVISOR=1` and `SPECTACULAR_NO_MCP=1`, and
`capture.py` refuses a shot that presses `w`, `r` or `ctrl+r`, the keys that
start an agent. Screens that only an agent can reach (a draft in progress,
the advisor's options, the vision interview) are not captured.

Use a shot in Markdown with the `TuiShot` component:

```md
::tui-shot{src="/docs/shots/qs-05-review.svg" alt="…" caption="…"}
::
```

The start screen's logo animates its gradient, so `qs-01-start.svg` can
change colour slightly between runs (on a quiet machine it comes out the
same); every other shot is byte-for-byte stable.
