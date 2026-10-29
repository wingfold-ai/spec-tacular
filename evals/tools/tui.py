#!/usr/bin/env python3
"""
A headless terminal an agent can drive: a pseudo-terminal running a program,
an emulated screen (pyte) it can read, and keys it can send. No tmux, no
desktop — each Bash call is one command, and the program keeps running in a
background daemon between them.

    tui.py start  <session> [--cols 150] [--rows 45] -- <command> [args...]
    tui.py screen <session> [--wait REGEX] [--timeout 60] [--settle 1.5]
    tui.py keys   <session> KEY [KEY...]
    tui.py paste  <session> TEXT
    tui.py alive  <session>
    tui.py stop   <session>

<session> is a directory; it holds the daemon's pid, the input queue, the
current screen (screen.txt), every distinct screen seen (history.txt), and
the exit status once the program ends.

KEY is a literal character (`a`, `?`), a name — enter, tab, shift+tab, esc,
space, backspace, up, down, left, right, home, end, pgup, pgdown —, ctrl+X,
or `text:<string>` to type a string.

`screen --wait REGEX` waits until the screen matches (or the timeout), and
otherwise until it has stopped changing for `--settle` seconds, so an agent
reads a screen that has finished drawing.
"""

import argparse
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import traceback
from typing import ClassVar

try:
    import pyte
except ImportError:  # pragma: no cover
    sys.exit("tui.py needs pyte: uv venv && uv pip install pyte (see evals/README.md)")

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
        """REP (`CSI n b`): the last character drawn, n more times."""
        self.draw(self.last_char * max(count, 1))

    def write_process_input(self, data: str) -> None:
        try:
            os.write(self.fd, data.encode())
        except OSError:
            pass

    def report_device_status(self, mode: int, **kwargs) -> None:
        # pyte has no private (`CSI ? n n`) status reports — e.g. the colour
        # scheme query a TUI sends when it resumes after $EDITOR — and its
        # own method raises on them. Unanswered is what a terminal without
        # the feature does.
        if kwargs.get("private"):
            return
        super().report_device_status(mode)


class Stream(pyte.ByteStream):
    """pyte's stream, with the sequences it lacks that TUIs use."""

    csi: ClassVar[dict[str, str]] = {**pyte.ByteStream.csi, "b": "repeat_last"}


def render(screen: pyte.Screen) -> str:
    lines = [line.rstrip() for line in screen.display]
    while lines and not lines[-1]:
        lines.pop()
    cursor = f"[cursor {screen.cursor.y + 1},{screen.cursor.x + 1}]"
    return "\n".join(lines) + f"\n{cursor}\n"


def daemon(session: str, cols: int, rows: int, command: list[str]) -> None:
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(
            os.environ, TERM="xterm-256color", COLUMNS=str(cols), LINES=str(rows)
        )
        os.execvpe(command[0], command, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    screen = Screen(cols, rows, fd)
    stream = Stream(screen)
    inbox = os.path.join(session, "in")
    os.mkfifo(inbox)
    infd = os.open(inbox, os.O_RDWR | os.O_NONBLOCK)
    last = ""
    status = None
    with open(os.path.join(session, "history.txt"), "a") as history:
        while True:
            r, _, _ = select.select([fd, infd], [], [], 0.2)
            if fd in r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    _, code = os.waitpid(pid, 0)
                    status = os.waitstatus_to_exitcode(code)
                    break
                try:
                    stream.feed(data)
                except Exception:  # noqa: BLE001 — the session must outlive one bad sequence
                    with open(os.path.join(session, "daemon.log"), "a") as log:
                        log.write(
                            f"{time.strftime('%H:%M:%S')} {traceback.format_exc()}\n"
                        )
            if infd in r:
                try:
                    os.write(fd, os.read(infd, 65536))
                except OSError:
                    pass
            text = render(screen)
            if text != last:
                tmp = os.path.join(session, "screen.tmp")
                with open(tmp, "w") as f:
                    f.write(text)
                os.replace(tmp, os.path.join(session, "screen.txt"))
                history.write(f"\n===== {time.strftime('%H:%M:%S')} =====\n{text}")
                history.flush()
                last = text
    with open(os.path.join(session, "exit"), "w") as f:
        f.write(str(status))


def start(args: argparse.Namespace) -> None:
    os.makedirs(args.session, exist_ok=True)
    for name in ("in", "exit", "screen.txt", "pid"):
        try:
            os.remove(os.path.join(args.session, name))
        except FileNotFoundError:
            pass
    if os.fork() == 0:
        os.setsid()
        if os.fork() == 0:
            devnull = os.open(os.devnull, os.O_RDWR)
            for std in (0, 1, 2):
                os.dup2(devnull, std)
            with open(os.path.join(args.session, "pid"), "w") as f:
                f.write(str(os.getpid()))
            daemon(args.session, args.cols, args.rows, args.command)
        os._exit(0)
    deadline = time.time() + 10
    while (
        not os.path.exists(os.path.join(args.session, "in")) and time.time() < deadline
    ):
        time.sleep(0.05)
    print(f"started in {args.session}")


def alive(session: str) -> bool:
    return not os.path.exists(os.path.join(session, "exit")) and os.path.exists(
        os.path.join(session, "pid")
    )


def read_screen(session: str) -> str:
    try:
        with open(os.path.join(session, "screen.txt")) as f:
            return f.read()
    except FileNotFoundError:
        return ""


def screen(args: argparse.Namespace) -> None:
    deadline = time.time() + args.timeout
    pattern = re.compile(args.wait, re.DOTALL) if args.wait else None
    last, since = read_screen(args.session), time.time()
    while time.time() < deadline:
        time.sleep(0.2)
        now = read_screen(args.session)
        if pattern and pattern.search(now):
            last = now
            break
        if now != last:
            last, since = now, time.time()
        elif not pattern and time.time() - since >= args.settle:
            break
        if not alive(args.session):
            break
    else:
        if pattern:
            print(f"[timed out after {args.timeout}s waiting for /{args.wait}/]")
    sys.stdout.write(last)
    if not alive(args.session):
        print(
            f"[the program has exited: {read_file(os.path.join(args.session, 'exit')) or '?'}]"
        )


def read_file(path: str) -> str:
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        return ""


def send(session: str, data: bytes) -> None:
    if not alive(session):
        raise SystemExit("the program has exited")
    fd = os.open(os.path.join(session, "in"), os.O_WRONLY | os.O_NONBLOCK)
    os.write(fd, data)
    os.close(fd)


def keys(args: argparse.Namespace) -> None:
    for k in args.keys:
        send(args.session, key_bytes(k))
        time.sleep(0.08)


def paste(args: argparse.Namespace) -> None:
    send(args.session, b"\x1b[200~" + args.text.encode() + b"\x1b[201~")


def stop(args: argparse.Namespace) -> None:
    try:
        pid = int(read_file(os.path.join(args.session, "pid")))
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except (ProcessLookupError, ValueError):
        pass
    print("stopped")


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start")
    s.add_argument("session")
    s.add_argument("--cols", type=int, default=150)
    s.add_argument("--rows", type=int, default=45)
    s.set_defaults(fn=start)
    s = sub.add_parser("screen")
    s.add_argument("session")
    s.add_argument("--wait")
    s.add_argument("--timeout", type=float, default=60)
    s.add_argument("--settle", type=float, default=1.5)
    s.set_defaults(fn=screen)
    s = sub.add_parser("keys")
    s.add_argument("session")
    s.add_argument("keys", nargs="+")
    s.set_defaults(fn=keys)
    s = sub.add_parser("paste")
    s.add_argument("session")
    s.add_argument("text")
    s.set_defaults(fn=paste)
    s = sub.add_parser("alive")
    s.add_argument("session")
    s.set_defaults(fn=lambda a: print("alive" if alive(a.session) else "exited"))
    s = sub.add_parser("stop")
    s.add_argument("session")
    s.set_defaults(fn=stop)
    # Everything after `--` is the program to run, options and all.
    argv = sys.argv[1:]
    command: list[str] = []
    if "--" in argv:
        at = argv.index("--")
        argv, command = argv[:at], argv[at + 1 :]
    args = p.parse_args(argv)
    args.command = command
    if args.cmd == "start" and not command:
        p.error("start needs a program to run after --")
    args.fn(args)


if __name__ == "__main__":
    main()
