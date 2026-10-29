# Add a project hazard register

## Why

A change's risks live and die with the change. Once it is archived, the next
change touching the same capability starts from nothing and has to rediscover
the same hazards, or misses them. Design decisions had this problem and got
ADRs; hazards have it too. NASA keeps every hazard in a Hazard Tracking System
with its causes, controls, verification and status, across the whole life of
the system, and a mitigation counts as done only when its verification is
independently confirmed. Proof keeps "hazard knowledge" so each new change
starts with it attached.

## What Changes

- **A project hazard register** under `spec-tacular/`, one entry per hazard:
  description, causes, the capabilities and requirements it threatens,
  severity, the controls that mitigate it (the requirements and decisions),
  how each control is verified (the guard tests), the residual risk, and a
  status — open, mitigated, unmitigated (with why), closed.
- **Risks are promoted, like decisions to ADRs**: at archive, each accepted
  risk of a change either joins the register or updates an existing entry,
  with its guard tests as the entry's verification. A risk naming an existing
  hazard links to it instead of copying it.
- **Every risks draft starts from the register**: the agent writing a change's
  risks is given the hazards on the capabilities the change touches, and must
  say for each whether the change affects it. A change that weakens a control
  of an open or mitigated hazard says so as a risk.
- **Status follows the evidence**: a hazard is mitigated only while its guard
  tests are passing (add-verification-evidence); a failing or stale guard
  sends it back to open, visibly.
- **Defects feed it**: a defect change (add-defect-changes) that reveals a
  new way something could go wrong adds a hazard, so the lesson is kept where
  the next change will see it.
- **Kept alive**: an entry not looked at for a set period {{example: 3
  months}} is listed as due for review; `spec-tacular hazards` prints the
  register over a pipe and in CI.

## Capabilities

### New Capabilities

- `hazard-register` — the register, promotion of risks into it, its use when
  drafting risks, status from evidence, and review dates.

### Modified Capabilities

None yet (no baseline specs). Extends `change-risks`.

## Impact

- New `src/core/hazards.ts`, modelled on `src/core/decisions.ts` (the ADR
  store): numbered entries, promotion, links.
- `src/core/archive.ts`: promotion at archive; the risks instruction and
  context (`src/core/context.ts`) carry the relevant hazards.
- `src/core/evidence.ts` (from add-verification-evidence) drives status.
- New CLI command and an overview line for hazards that went back to open.

## As implemented

- `src/core/hazards.ts`: numbered entries in `spec-tacular/hazards/`
  (hazard, causes, affects, severity, controls, verification tags,
  unmitigated reason, history, review date), modelled on the ADR store.
- At `spec-tacular archive`, after OpenSpec's archive succeeds, each accepted
  risk is promoted: a new entry, or an update of the one its
  `**Known hazard:**` names (controls and guards added, severity raised to the
  worse of the two, history extended). The guard's latest results come along.
- Status from evidence: `spec-tacular evidence --run` also records every test
  carrying a register entry's verification tag, under `_hazards`, so guards
  keep counting after their change is archived. Mitigated / unverified / open
  / unmitigated / closed, with the reason.
- The live entries go into every agent's context, and the risks instruction
  asks for each hazard the change touches whether it could come back.
- `spec-tacular hazards` (exits non-zero while one is open) and
  `--reviewed HAZ-n [--note …]`; review due after 90 days. The `--print`
  overview names hazards open again and those due for review.

Not done yet:

- **Defects feeding the register** comes with add-defect-changes.
- **The TUI** does not show the register or its alerts yet; the `--print`
  overview and `spec-tacular hazards` do.
- **The review period** is fixed at 90 days, not configurable.
