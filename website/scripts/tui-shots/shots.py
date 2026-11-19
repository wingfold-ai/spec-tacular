"""
The shot list. Each shot is one fresh run of the TUI:

    name    the file, public/docs/shots/<name>.svg
    stage   the demo project's state before the TUI starts (fixture.py)
    size    (columns, rows) of the terminal
    steps   what to do, in order:
              ("keys", [KEY, ...])        press keys (names as in evals/tools/tui.py)
              ("wait", REGEX, seconds)    until the screen matches
              ("settle", seconds)         until nothing was drawn for that long
              ("sleep", seconds)          just wait
    alt     what the image shows, for screen readers (also its <title>)

Everything after the stage is done with keys — accepting the proposal, each
requirement, the tasks — exactly as a person would. Never press a key that
starts an agent (w, r, ctrl+r): capture.py refuses to.
"""

COLS = 110


def keys(*k: str) -> tuple:
    return ("keys", list(k))


def wait(pattern: str, timeout: float = 30) -> tuple:
    return ("wait", pattern, timeout)


def settle(seconds: float = 1.0) -> tuple:
    return ("settle", seconds)


def sleep(seconds: float) -> tuple:
    return ("sleep", seconds)


# From the start screen into the overview, and from there into each step.
OPEN = [wait(r"Open project"), keys("enter"), wait(r"Changes · 1")]
# The notice comes first; the change panel follows once the pipeline is
# reloaded, and only then do its buttons lead to the next step. So every
# acceptance waits for the pipeline bar itself.
READ_PROPOSAL = [keys("enter"), wait(r"Accept it"), sleep(1.0)]
ACCEPT_PROPOSAL = [
    *READ_PROPOSAL,
    keys("a"),
    wait(r"✓ proposal ── ● specs.*Review the specs: 4 requirements"),
    sleep(1.0),
]
REVIEW = [keys("enter"), wait(r"requirement 1 of \d"), sleep(0.5)]
# Four requirements, two risks, two design decisions: one `a` each.
ACCEPT_ALL = [
    *REVIEW,
    *[step for _ in range(8) for step in (keys("a"), sleep(0.4))],
    wait(r"8 accepted · 0 pending"),
    keys("q"),
    wait(r"✓ risks ── ● design.*Read the design, then accept"),
    sleep(1.0),
]
ACCEPT_DESIGN = [
    keys("enter"),
    wait(r"Accept it"),
    sleep(1.0),
    keys("a"),
    wait(r"✓ design ── ● tasks.*Read the tasks, then accept"),
    sleep(1.0),
]
ACCEPT_TASKS = [
    keys("enter"),
    wait(r"Accept it"),
    sleep(1.0),
    keys("a"),
    wait(r"✓ tasks ── .*tasks of add-user-login is accepted"),
    sleep(1.0),
]

SHOTS = [
    {
        "name": "qs-01-start",
        "stage": "fresh",
        "size": (COLS, 24),
        "steps": [wait(r"▶ Start"), sleep(1.5)],
        "alt": "The start screen: the spec-tacular logo, the line 'OpenSpec is here; spec-tacular is not set up yet.' and the buttons Start and Quit",
    },
    {
        "name": "qs-02-ground-rules",
        "stage": "fresh",
        "size": (COLS, 26),
        "steps": [
            wait(r"▶ Start"),
            sleep(0.5),
            keys("enter"),
            wait(r"Begin — \d+ questions", 60),
            keys("enter"),
            wait(r"What the system is for"),
            keys(
                "text:A small notes app. Used by individuals on their phone and laptop to keep short private notes."
            ),
            settle(0.8),
        ],
        "alt": "Ground rules: the first question, 'What the system is for, and who uses it.', with an answer typed into the box at the bottom and a progress row for Domain, Stack, Architecture and Conventions",
    },
    {
        "name": "qs-03-overview",
        "stage": "change",
        "size": (COLS, 22),
        "steps": [*OPEN, settle()],
        "alt": "The overview: the Changes list with add-user-login, and its change panel with the pipeline bar (proposal ready, the other stages blocked) and the buttons 'Let an agent draft it' and 'Write it myself'",
    },
    {
        "name": "qs-04-proposal",
        "stage": "proposal",
        "size": (COLS, 30),
        "steps": [*OPEN, *READ_PROPOSAL, keys(*["down"] * 8), settle()],
        "alt": "The proposal of add-user-login opened for reading, scrolled to its Boundary section, with the buttons Accept it, Edit it, Redraft with feedback and Back",
    },
    {
        "name": "qs-05-review",
        "stage": "specs",
        "size": (COLS, 26),
        "steps": [
            *OPEN,
            *ACCEPT_PROPOSAL,
            *REVIEW,
            keys("a"),
            wait(r"requirement 2 of 4"),
            settle(),
        ],
        "alt": "The review on requirement 2 of 4, 'Lock after repeated failures': its text, its scenario, a warning about the undefined words 'quickly' and 'several', and a flag that it names an HTTP endpoint",
    },
    {
        "name": "qs-06-review-progress",
        "stage": "specs",
        "size": (COLS, 22),
        "steps": [
            *OPEN,
            *ACCEPT_PROPOSAL,
            *REVIEW,
            keys("a"),
            wait(r"requirement 2 of 4"),
            keys("x"),
            wait(r"Why reject\?"),
            keys(
                "text:Say how many attempts and how long; leave the endpoint to the design.",
                "enter",
            ),
            wait(r"requirement 3 of 4"),
            keys("a"),
            wait(r"requirement 4 of 4"),
            keys("d"),
            wait(r"What would verify it\?"),
            keys("text:a test with a fake clock"),
            settle(),
        ],
        "alt": "The review on requirement 4 of 4 with the progress bar at 2 accepted, 1 rejected, 1 pending, and the defer prompt 'What would verify it?' being answered",
    },
    {
        "name": "qs-07-risks",
        "stage": "risks",
        "size": (COLS, 24),
        "steps": [
            *OPEN,
            *ACCEPT_PROPOSAL,
            *REVIEW,
            keys("a", "a", "a", "a"),
            wait(r"risk 5 of 6"),
            settle(),
        ],
        "alt": "The review on risk 5 of 6, 'Password stored readable': its hazard, what it affects, its severity, the guard that rules it out and the check that tests the guard",
    },
    {
        "name": "qs-08-implement",
        "stage": "tasks",
        "size": (COLS, 18),
        "steps": [
            *OPEN,
            *ACCEPT_PROPOSAL,
            *ACCEPT_ALL,
            *ACCEPT_DESIGN,
            *ACCEPT_TASKS,
            settle(),
        ],
        "alt": "The overview after the tasks are accepted: every planning stage ticked in the pipeline bar, 'Planning is done. Implement it', the button 'Implement it in Claude Code', and the notice that the tasks are accepted",
    },
    {
        "name": "qs-09-archive",
        "stage": "implemented",
        "size": (COLS, 26),
        "steps": [
            *OPEN,
            *ACCEPT_PROPOSAL,
            *ACCEPT_ALL,
            *ACCEPT_DESIGN,
            *ACCEPT_TASKS,
            wait(r"Archive it"),
            keys("A"),
            wait(r"archive it\?"),
            settle(),
        ],
        "alt": "The overview with all tasks ticked off and the archive preview: 4 requirements merge into the baseline, 0 divert to pending validation, enter archives it",
    },
    {
        "name": "np-01-vision",
        "stage": "empty",
        "size": (COLS, 22),
        "steps": [
            wait(r"▶ Start"),
            sleep(0.5),
            keys("enter"),
            wait(r"What are you building\?", 60),
            keys(
                "text:A notes app for people who want their notes private: sign in, write, find them again."
            ),
            settle(0.8),
        ],
        "alt": "The vision screen of a new project: 'What are you building?', a description typed into the box, and the buttons Continue and 'Not a new project — just start a change'",
    },
]
