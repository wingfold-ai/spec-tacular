#!/usr/bin/env python3
"""
Screenshots of the real spec-tacular TUI, taken headless and written as SVG.

    uv run --with pyte python scripts/tui-shots/capture.py [--only NAME ...] [--jobs 4] [--text]

For every shot in shots.py: build the demo project (fixture.py) in a fresh
temp dir, start `spec-tacular` from this repo's source in a pseudo-terminal
of the shot's size, press the shot's keys, wait for what it waits for, and
render the emulated screen — every cell with its colours and attributes —
to public/docs/shots/<name>.svg.

No AI is called: the TUI runs with SPECTACULAR_NO_ADVISOR=1 and
SPECTACULAR_NO_MCP=1, and no shot presses a key that starts an agent.

The pty + pyte approach and the key names come from evals/tools/tui.py.
"""

from __future__ import annotations

import argparse
import fcntl
import os
import pty
import re
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import time
import unicodedata
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import ClassVar
from xml.sax.saxutils import escape

import pyte

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import shots as shotlist

import fixture

REPO = fixture.REPO
OUT = REPO / "website" / "public" / "docs" / "shots"

# ── driving the terminal ────────────────────────────────────────────────────

KEYS = {
    "enter": "\r",
    "return": "\r",
    "tab": "\t",
    "shift+tab": "\x1b[Z",
    "esc": "\x1b",
    "escape": "\x1b",
    "space": " ",
    "backspace": "\x7f",
    "up": "\x1b[A",
    "down": "\x1b[B",
    "right": "\x1b[C",
    "left": "\x1b[D",
    "home": "\x1b[H",
    "end": "\x1b[F",
    "pgup": "\x1b[5~",
    "pgdown": "\x1b[6~",
    "delete": "\x1b[3~",
}

# Keys that would start an agent somewhere in the TUI. A shot that presses
# one is refused, so a careless edit to shots.py cannot spend money.
AGENT_KEYS = {"w", "r", "ctrl+r"}


def key_bytes(key: str) -> bytes:
    if key.startswith("text:"):
        return key[5:].encode()
    if key.lower() in KEYS:
        return KEYS[key.lower()].encode()
    m = re.fullmatch(r"ctrl\+(.)", key, re.IGNORECASE)
    if m:
        return bytes([ord(m.group(1).lower()) & 0x1F])
    if len(key) == 1:
        return key.encode()
    raise SystemExit(f"unknown key: {key}")


class Screen(pyte.Screen):
    """A pyte screen that answers the terminal's own queries (DA, DSR)."""

    def __init__(self, cols: int, rows: int, fd: int):
        super().__init__(cols, rows)
        self.fd = fd
        self.last_char = " "

    def draw(self, data: str) -> None:
        super().draw(data)
        if data:
            self.last_char = data[-1]

    def repeat_last(self, count: int = 1, **_kwargs) -> None:
        self.draw(self.last_char * max(count, 1))

    def write_process_input(self, data: str) -> None:
        try:
            os.write(self.fd, data.encode())
        except OSError:
            pass

    def report_device_status(self, mode: int, **kwargs) -> None:
        if kwargs.get("private"):
            return
        super().report_device_status(mode)


class Stream(pyte.ByteStream):
    csi: ClassVar[dict[str, str]] = {**pyte.ByteStream.csi, "b": "repeat_last"}


class Terminal:
    """One program in a pseudo-terminal, read into a pyte screen."""

    def __init__(
        self, command: list[str], cols: int, rows: int, env: dict[str, str], cwd: Path
    ):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(
                command[0],
                command,
                {
                    **env,
                    "TERM": "xterm-256color",
                    "COLORTERM": "truecolor",
                    "COLUMNS": str(cols),
                    "LINES": str(rows),
                },
            )
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.screen = Screen(cols, rows, self.fd)
        self.stream = Stream(self.screen)
        self.exited = False
        self.changed = time.time()

    def pump(self, timeout: float) -> None:
        """Read whatever the program writes for up to `timeout` seconds."""
        end = time.time() + timeout
        while not self.exited:
            left = end - time.time()
            if left <= 0:
                return
            r, _, _ = select.select([self.fd], [], [], min(left, 0.05))
            if not r:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                data = b""
            if not data:
                self.exited = True
                return
            self.stream.feed(data)
            self.changed = time.time()

    def text(self) -> str:
        return "\n".join(line.rstrip() for line in self.screen.display)

    def send(self, key: str) -> None:
        os.write(self.fd, key_bytes(key))
        self.pump(0.08)

    def wait(self, pattern: str, timeout: float) -> None:
        rx = re.compile(pattern, re.DOTALL)
        end = time.time() + timeout
        while time.time() < end and not self.exited:
            if rx.search(self.text()):
                return
            self.pump(0.1)
        raise RuntimeError(
            f"timed out after {timeout}s waiting for /{pattern}/\n{self.text()}"
        )

    def settle(self, quiet: float, timeout: float = 10) -> None:
        """Until nothing was drawn for `quiet` seconds (or `timeout`)."""
        end = time.time() + timeout
        self.changed = time.time()
        while time.time() < end and not self.exited:
            self.pump(0.1)
            if time.time() - self.changed >= quiet:
                return

    def close(self) -> None:
        try:
            os.kill(self.pid, signal.SIGTERM)
            self.pump(0.3)
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        os.close(self.fd)


# ── rendering the screen ────────────────────────────────────────────────────

BG = "#1a1b26"  # THEME.bg, src/tui/theme.ts
FG = "#c0caf5"  # THEME.text
FONT = "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
FONT_SIZE = 14
CW = 8.4  # cell width: 0.6em, the advance of JetBrains Mono
CH = 18  # cell height
BASE = 13.6  # baseline within a cell

# The 16 ANSI colours, should anything use them (tokyonight's).
ANSI = {
    "black": "#15161e",
    "red": "#f7768e",
    "green": "#9ece6a",
    "brown": "#e0af68",
    "blue": "#7aa2f7",
    "magenta": "#bb9af7",
    "cyan": "#7dcfff",
    "white": "#a9b1d6",
    "brightblack": "#414868",
    "brightred": "#f7768e",
    "brightgreen": "#9ece6a",
    "brightbrown": "#e0af68",
    "brightblue": "#7aa2f7",
    "brightmagenta": "#bb9af7",
    "brightcyan": "#7dcfff",
    "brightwhite": "#c0caf5",
}


def colour(value: str, default: str) -> str:
    if value == "default":
        return default
    if value in ANSI:
        return ANSI[value]
    if re.fullmatch(r"[0-9a-fA-F]{6}", value):
        return f"#{value.lower()}"
    return default


# Light box drawing, drawn as lines so borders join whatever the font:
# which of (left, right, up, down) each character reaches.
LINES = {
    "─": "lr",
    "│": "ud",
    "┌": "rd",
    "┐": "ld",
    "└": "ru",
    "┘": "lu",
    "├": "udr",
    "┤": "udl",
    "┬": "lrd",
    "┴": "lru",
    "┼": "lrud",
    "╭": "rd",
    "╮": "ld",
    "╰": "ru",
    "╯": "lu",
    "╴": "l",
    "╶": "r",
    "╵": "u",
    "╷": "d",
}
ROUNDED = set("╭╮╰╯")
# Double lines (the logo's shadow): two strokes, `D` either side of the centre.
DOUBLE = set("═║╔╗╚╝")
D = 1.6


def double(c: str, x: int, y: int) -> str:
    x0, x1, y0, y1 = x * CW, (x + 1) * CW, y * CH, (y + 1) * CH
    cx, cy = x0 + CW / 2, y0 + CH / 2
    if c == "═":
        return f"M{n(x0)} {n(cy - D)}H{n(x1)}M{n(x0)} {n(cy + D)}H{n(x1)}"
    if c == "║":
        return f"M{n(cx - D)} {n(y0)}V{n(y1)}M{n(cx + D)} {n(y0)}V{n(y1)}"
    # Corners: (horizontal edge, vertical edge, outer/inner offsets).
    hx = x1 if c in "╔╚" else x0
    vy = y1 if c in "╔╗" else y0
    sx = -1 if c in "╔╚" else 1  # which side of the centre the outer stroke turns
    sy = -1 if c in "╔╗" else 1
    outer = f"M{n(hx)} {n(cy + sy * D)}H{n(cx + sx * D)}V{n(vy)}"
    inner = f"M{n(hx)} {n(cy - sy * D)}H{n(cx - sx * D)}V{n(vy)}"
    return outer + inner
# Block elements, drawn as rectangles: (x0, y0, x1, y1) in cell fractions, opacity.
BLOCKS = {
    "█": (0, 0, 1, 1, 1),
    "▀": (0, 0, 1, 0.5, 1),
    "▄": (0, 0.5, 1, 1, 1),
    "▌": (0, 0, 0.5, 1, 1),
    "▐": (0.5, 0, 1, 1, 1),
    "▏": (0, 0, 0.125, 1, 1),
    "░": (0, 0, 1, 1, 0.25),
    "▒": (0, 0, 1, 1, 0.5),
    "▓": (0, 0, 1, 1, 0.75),
}


def n(v: float) -> str:
    """A coordinate, short."""
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s or "0"


def merge(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1] + 1e-6:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def cell_style(ch) -> tuple[str, str]:
    fg, bg = colour(ch.fg, FG), colour(ch.bg, BG)
    if ch.reverse:
        fg, bg = bg, fg
    return fg, bg


def wide(c: str) -> bool:
    return unicodedata.east_asian_width(c) in ("W", "F")


def emit(texts: list[str], cls, run: list[str], x: int, key, y: int) -> None:
    """One run of equally styled text; trailing spaces belong to no one."""
    text = "".join(run).rstrip()
    if not text.strip():
        return
    fg, bold, italic, under = key
    attrs = f' class="{cls(fg)}{" b" if bold else ""}{" i" if italic else ""}{" u" if under else ""}"'
    texts.append(
        f'<text x="{n(x * CW)}" y="{n(y * CH + BASE)}" textLength="{n(len(text) * CW)}"{attrs}>{escape(text)}</text>'
    )


def to_svg(screen: pyte.Screen, title: str) -> str:
    cols, rows = screen.columns, screen.lines
    W, H = cols * CW, rows * CH
    classes: dict[str, str] = {}

    def cls(fill: str) -> str:
        if fill not in classes:
            classes[fill] = f"c{len(classes)}"
        return classes[fill]

    rects: list[str] = []
    texts: list[str] = []
    hlines: dict[tuple[str, int], list[tuple[float, float]]] = {}
    vlines: dict[tuple[str, int], list[tuple[float, float]]] = {}
    arcs: dict[str, list[str]] = {}
    blocks: dict[tuple[str, float], list[tuple[float, float, float, float]]] = {}

    for y in range(rows):
        line = screen.buffer[y]
        cells = [line[x] for x in range(cols)]
        # Backgrounds: one rect per run of equal non-default colour.
        x = 0
        while x < cols:
            bg = cell_style(cells[x])[1]
            x0 = x
            while x < cols and cell_style(cells[x])[1] == bg:
                x += 1
            if bg != BG:
                rects.append(
                    f'<rect class="{cls(bg)}" x="{n(x0 * CW)}" y="{y * CH}" width="{n((x - x0) * CW)}" height="{CH}"/>'
                )

        # Text runs: equal style, spaces and drawn glyphs in between allowed.
        run: list[str] = []
        run_x = 0
        run_key = None

        x = 0
        while x < cols:
            ch = cells[x]
            c = ch.data or " "
            fg, _ = cell_style(ch)
            if c in LINES:
                cx, cy = x * CW + CW / 2, y * CH + CH / 2
                reach = LINES[c]
                if c in ROUNDED:
                    r = min(CW, CH) / 2
                    h = (x * CW, cx - r) if "l" in reach else (cx + r, (x + 1) * CW)
                    v = (y * CH, cy - r) if "u" in reach else (cy + r, (y + 1) * CH)
                    hlines.setdefault((fg, y), []).append(h)
                    vlines.setdefault((fg, x), []).append(v)
                    sx, sy = (h[1] if "l" in reach else h[0]), cy
                    ex, ey = cx, (v[1] if "u" in reach else v[0])
                    sweep = {"╭": 0, "╮": 1, "╰": 1, "╯": 0}[c]
                    arcs.setdefault(fg, []).append(
                        f"M{n(sx)} {n(sy)}A{n(r)} {n(r)} 0 0 {sweep} {n(ex)} {n(ey)}"
                    )
                else:
                    if "l" in reach:
                        hlines.setdefault((fg, y), []).append((x * CW, cx))
                    if "r" in reach:
                        hlines.setdefault((fg, y), []).append((cx, (x + 1) * CW))
                    if "u" in reach:
                        vlines.setdefault((fg, x), []).append((y * CH, cy))
                    if "d" in reach:
                        vlines.setdefault((fg, x), []).append((cy, (y + 1) * CH))
                c = " "
            elif c in DOUBLE:
                arcs.setdefault(fg, []).append(double(c, x, y))
                c = " "
            elif c in BLOCKS:
                fx0, fy0, fx1, fy1, op = BLOCKS[c]
                blocks.setdefault((fg, op), []).append(
                    (
                        (x + fx0) * CW,
                        y * CH + fy0 * CH,
                        (x + fx1) * CW,
                        y * CH + fy1 * CH,
                    )
                )
                c = " "
            if c == " ":
                if run:
                    run.append(" ")
                x += 1
                continue
            key = (fg, bool(ch.bold), bool(ch.italics), bool(ch.underscore))
            if wide(c[0]) or len(c) > 1:
                # Emoji and other wide glyphs get their two cells to
                # themselves, so a font's idea of their width moves nothing.
                emit(texts, cls, run, run_x, run_key, y)
                run, run_key = [], None
                texts.append(
                    f'<text x="{n(x * CW)}" y="{n(y * CH + BASE)}" textLength="{n(2 * CW)}" lengthAdjust="spacingAndGlyphs" class="{cls(fg)}">{escape(c)}</text>'
                )
                x += 2
                continue
            if run and key != run_key:
                emit(texts, cls, run, run_x, run_key, y)
                run, run_key = [], None
            if not run:
                run_x, run_key = x, key
            run.append(c)
            x += 1
        emit(texts, cls, run, run_x, run_key, y)

    # Lines: merge per row / column and colour into as few segments as possible.
    paths: dict[str, list[str]] = {}
    for (fg, y), segs in hlines.items():
        cy = y * CH + CH / 2
        for a, b in merge(segs):
            paths.setdefault(fg, []).append(f"M{n(a)} {n(cy)}H{n(b)}")
    for (fg, x), segs in vlines.items():
        cx = x * CW + CW / 2
        for a, b in merge(segs):
            paths.setdefault(fg, []).append(f"M{n(cx)} {n(a)}V{n(b)}")
    for fg, d in arcs.items():
        paths.setdefault(fg, []).extend(d)

    block_rects: list[str] = []
    for (fg, op), bs in blocks.items():
        # Merge horizontally adjacent blocks of one row.
        bs.sort(key=lambda b: (b[1], b[0]))
        merged: list[list[float]] = []
        for b in bs:
            if (
                merged
                and abs(merged[-1][1] - b[1]) < 1e-6
                and abs(merged[-1][3] - b[3]) < 1e-6
                and abs(merged[-1][2] - b[0]) < 1e-6
            ):
                merged[-1][2] = b[2]
            else:
                merged.append(list(b))
        op_attr = f' fill-opacity="{op}"' if op != 1 else ""
        for x0, y0, x1, y1 in merged:
            block_rects.append(
                f'<rect class="{cls(fg)}" x="{n(x0)}" y="{n(y0)}" width="{n(x1 - x0)}" height="{n(y1 - y0)}"{op_attr}/>'
            )

    css = [f".{k}{{fill:{v}}}" for v, k in classes.items()]
    css += [
        f"text{{font-family:{FONT};font-size:{FONT_SIZE}px;white-space:pre}}",
        ".b{font-weight:700}.i{font-style:italic}.u{text-decoration:underline}",
        "path{fill:none;stroke-width:1.2}",
    ]
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n(W)} {n(H)}" width="{n(W)}" height="{n(H)}" role="img" xml:space="preserve">',
        f"<title>{escape(title)}</title>",
        f"<style>{''.join(css)}</style>",
        f'<rect width="100%" height="100%" fill="{BG}"/>',
        *rects,
        *block_rects,
    ]
    for fg, ds in paths.items():
        out.append(f'<path stroke="{fg}" d="{"".join(ds)}"/>')
    out += texts
    out.append("</svg>")
    return "\n".join(out) + "\n"


# ── running a shot ──────────────────────────────────────────────────────────


def check_keys(shot: dict) -> None:
    for step in shot["steps"]:
        if step[0] != "keys":
            continue
        for k in step[1]:
            if not k.startswith("text:") and k.lower() in AGENT_KEYS:
                raise SystemExit(
                    f"{shot['name']}: refuses to press {k!r}, which starts an agent"
                )


def take(shot: dict, text: bool = False) -> tuple[str, int, str]:
    check_keys(shot)
    home = Path(tempfile.mkdtemp(prefix="st-shot-"))
    env = {
        **{k: v for k, v in os.environ.items() if not k.startswith("SPECTACULAR_")},
        "HOME": str(home),
        "SPECTACULAR_NO_ADVISOR": "1",
        "SPECTACULAR_NO_MCP": "1",
        # Nothing to dispatch to, should a key ever try.
        "SPECTACULAR_CLAUDE_ARGS": "--version",
    }
    term = None
    try:
        project = fixture.build(home, shot["stage"], env)
        cols, rows = shot.get("size", (110, 32))
        bun = shutil.which("bun") or "bun"
        term = Terminal(
            [bun, "run", str(REPO / "src/cli.ts"), "--cwd", str(project)],
            cols,
            rows,
            env,
            REPO,
        )
        for step in shot["steps"]:
            kind = step[0]
            if kind == "keys":
                for k in step[1]:
                    term.send(k)
            elif kind == "wait":
                term.wait(step[1], step[2])
            elif kind == "settle":
                term.settle(step[1])
            elif kind == "sleep":
                term.pump(step[1])
            if term.exited:
                raise RuntimeError(f"spec-tacular exited:\n{term.text()}")
        svg = to_svg(term.screen, shot["alt"])
        path = OUT / f"{shot['name']}.svg"
        path.write_text(svg)
        return shot["name"], len(svg.encode()), term.text() if text else ""
    finally:
        if term:
            term.close()
        shutil.rmtree(home, ignore_errors=True)


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--only", nargs="*", help="shot names to take (default: all)")
    p.add_argument("--jobs", type=int, default=4)
    p.add_argument("--text", action="store_true", help="also print each screen as text")
    args = p.parse_args()
    todo = [s for s in shotlist.SHOTS if not args.only or s["name"] in args.only]
    if not todo:
        raise SystemExit("no such shot")
    for s in todo:
        check_keys(s)
    OUT.mkdir(parents=True, exist_ok=True)
    failed = 0
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(take, s, args.text): s["name"] for s in todo}
        for f in as_completed(futures):
            try:
                name, size, text = f.result()
            except Exception as e:  # noqa: BLE001 — report every shot, not the first failure
                failed += 1
                print(f"✗ {futures[f]}: {e}", file=sys.stderr)
                continue
            print(f"✓ {name}.svg  {size / 1024:.1f} KB")
            if text:
                print(text)
    total = sum(f.stat().st_size for f in OUT.glob("*.svg"))
    print(f"{OUT.relative_to(REPO)}: {total / 1024:.0f} KB in all")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
