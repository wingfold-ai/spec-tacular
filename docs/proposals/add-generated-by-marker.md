# Add a generated-by marker and a committed review record

## Why

Using spec-tacular leaves no trace in a project's history that only
spec-tacular leaves:

- Changes are created with plain `openspec new change`.
- The `schema: spec-tacular` pin in `.openspec.yaml` is written by plain
  OpenSpec too, once the config names the schema.
- The review decisions live only in `.spec-tacular/review/<change>.json`.
  That is a local-state folder, and nothing says whether it belongs in git.

This hurts in two ways. First, the mission's sign of value cannot be
measured: it is public repos, not ours, with commits to spec-tacular's files
in at least 3 of the last 6 weeks, at least 5 of them by 31 March 2027.
Second, what a human accepted, rejected or deferred is the one thing
spec-tacular adds to OpenSpec, and it is the first thing lost when someone
stops using it or clones the repo elsewhere.

Users in the OpenSpec issues ask for exactly this record. A "not now"
"lives only in the chat"
([#1907](https://github.com/Fission-AI/OpenSpec/issues/1907)), and agents
defer work without surfacing it
([#1529](https://github.com/Fission-AI/OpenSpec/issues/1529)).

## What Changes

### One marker

- **The marker is one fixed string: `generated-by: spec-tacular`.** The same
  string goes in every file, so one GitHub code search finds them all:
  `"generated-by: spec-tacular"`.
- **In Markdown it is a first-line HTML comment:**
  `<!-- generated-by: spec-tacular 0.4.0 -->`. GitHub shows nothing of it,
  while YAML front matter would render as a table at the top of every ADR.
  OpenSpec 1.14.0 accepts it in proposals and in delta specs, so one form
  works everywhere. In YAML files it is a first-line comment:
  `# generated-by: spec-tacular 0.4.0`.
- **The version is written when the file is created, and never rewritten.**
  An upgrade must not touch every file in a user's repo. The version tells
  us which release created a file, which is enough to measure with.
- **The marker never counts as content.** `hashDocument` and every parser
  skip the marker line. Adding it, or having a different version in it,
  never makes a signed-off document drift. A marker added to an existing
  file never re-opens its review.

### The files that carry it

The marker goes on the files spec-tacular writes itself:

| File | Written in | When |
|---|---|---|
| `spec-tacular/decisions/NNNN-*.md` (ADRs) | `promoteDecision` in `src/core/decisions.ts` | created or promoted; the existing `**Origin:** change` line stays |
| `spec-tacular/foundation/*.md` | `scaffoldFoundation` in `src/core/foundation.ts` | scaffolded |
| `spec-tacular/vision.md` | `finalizeVision` in `src/core/vision.ts` | written |
| `spec-tacular/roadmap.yaml`, `spec-tacular/glossary.yaml` | `roadmap.ts`, `formal/glossary.ts` | created |
| hazard register, harness mappings, matrices | `hazards.ts`, `formal/files.ts` | created |
| `openspec/changes/<id>/review.md` | new, see below | every review decision |

The agent-drafted OpenSpec artifacts are left out of the first cut: the
proposal, specs, risks, design and tasks. Agents drop template lines, and the
review record already marks every change. If measuring shows one marked file
per change is too few, a later change can stamp them after each drafting
job.

### A review record that travels with the change

- **`openspec/changes/<id>/review.md`, written from the review state.** It is
  regenerated on every `saveReview`, so it never disagrees with the JSON. It
  lists:
  - the documents accepted whole;
  - every item with its outcome:
    - **Accepted:** requirements, risks, decisions, questions with their
      answers, and harness bindings;
    - **Rejected:** with the reason;
    - **Deferred:** with what it waits for;
  - the revision notes;
  - the waivers and allowed survivors, with their reasons.
- **The record is deterministic.** It is sorted the way the review queue is,
  has no timestamps beyond the decision dates already stored, and has no
  absolute paths. The same decisions always give the same file, so it shows
  up in diffs only when a decision changed.
- **The archive step writes it once more before `openspec archive` moves the
  folder.** It then sits in `openspec/changes/archive/<date>-<id>/review.md`
  and stays readable with plain OpenSpec and git, without spec-tacular.
  OpenSpec 1.14.0 validates a change with an extra `review.md` and archives
  it along with the rest; this was checked by hand and becomes a test.
- **The JSON stays the source of truth for the TUI.** `review.md` is written
  from it and never read back. Hand edits to it are overwritten, and the
  file says so in a second comment line.

### What is committed, and what is not

- **Today spec-tacular says nothing about git.** It writes a `.gitignore`
  only for the tabs' session scripts. Whether `.spec-tacular/review/` ends up
  committed depends on the user.
- **`init` adds `.spec-tacular/.gitignore`.** It ignores the machine-local
  files:
  - `jobs/`, `usage.jsonl`, `vision-session.json`, `implementing/`, the tab
    scripts, `foundation-advice.json`, `stops/` and `junit.xml`;
  - **one of these two, chosen as open question 1:** the review JSON,
    `evidence/` and the harness `*.allowed.json`, or none of them.
- **A check in `spec-tacular doctor`, or at startup, if no doctor exists.**
  It reports when `spec-tacular/`, `openspec/changes/` or a change's
  `review.md` is git-ignored.
- **The README says what is committed and why:** the review record is how the
  decisions outlive the tool.

### Measuring

- This part lives outside the code, in the maintainer's notes. One note gives
  the code search, and how to count repos with commits to marked files in at
  least 3 of the last 6 weeks, leaving out the maintainer's own. The weekly
  OpenSpec-issues watch task gets this count as a second step.

## Capabilities

### New Capabilities

- `review-record`: the committed per-change review record. It covers what
  it contains, when it is written, that it is deterministic, and that it
  moves into the archive with the change.

### Modified Capabilities

- `decisions`, `foundation`, `vision`, `roadmap`, `glossary`, `hazards`:
  files are created with the marker.
- `review` (signoff): the marker line is not content for hashing.
- `init`: writes `.spec-tacular/.gitignore` for machine-local state.
- `archive`: writes the review record before OpenSpec moves the change.

## Impact

- **New module:** `src/core/provenance.ts`. It holds:
  - the marker for Markdown and YAML;
  - `withMarker(content, kind)` to add it, idempotent;
  - `stripMarker(content)`, used by `hashDocument` and the parsers.
- **New module:** `src/core/review-record.ts`, which renders `review.md`
  from a `ChangeReview` and the reconciled items. It is called from
  `saveReview` and from `archiveChange`.
- **Touched:**
  - `decisions.ts`, `foundation.ts`, `vision.ts`, `roadmap.ts`,
    `formal/glossary.ts`, `formal/files.ts`, `hazards.ts`: the create paths;
  - `signoff.ts` (`hashDocument`) and `markers.ts`;
  - `init.ts`, `archive.ts`, `cli.ts` (archive), README.
- **Compatibility:**
  - Files from before the change keep working without the marker, and are
    not rewritten.
  - A test checks `openspec validate --strict` and `openspec archive` with
    the marker and `review.md`, against the supported OpenSpec version.
- **Tests:**
  - The marker is added once.
  - The parsers ignore it: the ADR title is still read from `# ADR-…`, and
    foundation items are unchanged.
  - The signoff hash is the same with and without the marker.
  - `review.md` is the same for the same decisions, and changes when a
    decision changes.
  - `review.md` ends up in the archive.
  - The gitignore keeps `spec-tacular/` and `review.md` tracked.

## Open questions

1. **Do the review JSON, `evidence/` and the harness allowances get
   committed?**
   - **Committing them** keeps the full assurance record: the evidence is an
     append-only log, and the allowances carry checked reasons. The cost is
     a noisier diff.
   - **Ignoring them** keeps `review.md` as the only committed record.
     Evidence then lives on one machine.
   - **Proposed:** commit `review/` and the harness allowances, which are
     small and record decisions. Ignore `evidence/`, and summarise its
     latest result per item in `review.md`.
2. **Does the marker go on every file, or only on the review record?** It
   must go on at least one file per change to measure. Putting it on ADRs
   and foundation files as well also catches projects that use only the
   ground rules.
3. **Is the version in the marker worth it?** It helps tell releases apart
   in the count. It also means a file written by 0.4.0 still says 0.4.0
   after an upgrade. The search works either way.

**Done when** a new project reviewed with spec-tacular has, in committed
files:

- marked ADRs and foundation files;
- a marked `review.md` per change, also in the archive.

`openspec validate --strict` must still pass, and a GitHub code search for
`"generated-by: spec-tacular"` must find the files.

## As implemented

- **The marker.** `src/core/provenance.ts` holds `markerLine`, `withMarker`,
  `stripMarker` and `readPrevious`.
  - It is wired into ADRs, foundation scaffolds, `vision.md`, the roadmap,
    a newly created glossary and the hazard entries. A file regenerated
    whole keeps the marker it had.
  - `hashDocument` strips it.
  - Matrices are JSON and carry no marker.
- **The review record.** `src/core/review-record.ts` has `renderReviewRecord`
  and `writeReviewRecord`.
  - It is written after every save: TUI review sessions, documents accepted
    in the TUI, `harness --accept` and `diff --accept`.
  - It is written once more in `archive`, before deferred requirements are
    stripped from the specs.
  - It lists documents accepted as a whole; items accepted, rejected,
    deferred and not decided yet; allowed survivors; waivers; and, at
    archive, each item's evidence.
- **Open question 1 was settled as proposed.** `.spec-tacular/.gitignore`
  ignores everything except `review/*.json` and `harness/*.allowed.json`.
  The evidence log stays local, summarised in the record at archive.
- **The ignored-records check runs at `init`**, which spec-tacular also runs
  on first start: `ignoredRecords` uses `git check-ignore`. There is no
  separate `doctor` command.
- **Tests** are in `test/provenance.test.ts`. One of them runs the real
  `openspec` 1.14.0: `validate --strict` passes, and `review.md` arrives in
  the archive.
- **Still to do:**
  - the measurement note in the maintainer's notes;
  - adding the count to the weekly watch task.
