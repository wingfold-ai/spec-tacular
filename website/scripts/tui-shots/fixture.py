"""
The demo project the screenshots are taken in: built fresh for every shot,
deterministic, and without a single AI call.

    build(home, stage) -> project path

`home` becomes $HOME for the TUI, so paths show as `~/my-app`. Each stage
adds to the one before it:

    fresh      git + `openspec init --tools claude` + one baseline spec
               (spec-tacular not set up yet: the start screen's "Start" path)
    empty      git + `openspec init` only, nothing else (a new project)
    setup      fresh + `spectacular init` + every ground rule answered
    change     setup + the change `add-user-login`, nothing written yet
    proposal   change + proposal.md
    specs      proposal + specs/auth/spec.md
    risks      specs + risks.md
    design     risks + design.md
    tasks      design + tasks.md
    implemented tasks with every box ticked

Only files are written here. Accepting — the proposal, a requirement, the
tasks — is done by the shot itself, with the keys a person would press.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
CHANGE = "add-user-login"
STAGES = [
    "fresh",
    "setup",
    "change",
    "proposal",
    "specs",
    "risks",
    "design",
    "tasks",
    "implemented",
]

GIT_ENV = {
    "GIT_AUTHOR_NAME": "demo",
    "GIT_AUTHOR_EMAIL": "demo@example.com",
    "GIT_COMMITTER_NAME": "demo",
    "GIT_COMMITTER_EMAIL": "demo@example.com",
    "GIT_AUTHOR_DATE": "2026-01-15T09:00:00Z",
    "GIT_COMMITTER_DATE": "2026-01-15T09:00:00Z",
}

BASELINE_SPEC = """# notes Specification

## Purpose
Lets a signed-in user keep short private notes and find them again.

## Requirements

### Requirement: Create a note
The system SHALL let a user create a note with a title and a body.

#### Scenario: Saved note is listed
- **WHEN** a user saves a note titled "Groceries"
- **THEN** "Groceries" appears in their list of notes
"""

# Every question the ground rules ask, answered — keyed by its heading.
FOUNDATION = {
    "What the system is for, and who uses it.": "A small notes app. Used by individuals on their phone and laptop to keep short private notes.",
    "The core terms, each with a one-line meaning.": "Note: a title and a body, owned by one user.\nAccount: an email address and a password.",
    "Rules about the domain that must always hold.": "A user only ever sees their own notes.",
    "What is explicitly out of scope.": "Sharing notes. Teams. Payments.",
    "Language and runtime, with versions.": "TypeScript 5.6 on Bun 1.4",
    "Framework, if any, and why it over the alternatives.": "Hono — small and runs on Bun; Express ruled out for its middleware model.",
    "Datastore and how schema changes are managed.": "SQLite via bun:sqlite; migrations are numbered SQL files, never edited after release.",
    "Package manager, test runner, linter, formatter.": "bun, bun test, eslint, prettier",
    "Anything explicitly ruled out, and why.": "No ORM — queries stay visible.",
    "Architecture style (layered, hexagonal, vertical slice, ...) and why.": "Layered: routes call services, services call the store. Simple enough for one developer.",
    "The layers or modules, and which may depend on which.": "routes ← services ← store. The store never imports a route.",
    "Where business rules live, and what must never leak into them.": "In src/services/. No HTTP types or SQL in there.",
    "How errors are represented and propagated.": "Services return results; routes map them to HTTP status codes.",
    "How the system is configured and how secrets are handled.": "Env vars, validated once at startup. Secrets are never logged.",
    "Naming: files, types, functions, tests.": "kebab-case files, PascalCase types, tests named after behaviour.",
    "What a test must cover before a change is considered done.": "Every scenario of every accepted requirement, as a test.",
    "How code is reviewed and what blocks a merge.": "Failing tests or typecheck block a merge.",
    "Comment style: what is worth writing down and what is noise.": "Explain why, never what.",
    "Anything a new contributor reliably gets wrong.": "Timestamps are stored in UTC.",
}

PROPOSAL = """# add-user-login

## Why
Notes are private, but today anyone with the link can read them. Users need an account and a way to sign in before notes can belong to someone.

## What Changes
- Users can sign in with their email address and password.
- A wrong password is refused without saying which part was wrong.
- Repeated failed attempts lock the account for a while.
- Users can sign out on the device they are using.

## Capabilities

### New Capabilities
- `auth`: signing in and out with an email address and a password

## Impact
A new login form and session cookie. Every notes route now needs a session.

## Boundary
- `src/auth/`
- `src/routes/login.ts`
- `test/auth/`
"""

SPEC = """# Spec Delta

## Purpose
Lets a user prove who they are with an email address and a password, so their
notes are theirs alone.

## ADDED Requirements

### Requirement: Sign in with email
The system SHALL let a registered user sign in with their email address and password.

#### Scenario: Correct password
- **WHEN** a user submits their email address and correct password
- **THEN** they are signed in and see their notes

#### Scenario: Wrong password
- **WHEN** a user submits a wrong password
- **THEN** sign-in is refused with "Email or password is wrong"
- **AND** the message does not say which of the two was wrong

### Requirement: Lock after repeated failures
The system SHALL lock an account quickly after several failed sign-in attempts, through `POST /api/login`.

#### Scenario: Too many attempts
- **WHEN** a user fails to sign in five times in a row
- **THEN** further attempts are refused for 15 minutes

### Requirement: Sign out
The system SHALL let a signed-in user sign out, ending their session on that
device.

#### Scenario: Sign out
- **WHEN** a signed-in user chooses "Sign out"
- **THEN** their session ends and the sign-in page is shown

### Requirement: Session expiry
The system SHALL end a session after 30 days without use.

#### Scenario: Idle session
- **WHEN** a session has not been used for 30 days
- **THEN** the next request asks the user to sign in again
"""

RISKS = """# Risks

### Risk: Password stored readable
- **Hazard:** a password can be read back from the database or the logs
- **Affects:** Sign in with email
- **Boundary:** storing and checking a password
- **Causes:** storing it in plain text; logging the request body
- **Severity:** high
- **Guard:** only a salted hash of the password is ever stored, and request bodies are never logged
- **Check:** a test signs up, then searches the database file and the log for the password and finds neither

### Risk: Lockout used to block a user
- **Hazard:** anyone who knows a user's email address can keep them locked out
- **Affects:** Lock after repeated failures
- **Boundary:** repeated failed attempts from someone other than the owner
- **Severity:** medium
- **Guard:** a lockout ends on its own after 15 minutes and never becomes permanent
- **Check:** a test fails five times, waits 15 minutes on a fake clock, and signs in
"""

DESIGN = """# Design

## Context
The app has no accounts yet (see proposal.md). Routes live in `src/routes/`,
services in `src/services/`.

## Goals / Non-Goals
Goals: sign in, sign out, lockout. Non-goals: sign-up flows, password reset.

## Decisions

### Hash passwords with Argon2id
**Scope: local**

**Decision:** passwords are hashed with Bun's built-in `Bun.password` (Argon2id).

**Rationale:** no extra dependency, and a vetted algorithm.

**Alternatives considered:** bcrypt — needs a native module.

**Conforms to:** none

### Sessions in a signed cookie
**Scope: local**

**Decision:** a session id in a signed, HTTP-only cookie; sessions live in SQLite.

**Rationale:** signing out deletes the row, which ends the session at once.

**Alternatives considered:** JWT — cannot be revoked before it expires.

**Conforms to:** none

## Risks / Trade-offs
**Password stored readable** → Argon2id hashes only; the request logger skips bodies. Its guard test greps the database file and the log.

**Lockout used to block a user** → the lock is a timestamp, not a flag, and expires after 15 minutes. Its guard test uses a fake clock.
"""

TASKS = """# Tasks

## 1. Accounts and passwords

- [ ] 1.1 Add the accounts table migration — verify: `bun test test/auth/store.test.ts`
- [ ] 1.2 Hash and check passwords with `Bun.password` — verify: `bun test test/auth/password.test.ts`
- [ ] 1.3 Guard test: the password is in neither the database nor the log (guard: Password stored readable)

## 2. Sign in and out

- [ ] 2.1 Login route and form — verify: the "Correct password" and "Wrong password" scenarios pass
- [ ] 2.2 Sign-out route — verify: the "Sign out" scenario passes
- [ ] 2.3 Session expiry after 30 days — verify: the "Idle session" scenario passes

## 3. Lockout

- [ ] 3.1 Lock after five failures for 15 minutes — verify: the "Too many attempts" scenario passes
- [ ] 3.2 Guard test: a locked account can sign in again after 15 minutes (guard: Lockout used to block a user)
"""


def run(cmd: list[str], cwd: Path, env: dict[str, str]) -> None:
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, check=False)
    if r.returncode != 0:
        raise SystemExit(f"fixture: {' '.join(cmd)} failed:\n{r.stdout}\n{r.stderr}")


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def answer_foundation(project: Path) -> None:
    """Replace every placeholder the scaffold left with a fixed answer."""
    for doc in (project / "spec-tacular" / "foundation").glob("*.md"):
        out: list[str] = []
        heading = None
        for block in re.split(r"(^## .*$)", doc.read_text(), flags=re.MULTILINE):
            if block.startswith("## "):
                heading = block[3:].strip()
                out.append(block)
            elif heading in FOUNDATION:
                out.append(f"\n\n{FOUNDATION[heading]}\n\n")
            else:
                out.append(block)
        doc.write_text("".join(out).rstrip() + "\n")


def build(home: Path, stage: str, env: dict[str, str]) -> Path:
    if stage not in STAGES and stage != "empty":
        raise SystemExit(f"fixture: unknown stage {stage!r}")
    project = home / "my-app"
    project.mkdir(parents=True)
    env = {**env, **GIT_ENV}
    run(["git", "init", "-q", "-b", "main"], project, env)
    run(["openspec", "init", "--tools", "claude", "--no-animation", "."], project, env)
    if stage == "empty":
        run(["git", "add", "-A"], project, env)
        run(["git", "commit", "-qm", "Set up OpenSpec"], project, env)
        return project

    write(project / "openspec/specs/notes/spec.md", BASELINE_SPEC)
    write(project / "README.md", "# my-app\n\nA small notes app.\n")
    run(["git", "add", "-A"], project, env)
    run(["git", "commit", "-qm", "Notes app with OpenSpec"], project, env)
    upto = STAGES.index(stage)
    if upto == 0:
        return project

    run(
        ["bun", "run", str(REPO / "src/cli.ts"), "init", "--cwd", str(project)],
        REPO,
        env,
    )
    answer_foundation(project)
    if upto < STAGES.index("change"):
        return project

    change = project / "openspec/changes" / CHANGE
    write(change / ".openspec.yaml", "schema: spec-tacular\ncreated: 2026-01-15\n")
    files = [
        ("proposal", "proposal.md", PROPOSAL),
        ("specs", "specs/auth/spec.md", SPEC),
        ("risks", "risks.md", RISKS),
        ("design", "design.md", DESIGN),
        ("tasks", "tasks.md", TASKS),
    ]
    for name, rel, text in files:
        if STAGES.index(name) <= upto:
            write(change / rel, text)
    if stage == "implemented":
        done = TASKS.replace("- [ ]", "- [x]").replace(
            "(guard: ", "(shown red: fails with the mitigation removed) (guard: "
        )
        write(change / "tasks.md", done)
    return project


if __name__ == "__main__":
    import sys
    import tempfile

    stage = sys.argv[1] if len(sys.argv) > 1 else "tasks"
    home = Path(tempfile.mkdtemp(prefix="st-shots-"))
    print(build(home, stage, dict(os.environ, HOME=str(home))))
