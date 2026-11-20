---
title: spec-tacular — review every requirement before your agent builds it
seoTitle: spec-tacular · Spec-driven development you stay in control of
description: A terminal UI on top of OpenSpec. Accept, reject or defer every requirement your coding agent writes, one key at a time. Design and tasks are drafted only from what you accepted, and your agent implements those tasks. Works with Claude Code and opencode.
---

::hero-section
---
eyebrow: Spec-driven development for coding agents
title: Your agent writes the spec.
titleAccent: You decide what gets built.
lead: spec-tacular is a terminal UI on top of OpenSpec. It puts every requirement your agent proposes in front of you, one at a time. Accept, reject or defer it with one key. Design and tasks are drafted only from what you accepted, and your agent implements those tasks.
worksWith: Works with Claude Code and opencode · built on OpenSpec · MIT
primary: { label: Install, to: '#install' }
secondary: { label: See how it works, to: '#how-it-works' }
---
  :::review-demo
  ---
  change: add-export
  total: 12
  startAccepted: 7
  startRejected: 1
  startDeferred: 1
  requirements:
    - capability: export
      title: Export own data
      text: The system SHALL let a signed-in user download all of their own expenses as a CSV file.
      scenarios:
        - { name: User exports their data, when: the user requests an export, then: the file contains every expense they created and nothing else }
    - capability: export
      title: Export completes promptly
      text: The export SHALL complete promptly, even for large accounts.
      scenarios:
        - { name: Large account, when: a user with many expenses exports, then: the export finishes quickly }
      flag: 'undefined words: promptly, large, many, quickly — how much, how soon, compared to what?'
      revisable: true
    - capability: export
      title: Keep finished exports
      text: The system SHALL write each finished export to the user_exports table and keep it for 30 days.
      scenarios:
        - { name: Export is kept, when: a user opens their export link within 30 days, then: the file downloads }
      flag: 'names a field or table: "user_exports". Is that the contract, or an example?'
  revision:
    note: name a limit
    text: The export SHALL complete within 10 seconds for accounts with up to 50,000 expenses.
  ---
  :::
::

:::page-section
---
id: problem
eyebrow: The problem
title: Vibe coding hands every decision to the agent. Specs alone don't hand them back.
lead: Writing specs first is the right instinct. But when the agent writes them too, the bottleneck moves to review, and review is where it quietly breaks down.
---
  ::problem-list
  ---
  items:
    - title: More spec than anyone can review
      text: Agents write requirements faster than people read them. So you either read everything or skim everything, and approve it anyway. The agent then builds things nobody really agreed to.
    - title: Specs and design written in one pass
      text: Proposal, specs, design and tasks often arrive together. Fix a requirement during review and the design written from the old version is already stale. The contradictions surface while the agent is building.
    - title: No ground to stand on
      text: A new project starts without a settled stack, architecture or conventions. Every change makes its own assumptions, and the agent picks patterns as it goes.
  ---
  ::
:::

:::page-section
---
id: how-it-works
eyebrow: How it works
title: A pipeline where nothing moves until you accept it
lead: 'In spec-driven development the agent writes down what it will build before it builds it, and you check that text first. spec-tacular takes OpenSpec''s change documents, puts them in a strict order and adds a human gate to each: an agent drafts, you decide, and only then the next document is drafted from what you accepted. A fix made in review flows forward instead of leaving stale documents behind.'
---
  ::pipeline-flow
  ---
  terms:
    - term: change
      text: "One unit of work, such as \"add user login\". In OpenSpec it is a folder, openspec/changes/add-user-login/, that holds every document about it."
    - term: artifact
      text: "One document of a change: the proposal, the specs, the risks, the design or the tasks. Plain Markdown, in git."
    - term: requirement
      text: "One testable statement in a spec: \"The system SHALL …\". Each comes with scenarios, WHEN … THEN …, that say how you would check it."
    - term: gate
      text: "The point where a stage waits for you. A file that exists is only written; it counts once you accepted it."
    - term: baseline
      text: "openspec/specs/: the accepted requirements of every finished change. The current, written-down truth about your system."
    - term: agent
      text: "Claude Code or opencode. It drafts the artifacts and writes the code; spec-tacular decides what it gets to see and when."
  before:
    - label: Vision
      scope: new projects only
      text: Say what you are building and for whom, in your own words. An AI interview fills the gaps, then proposes a roadmap of small slices.
      what: "A short description of the product, sharpened by an interview: one question at a time, with suggested answers to pick from. From it the agent proposes 3–8 slices in build order, the first being the smallest thing a user can do end to end."
      you: "Write a few sentences, answer the questions, then reshape the roadmap: drop a slice (space), merge it with the next (m), move it (shift+↑↓) or reword it (e)."
      why: "Agents build better from a goal than from a feature list, and small slices keep every later spec small enough to review properly. Saved in spec-tacular/vision.md and roadmap.yaml. Every agent reads both, including which slice its change is, so it builds on earlier slices and leaves later ones alone."
    - label: Ground rules
      scope: once per project
      text: Domain, stack, architecture and conventions, settled before the first change. On a new project they are proposed from your vision and mostly confirmed with enter.
      what: "Questions about the project, one at a time: what the system is for and its core terms, the language, framework and datastore, the architecture style, where business rules live, naming, and what a test must cover. Choose an architecture style and its layer rules come with it."
      you: "Confirm or change each proposed answer (marked ⇐, enter confirms). On a new project only one question has to be answered on day one; eight more are marked Decide later and wait until a change needs them."
      why: "Without them every change makes its own assumptions and the agent picks the stack and patterns as it goes. Saved in spec-tacular/foundation/; every agent reads them before it drafts anything."
  stages:
    - key: proposal
      label: Proposal
      artifact: proposal.md
      gate: Accepted as a whole
      text: Why this change, what it changes, and a boundary of the paths it expects to touch.
      what: "A short document: the motivation, what changes, which capabilities it adds or modifies, its impact, and a ## Boundary that lists the folders and files the change should touch."
      you: "Read it and accept it (a), send it back with a note so the agent redrafts it (r), or edit it yourself in $EDITOR (ctrl+e)."
      why: "It is the cheapest place to say \"not this\" or \"smaller\". Everything after it is drafted from this text, so a wrong scope caught here never turns into specs, design or code."
    - key: specs
      label: Specs
      artifact: specs/*.md
      gate: Accepted requirement by requirement
      text: The behaviour the change promises, as requirements with scenarios, reviewed one at a time.
      what: "The requirements this change adds or modifies, in OpenSpec's format: \"The system SHALL …\" plus scenarios such as WHEN a user fails to sign in five times THEN further attempts are refused for 15 minutes. spec-tacular flags vague words (\"quickly\", \"several\"), happy-path-only scenarios and premature details like a named endpoint."
      you: "One requirement per screen: accept (a), reject (x, it asks why), defer (d, it asks what would verify it later), or revise just this one requirement with the agent (r) and read the diff before it is written."
      why: "This is the contract the code will be built and tested against. Reviewing one requirement at a time makes it a real decision instead of a skim, and the design is refused while any requirement is still unreviewed."
    - key: risks
      label: Risks
      artifact: risks.md
      gate: Accepted one risk at a time
      text: What this change could break, and how each danger will be guarded and tested.
      what: "Each risk names a hazard (what could go wrong), its severity, the guard that prevents it, and the test that proves the guard works. Example: \"an export leaks other users' data\", guarded by filtering on the caller, tested with two users."
      you: "Review each risk in the same queue as the specs: accept, reject or defer it."
      why: "Agents are good at the happy path and tend to miss what must not happen. Naming risks before the design means the design has to deal with them, instead of someone noticing in production."
    - key: design
      label: Design
      artifact: design.md
      gate: Accepted as a whole
      text: How it will be built, drafted only from the specs and risks you accepted.
      what: "The technical approach and its decisions: modules, data, interfaces, trade-offs. It must answer every accepted risk by name, except one you accepted as knowingly unmitigated; one it leaves out is flagged. Its decisions also join the review queue, where one marked Scope: global can be promoted to a project-wide ADR (p)."
      you: "Read it and accept it, redraft it with feedback, or edit it."
      why: "Because it is written only after the specs are settled, a requirement you changed in review flows into it, instead of leaving an outdated design that contradicts the specs while the agent builds."
    - key: tasks
      label: Tasks
      artifact: tasks.md
      gate: Accepted as a whole
      text: The plan as a checklist the agent works through, with a guard task for every risk.
      what: "Small, ordered steps the agent ticks off. For each mitigated risk there is a guard task, (guard: <risk>): write the test, then show it fails with the mitigation removed, and record how (shown red: …). A task that needs a deployed environment is marked (defer: …), so it doesn't hold up archiving."
      you: "Check the plan is complete and in a sensible order, then accept it."
      why: "A test that has never failed proves nothing. Requiring each guard to be shown red first means the safety checks really test something. A guard ticked off without that record stays flagged."
    - key: implement
      label: Implement
      artifact: your code
      gate: You watch it tick
      text: Your agent builds the accepted tasks in a terminal tab of its own; spec-tacular follows along.
      what: "\"Implement it in Claude Code\" opens your agent in a new terminal tab or window with the accepted tasks as its prompt. In Claude Code, the project's test command, the usual JS/TS checkers and read-only OpenSpec and git commands run without asking; everything else follows your usual permission mode."
      you: "Watch or step in as you would in any agent session. spec-tacular shows how many tasks are ticked off, and flags files changed outside the proposal's boundary."
      why: "The agent works from what you accepted, not from a chat history. The boundary check is advisory: only you can tell whether reaching further was right, but you see that it happened."
    - key: archive
      label: Archive
      artifact: openspec/specs/
      gate: Accepted requirements merge
      text: The finished change's requirements become part of the baseline; anything deferred stays on record.
      what: "Archiving (A, then enter) merges the change's accepted requirements into openspec/specs/. Deferred ones go to spec-tacular/pending-validation.md with what would verify them, and review.md, the record of every decision, moves into the archive with the change."
      you: "Check the preview, which also says if something still blocks archiving, and confirm."
      why: "The next change is proposed against an up-to-date description of the system, and nothing you deferred is silently forgotten."
  note: 'Accepting starts nothing by itself: you decide when the next artifact is drafted (w). Edit or redraft an accepted text and it is marked to be read again.'
  ---
  ::
:::

:::page-section
---
id: review
eyebrow: The review loop
title: One requirement on screen. One key to decide.
lead: Review is the part most spec tools leave to your editor. In spec-tacular it is the main screen. Your attention goes into deciding, not into scrolling Markdown or prompting fixes.
---
  ::feature-grid
  ---
  columns: 2
  items:
    - { keys: [a], title: Accept, text: The requirement moves on. Your acceptance holds for the exact text you read. }
    - { keys: [x], title: Reject, text: 'You are asked why, and the reason is kept with the change.' }
    - { keys: [d], title: Defer, text: 'Not now. It asks what would verify it, so the requirement waits with a reason instead of being lost.' }
    - { keys: [r], title: Revise with AI, text: 'Leave a short note. The agent rewrites only that requirement, you see the diff, and only that block changes.' }
  ---
  ::

  ::feature-grid
  ---
  columns: 3
  compact: true
  items:
    - { icon: i-lucide-triangle-alert, title: Vague words get flagged, text: '"promptly", "gracefully" and happy-path-only scenarios are marked before you accept them.' }
    - { icon: i-lucide-git-compare, title: Drift is detected, text: 'Edit or redraft an accepted text and it waits to be read again.' }
    - { icon: i-lucide-octagon-x, title: Contradictions stop the agent, text: 'If two accepted requirements conflict, the agent writes a stop report instead of designing around it.' }
  ---
  ::
:::

:::page-section
---
id: features
eyebrow: Built in
title: The rest of what keeps you in control
band: true
---
  ::feature-grid
  ---
  columns: 3
  items:
    - { icon: i-lucide-compass, title: Foundation and ADRs, text: 'Stack, architecture and conventions are asked before the first change, and any of them can be left for later. Pick an architecture style and its layer rules come with it. Cross-cutting decisions are promoted to global ADRs.' }
    - { icon: i-lucide-map, title: Roadmap in slices, text: 'A new project is cut into 3–8 small changes, smallest end-to-end slice first. Small changes keep specs small enough to review.' }
    - { icon: i-lucide-shield-check, title: Risks guarded by tests, text: 'Every accepted risk gets a guard task, unless you accept it as knowingly unmitigated. The agent must record its test failing without the mitigation; a guard ticked off without that record stays open. Archived risks become a hazard register.' }
    - { icon: i-lucide-square-dashed, title: A boundary per change, text: 'The proposal lists the paths it expects to touch. Files changed outside it are flagged.' }
    - { icon: 'i-lucide-terminal', title: 'Your agent, inside the TUI', text: 'Drafts are written in the background while you keep reviewing. Implementing opens Claude Code or opencode in a new tab or window.' }
    - { icon: i-lucide-list-checks, title: Evidence you can run in CI, text: 'Tests tagged with a requirement or risk build a verification matrix. spec-tacular evidence and hazards exit non-zero while something is unverified or failing, so CI can gate on them.' }
  ---
  ::

  ::terminal-block
  ---
  title: what spec-tacular tells you
  lines: |
    $ spec-tacular --print
    risks: 2/2 accepted
    ! the design does not answer risk "Export leaks other users"
    ! guard ticked off without being shown red: "Export leaks other users"
    ! 1 file changed outside the boundary: lib/oops.ts

    $ spec-tacular archive add-export
    1 requirement(s) merge into the baseline
    1 divert to pending validation
      data-export: Export completes against a deployment — a deployed instance to run against
    Hazard register:
      added HAZ-0001 from risk "Export leaks other users"
      added HAZ-0002 from risk "Huge export"

    $ spec-tacular hazards; echo "exit $?"
    HAZ-0001  unverified  high     Export leaks other users
               guard never run: [risk:add-export#export-leaks-other-users]
    HAZ-0002  unmitigated low      Huge export
               out of scope until pagination
    exit 1
  ---
  ::
:::

:::page-section
---
id: repo
eyebrow: Plain files, in git
title: Everything lands in your repo
lead: spec-tacular works in the same openspec/ folder you already have. Your review decisions are kept next to the change, so they go through pull requests like everything else. Stop using spec-tacular and you still have plain OpenSpec.
---
  ::file-tree
  ---
  tree: |
    openspec/
      changes/add-export/
        proposal.md
        specs/export/spec.md
        risks.md
        design.md
        tasks.md
        review.md
      specs/
    spec-tacular/
      vision.md
      roadmap.yaml
      foundation/
        domain.md
        stack.md
        architecture.md
        conventions.md
      decisions/0001-errors-are-values.md
      hazards/0001-export-leaks-other-users.md
      pending-validation.md
  notes:
    - { path: review.md, note: 'what you accepted, rejected and deferred, and why' }
    - { path: specs/, note: 'the accepted baseline, plain OpenSpec' }
    - { path: foundation/, note: ground rules every agent reads }
    - { path: decisions/0001-errors-are-values.md, note: "a decision promoted from a change's design to a global ADR" }
  ---
  ::
:::

:::page-section
---
id: compare
eyebrow: Compared
title: Where spec-tacular fits
lead: spec-tacular is not a new spec format. It is the review surface and the gates on top of OpenSpec, inside the agent you already use.
---
  ::compare-table
  ---
  columns: [Prompting, OpenSpec alone, Spec Kit, Kiro, spec-tacular]
  highlight: 4
  rows:
    - label: Specs before code
      cells: [no, yes, yes, yes, yes]
    - label: Accept, reject or defer single requirements
      cells: [no, no, no, { state: partial, text: comments per passage }, yes]
    - label: Next artifact waits for your acceptance
      cells: [no, { state: no, text: 'moves on once the file exists' }, { state: partial, text: separate steps }, { state: yes, text: approval per phase }, { state: yes, text: enforced }]
    - label: Project foundation before the first change
      cells: [no, { state: partial, text: config.yaml context }, { state: yes, text: constitution }, { state: yes, text: steering files }, { state: yes, text: ground rules + ADRs }]
    - label: Keeps your Claude Code or opencode setup
      cells: [yes, yes, yes, { state: no, text: own agent }, yes]
    - label: Works on an existing OpenSpec project
      cells: [na, yes, { state: no, text: switch tools }, { state: no, text: switch tools }, yes]
  note: Checked in November 2026 against each tool's own documentation. These tools change quickly; if a row is out of date, open an issue.
  ---
  ::
:::

:::page-section
---
id: evidence
eyebrow: Evidence, not promises
title: One scenario, run from an empty folder to reviewed code
lead: 'We test spec-tacular by having an AI play a new user: it builds a small expense-splitting API with known traps (floats, the lost cent, payers outside the split) and scores the result.'
---
  ::evidence-table
  ---
  stats:
    - { value: '34', label: requirements reviewed one by one }
    - { value: '167 / 0', label: tests passing / failing }
    - { value: 9 of 9, label: 'known pitfalls handled, 8 raised unprompted' }
    - { value: ~47 min, label: from empty folder to implemented }
  highlight: 'Reading requirement by requirement, the reviewer caught a wrong balance in the agent''s own scenario ("2.00" where it had to be "-4.00"), rejected it and had it revised, before any code was written.'
  caveat: 'Single runs on a small app, played and scored by an AI evaluator. They show what the workflow does, not a statistical result. This run (October 2026) used an earlier build, before the vision interview, the risks stage and archiving in the TUI; its report is in the repository under evals/results/.'
  ---
  ::
:::

:::page-section
---
id: install
eyebrow: Install
title: Running in your project in four steps
lead: 'A single binary for Linux and macOS (x64 and arm64). It needs no Bun or Node of its own, only the OpenSpec CLI and your agent. The quickstart in the docs walks you from here to a first accepted change.'
---
  ::install-steps
  ---
  steps:
    - { title: Install OpenSpec, command: npm i -g @fission-ai/openspec, text: 'Version 1.11 or newer; OpenSpec 2 works too.' }
    - { title: Install spec-tacular, site: true, text: 'Picks the build for your OS and CPU, checks it against the release checksums, installs to ~/.local/bin.' }
    - { title: Set up OpenSpec in your project, command: openspec init, text: 'Pick the agent you will drive: Claude Code (the default) or opencode.' }
    - { title: Open the TUI, command: spec-tacular, text: 'A start screen walks you through vision, ground rules and your first change. Press ? there or on the overview for every key. For opencode, start it with --driver opencode.' }
  ---
  ::

  ::docs-link{to="/docs/getting-started/quickstart" label="Quickstart: your first reviewed change" hint="every step, from install to an accepted change"}
  ::
:::

:::page-section
---
id: faq
eyebrow: FAQ
title: Questions developers ask first
---
  ::faq-list
  ---
  items:
    - q: Does it replace OpenSpec?
      a: No. spec-tacular drives the OpenSpec CLI and keeps its format and folder layout. It installs its schema into openspec/schemas/, writes a review.md into each change, and keeps everything else in spec-tacular/ (plus local state in .spec-tacular/). Remove spec-tacular and your specs and change history are still plain OpenSpec.
    - q: Which coding agents does it work with?
      a: Claude Code (the default) and opencode (start with --driver opencode, and pick the same agent in openspec init). Drafting runs in the background; implementing opens your agent in a new tab (tmux, kitty, WezTerm, GNOME Terminal, Konsole or iTerm) or, where the terminal can't open one, a new terminal window.
    - q: Does my code leave my machine?
      a: spec-tacular itself runs locally and talks to no model directly. Your agent talks to its model provider as it always does. With Claude Code, the background drafting agents load your MCP servers by default and may call their tools without asking; set SPECTACULAR_NO_MCP to turn that off, or SPECTACULAR_MCP_DENY to block single servers.
    - q: Can I use it on an existing project?
      a: "Yes, and existing OpenSpec projects are the main case. spec-tacular works in the openspec/ folder you already have, so your specs and change history stay as they are. Before the first change it asks for the project's ground rules (what the system is for, its stack, architecture and conventions), one question at a time; any question can be left for later. Then you describe a change and review it like any other."
    - q: Can my team use it?
      a: Every decision is written to review.md in the change folder, so it is reviewed in pull requests with the rest of the change. Several people reviewing the same change at once is not built yet.
    - q: What does it cost?
      a: spec-tacular is free and MIT licensed. You pay for your agent's model usage as usual; a sidebar shows the model, the drafting cost so far and the current step.
    - q: Is it ready?
      a: 'It is at v0.5.0 and in early access: the repository opens to the public with the launch. Linux and macOS today, no Windows build yet.'
  ---
  ::

  ::docs-link{to="/docs" label="Read the docs" hint="guides, keys, commands and configuration"}
  ::
:::

::cta-banner
---
title: Stop skimming. Start deciding.
text: Put the next change your agent proposes through spec-tacular and see what you actually agree to.
---
::
