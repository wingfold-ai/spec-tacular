# TUI design

Borrowed from opencode: persistent hierarchy cues, a detachable pane for
background work, and everything reachable from the keyboard.

## The constant frame

Two regions never disappear, on any screen. They are the answer to "I want a
clear overview always visible of which stage I'm in and what's accepted".

```
┌ spec-tacular ─ my-project ─────────────────────────── 3 changes · 1 job ──┐
│ ▸ foundation ✓  roadmap ✓  proposal ✓  SPECS ●  design ○  tasks ○  apply ○ │  ← pipeline bar
├───────────────────────────────────────────────────────────────────────────┤
│ my-project › add-dark-mode › specs › theme-selection                      │  ← breadcrumb
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│                            (screen body)                                  │
│                                                                           │
├───────────────────────────────────────────────────────────────────────────┤
│ ⣾ apply · add-export  2m14s          specs 17/42 · 3✗ · 2⏸      ? help     │  ← status
└───────────────────────────────────────────────────────────────────────────┘
```

Stage markers: `✓` accepted · `●` in review · `○` not started · `⊘` blocked ·
`!` drifted since acceptance.

The pipeline bar shows stages for the **active change**; the Foundation and
Roadmap segments are project-level and shared.

## Screens

### Dashboard
Changes with stage, acceptance progress bar, blocked reason. Roadmap slices not
yet promoted. Deferred-requirement count. `Enter` opens a change.

### Review — the primary screen
One requirement, full width, with its scenarios. Nothing else competes for
attention.

```
  specs › theme-selection                              requirement 18 of 42

  Requirement: Theme selection
  The app SHALL let users switch between light and dark themes, defaulting
  to the system preference.

    Scenario: User toggles dark mode
      WHEN  the user clicks the theme toggle
      THEN  the app switches to dark mode and persists the choice

  ⚠ concreteness: "the theme toggle" is unspecified UI. Contract or example?

  ████████████░░░░░░░░░░░░░░░  17 accepted · 3 rejected · 2 deferred

  a accept   r reject   e edit   d defer   s skip   n/p move   q back
```

### Design review
Decision-by-decision rather than requirement-by-requirement. Adds `p` — promote
to a global ADR.

### Jobs
Running and finished jobs, streamed output, cancel. `Ctrl-J` toggles it as an
overlay from anywhere, so you can glance at an `apply` mid-review without losing
your place in the queue.

### Decisions
Global ADRs: browse, supersede, see which changes reference each one.

### Pending validation
Deferred requirements, why, what would verify them, which change they came from.
Verify one here and it merges into the main specs.

## Keybindings

| Key | Action |
| --- | --- |
| `a` `r` `e` `d` `s` | accept · reject · edit · defer · skip |
| `m` then `1`–`9` | mark a flagged value as an example, not a contract |
| `n` `p` | next · previous requirement |
| `p` | promote a global decision to an ADR; on any other item, previous |
| `g` then `d`/`r`/`j`/`k`/`v` | go to dashboard · review · jobs · decisions · pending validation |
| `ctrl+j` | toggle the job overlay, from anywhere — the start screen, the overview, mid-prompt, mid-review |
| `x` | cancel the selected job (asks first) |
| `Enter` | descend the hierarchy (a change → its review queue) |
| `ctrl+c` | cancel a prompt, close an overlay, or go back one level — **never quits**; where there is nothing left to cancel it says that `q` quits |
| `?` | context-sensitive help |
| `q` | back, or quit at the top level (the start screen and the overview) |

What the shell (stage 5) binds today:

| Where | Keys |
| --- | --- |
| Start screen | `←`/`→`/`↑`/`↓`/`tab` choose a button · `enter`/`space` press it · click · `q` quit |
| Overview | `j`/`k`/`↑`/`↓` select a change (or click) · `←`/`→`/`tab` choose a next-step button · `enter` press it · `n` new change · `w` let an agent draft the next artifact · `e` write it yourself in `$EDITOR` · `f` the ground rules · `r` review · `h` start screen · `?` help · `q` quit |
| New-change prompt | type · `enter` next / create · `tab` next suggested name · `ctrl+u` clear · `ctrl+w` drop a word · `ctrl+c` cancel |
| Help | any key closes it |
| Job pane | `j`/`k`/`↑`/`↓` select (or click) · `x` cancel the selected job, then `y` · `p` clear finished jobs · `q`/`ctrl+c`/`ctrl+j` close |

`g`-prefixed chords come from `@opentui/keymap`, matching opencode's leader-key
feel. All bindings are remappable from config.

**Not `escape`.** A lone ESC is the prefix of every escape sequence, so a
terminal parser cannot deliver it until it sees what follows — pressed alone it
yields no event at all, and pressed before `x` it arrives as alt-x. `ctrl+c` is
the cancel that always works. `escape` is still handled for terminals that
resolve it, but no interaction may depend on it.

## Principles

1. **One decision on screen at a time.** The failure mode being fixed is a wall
   of requirements; recreating it in a TUI would fix nothing.
2. **State is always visible.** Stage and acceptance counts never leave the
   frame.
3. **Nothing blocks.** Background work is normal. The UI is event-driven, never
   a prompt loop.
4. **Keyboard first.** Mouse optional. Review is a flow; reaching for a mouse
   breaks it.
5. **Honest state.** Anything that drifted since you accepted it says so, loudly.
   A review tool that lies about what was reviewed is worse than no review tool.
