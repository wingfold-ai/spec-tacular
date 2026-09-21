/**
 * The pipeline model: OpenSpec's artifact list turned into the stage view that
 * is always on screen.
 *
 * Deliberately schema-agnostic. Stages are derived from whatever artifacts the
 * change's schema declares, in dependency order, so this works unchanged with
 * `spec-driven`, with spec-tacular's own schema, and with any custom schema a
 * project forks.
 *
 * Scope note (M1): every state here is derived from OpenSpec's own
 * file-existence truth. `done` therefore means "the file is written", NOT
 * "a human accepted it". Acceptance is M2; until it lands, nothing in this
 * module may claim a requirement was reviewed.
 */

import type { OpenSpecArtifact, OpenSpecChangeStatus } from '../adapter/types.ts';

export type StageState =
  /** Prerequisites unmet — cannot be started. */
  | 'blocked'
  /** Prerequisites met, not yet written. */
  | 'ready'
  /** Written. Not necessarily reviewed — see the scope note above. */
  | 'written';

export interface Stage {
  id: string;
  state: StageState;
  requires: string[];
  /** Why this stage is blocked: the prerequisite IDs that are not yet written. */
  blockedBy: string[];
}

/**
 * An artifact that exists although a prerequisite of it does not.
 *
 * Related to docs/problem-analysis.md §1, but it is NOT proof of a defect, and
 * must not be presented as one. OpenSpec has no way for a schema to mark an
 * artifact optional — yet `spec-driven` documents `design` as exactly that
 * ("create only if any apply"). So a deliberately skipped optional artifact and
 * one that was forgotten produce identical data, and nothing on disk tells them
 * apart.
 *
 * It is therefore reported as something worth a human's glance, never as an
 * error. Under spec-tacular's own schema, where every artifact is mandatory and
 * `design` requires `specs`, a gap here does mean the order was violated.
 */
export interface PrerequisiteGap {
  artifact: string;
  missing: string[];
}

export interface ChangePipeline {
  name: string;
  schema: string;
  root: string;
  stages: Stage[];
  /** Appended after the schema's artifacts; gated by the schema's `apply.requires`. */
  apply: Stage;
  gaps: PrerequisiteGap[];
  /** The stage a human should look at next, or null when planning is finished. */
  current: Stage | null;
  written: number;
  total: number;
}

function toState(artifact: OpenSpecArtifact, writtenIds: ReadonlySet<string>): Stage {
  const blockedBy = artifact.requires.filter((r) => !writtenIds.has(r));
  // OpenSpec's own status is trusted for done/blocked, but `blockedBy` is
  // recomputed here: its `ready` and `blocked` do not carry the reason, and
  // the reason is the whole point of showing a blocked stage in the UI.
  const state: StageState =
    artifact.status === 'done' ? 'written' : blockedBy.length > 0 ? 'blocked' : 'ready';
  return { id: artifact.id, state, requires: artifact.requires, blockedBy };
}

export function buildPipeline(status: OpenSpecChangeStatus): ChangePipeline {
  const written = new Set(
    status.artifacts.filter((a) => a.status === 'done').map((a) => a.id),
  );

  const stages = status.artifacts.map((a) => toState(a, written));

  const applyBlockedBy = status.applyRequires.filter((r) => !written.has(r));
  const apply: Stage = {
    id: 'apply',
    // `apply` is never `written`: whether implementation is finished is a
    // question about tasks.md checkboxes, not about a file existing. That
    // lands with the task parser in M8.
    state: applyBlockedBy.length > 0 ? 'blocked' : 'ready',
    requires: status.applyRequires,
    blockedBy: applyBlockedBy,
  };

  const gaps: PrerequisiteGap[] = [];
  for (const a of status.artifacts) {
    if (a.status !== 'done') continue;
    const missing = a.requires.filter((r) => !written.has(r));
    if (missing.length > 0) gaps.push({ artifact: a.id, missing });
  }

  // The first stage a human can act on. A blocked stage is skipped: acting on
  // it is impossible, so pointing at it would be useless advice.
  const current = stages.find((s) => s.state === 'ready') ?? null;

  return {
    name: status.changeName,
    schema: status.schemaName,
    root: status.changeRoot,
    stages,
    apply,
    gaps,
    current,
    written: written.size,
    total: status.artifacts.length,
  };
}

/** Sorted least-complete first, so what needs attention is at the top. */
export function sortByProgress(pipelines: ChangePipeline[]): ChangePipeline[] {
  return [...pipelines].sort((a, b) => {
    const ratio = (p: ChangePipeline) => (p.total === 0 ? 1 : p.written / p.total);
    return ratio(a) - ratio(b) || a.name.localeCompare(b.name);
  });
}
