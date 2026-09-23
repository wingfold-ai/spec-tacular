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

### Vision
A new project's way in, after the ground rules. The developer describes what
they are building in their own words — typed or pasted; an interview asks one
question at a time, each with its reason and, where natural, options with one
recommended ("What I understood so far" above it shows the model's reading);
it ends when the model has enough or the developer says so; then the vision is
split into 3–8 slices, reviewed as a checklist before anything is written. The
first kept slice becomes the first change. "Not a new project" leaves for a
single change and is never offered again.

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

What the TUI binds today (stages 5 to 8):

| Where | Keys |
| --- | --- |
| Start screen | `←`/`→`/`↑`/`↓`/`tab` choose a button · `enter`/`space` press it · click · `q` quit. A new project with its ground rules settled is offered "Describe your vision" (or "Continue your vision" once started) |
| Overview | `j`/`k`/`↑`/`↓` select a change (or click) · `←`/`→`/`tab` choose a next-step button · `enter` press it · `n` new change (refused until the ground rules are settled) · `w` let an agent draft the next artifact · `e` write it yourself in `$EDITOR` · `v` read the latest draft · `f` the ground rules, at the first open question · `r` review · `h` start screen · `?` help · `q` quit |
| Review | `a` accept · `r` reject (asks why; empty is allowed) · `d` defer (asks what would verify it; required) · `s` skip · `e` edit in `$EDITOR` at the item's line, then re-read (an edit after a decision is drift) · `m` then `1`–`9` mark a flagged value as an example · `n`/`j`/`↓` next · `p`/`k`/`↑` previous — `p` promotes instead on a global design decision · `?` help (any key closes it) · `q`/`ctrl+c` back to the overview, saved |
| Review prompt | type · `enter` confirm · `backspace` · `ctrl+u` clear · `ctrl+w` drop a word · `ctrl+c` cancel |
| Document | `↑`/`↓`/`j`/`k` scroll · `space`/`pagedown`, `pageup` a page · `g`/`G` top, bottom · wheel · `←`/`→`/`tab` choose a button · `enter` press it (or click) · `n` looks good (and draft the next artifact) · `e` edit in `$EDITOR` · `f` redraft with feedback · `q`/`ctrl+c` back |
| Ground rules: intro | `enter` begin (or click "▶ Begin") · `ctrl+c` back to the overview |
| Ground rules: a question | type an answer · `enter` save what is typed, pick the selected option, keep an answer that is there, or — empty, nothing chosen — ask for help (without an advisor it says to type or skip) · `↑`/`↓` choose a row (or click one: an option is picked, "?" asks for help) · `tab` skip, as does typing `skip`/`later`/`pass` · `?` on an empty line, or typing `help`/`not sure`/`idk`, asks for help · `←`/`→` previous, next question · `ctrl+e` the question in `$EDITOR` · `ctrl+d` dismiss a follow-up or simpler question as not relevant · `backspace` · `ctrl+u` clear · `ctrl+w` drop a word · `ctrl+c` back, saved |
| Ground rules: after an answer, while the advisor looks at it | `enter`/`tab` continue without waiting · `ctrl+c` back |
| Ground rules: done | `enter` continue — to the vision on a new project, else the overview · `←`/`↑` revisit the last answer · `ctrl+c` back (the same way) |
| Vision: describe | type, or paste (bracketed paste, line breaks kept) · `enter` continue (at least ten characters; without a model the description is saved as the vision and a single change is described next) · `ctrl+n` not a new project — describe a single change instead (or click the button) · `backspace` · `ctrl+u` · `ctrl+w` · `ctrl+c` back to the start screen |
| Vision: a question | `↑`/`↓` choose an option or "✎ Write my own answer" (or click: an option answers with it) · type, or paste · `enter` answer with what is typed or the selected option · `tab`, or typing `skip`/`pass`/`later`/`idk`/`not sure`, skips it · typing `done`/`enough`/`finish`, `ctrl+d`, or "That's enough — make the slices" ends the interview · `ctrl+c` back |
| Vision: the model is working | `ctrl+c` back (it keeps working; its answer is there when you return) |
| Vision: a request failed | `enter` ask again · `ctrl+c` back |
| Vision: the slices | `↑`/`↓`/`j`/`k` move (or click) · `space`/`x` keep or drop · `enter` write the roadmap and create the first slice's change · `ctrl+c` back |
| Redraft feedback | type · `enter` redraft (not when empty) · `ctrl+c` cancel |
| New-change prompt | type · `enter` next / create · `tab` next suggested name (the model's proposals arrive under the input — "✦ proposing a better name…", then "suggestions: … (tab cycles)" — and never overwrite a name you already edited) · `ctrl+u` clear · `ctrl+w` drop a word · `ctrl+c` cancel |
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
