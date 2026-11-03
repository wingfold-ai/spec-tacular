/**
 * The pipeline model: OpenSpec's artifact list turned into the stage view that
 * is always on screen.
 *
 * Deliberately schema-agnostic. Stages are derived from whatever artifacts the
 * change's schema declares, in dependency order, so this works unchanged with
 * `spec-driven`, with spec-tacular's own schema, and with any custom schema a
 * project forks.
 *
 * Two different truths live here and must not be confused. `written` is
 * OpenSpec's: the file exists. `accepted` is spec-tacular's: a human reviewed
 * every requirement in it, or read the whole document and accepted it. An
 * artifact with no review data can only ever reach `written`, never `accepted`
 * — absence of review is never evidence of review.
 */

import type { OpenSpecArtifact, OpenSpecChangeStatus } from '../adapter/types.ts';
import type { ReviewSummary } from './review.ts';
import type { ChangeClass } from './classes.ts';
import type { DefectCheck } from './defects.ts';
import type { ChangeFormal } from './formal/formal.ts';
import type { EvidenceSummary } from './evidence.ts';
import type { Signoff } from './signoff.ts';
import type { TaskProgress } from './tasks.ts';

export type StageState =
  /** Prerequisites unmet — cannot be started. */
  | 'blocked'
  /** Prerequisites met, not yet written. */
  | 'ready'
  /** Written to disk. Reviewed? Unknown, or known to be unfinished. */
  | 'written'
  /**
   * Written AND reviewed: every requirement accepted or deferred, or the
   * document accepted as a whole — with no drift since.
   */
  | 'accepted';

export interface Stage {
  id: string;
  state: StageState;
  requires: string[];
  /** Why this stage is blocked: the prerequisite IDs that are not yet written. */
  blockedBy: string[];
  /** Review progress, when this artifact carries reviewable requirements. */
  review?: ReviewSummary;
  /** Whether it was accepted as a whole, when it is a document read in one piece. */
  signoff?: Signoff;
  /** `apply` only: how many of the tasks are ticked. */
  tasks?: TaskProgress;
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

/**
 * How a change follows its risks through, and stays inside its boundary
 * (core/risks.ts, core/boundary.ts). Each list names what is missing, so the
 * overview and the gate can say exactly which risk or file it is about.
 */
export interface RiskCheck {
  /** Accepted risks the design does not answer by name. Empty until it is written. */
  unanswered: string[];
  /** Accepted risks with no guard task. Empty until the tasks are written. */
  unguarded: string[];
  /** Guard tasks ticked off without having been shown red. */
  unproven: string[];
  /** Files changed outside the proposal's boundary, once implementing started. */
  outsideBoundary: string[];
  /** High-severity risks marked Unmitigated. */
  unmitigatedHigh: string[];
}

export interface ChangePipeline {
  name: string;
  schema: string;
  root: string;
  stages: Stage[];
  /**
   * Appended after the schema's artifacts; gated by the schema's
   * `apply.requires`. `accepted` once every task is ticked or deferred.
   */
  apply: Stage;
  /**
   * Changes before this one on the roadmap that must be applied before it
   * writes anything that builds on their code (`buildsOnCode`).
   */
  waitingOn: string[];
  risks?: RiskCheck;
  /** Its consequence class and the rules that follow, when the project has classes. */
  consequence?: ChangeClass;
  /** How much of what it promises has evidence, when the project runs tests for it. */
  evidence?: EvidenceSummary;
  /** For a defect change: whose bug it is, and what does not fit that answer. */
  defect?: DefectCheck;
  /** Its requirements' formal forms: how many have one, and what is wrong with them. */
  formal?: ChangeFormal;
  gaps: PrerequisiteGap[];
  /** The stage a human should look at next, or null when planning is finished. */
  current: Stage | null;
  written: number;
  accepted: number;
  total: number;
}

function toState(
  artifact: OpenSpecArtifact,
  writtenIds: ReadonlySet<string>,
  review: ReviewSummary | undefined,
  signoff: Signoff | undefined,
): Stage {
  const blockedBy = artifact.requires.filter((r) => !writtenIds.has(r));
  // OpenSpec's own status is trusted for done/blocked, but `blockedBy` is
  // recomputed here: its `ready` and `blocked` do not carry the reason, and
  // the reason is the whole point of showing a blocked stage in the UI.
  let state: StageState;
  if (artifact.status !== 'done') {
    state = blockedBy.length > 0 ? 'blocked' : 'ready';
  } else {
    state = (review ? review.complete : signoff?.accepted) ? 'accepted' : 'written';
  }
  return {
    id: artifact.id,
    state,
    requires: artifact.requires,
    blockedBy,
    ...(review ? { review } : {}),
    ...(signoff ? { signoff } : {}),
  };
}

/** Review summaries keyed by artifact id. Only `specs` carries one today. */
export type ReviewByArtifact = Readonly<Record<string, ReviewSummary>>;

/** Whole-document acceptance keyed by artifact id: proposal, design, tasks. */
export type SignoffByArtifact = Readonly<Record<string, Signoff>>;

export function buildPipeline(
  status: OpenSpecChangeStatus,
  reviews: ReviewByArtifact = {},
  signoffs: SignoffByArtifact = {},
  implementation: {
    tasks?: TaskProgress;
    waitingOn?: string[];
    risks?: RiskCheck;
    consequence?: ChangeClass;
    /** Whether a person accepted the implementation diff, where the class asks for it. */
    diff?: Signoff;
    evidence?: EvidenceSummary;
    defect?: DefectCheck;
    formal?: ChangeFormal;
  } = {},
): ChangePipeline {
  const written = new Set(
    status.artifacts.filter((a) => a.status === 'done').map((a) => a.id),
  );

  const stages = status.artifacts.map((a) => toState(a, written, reviews[a.id], signoffs[a.id]));

  const applyBlockedBy = status.applyRequires.filter((r) => !written.has(r));
  const { tasks, waitingOn = [], risks, consequence, diff, evidence, defect, formal } = implementation;
  // Where the class asks a person to read what the agent wrote, ticking the
  // last task off is not the end of implementing: accepting the diff is.
  const diffReview = consequence?.rules.includes('diff-review') ?? false;
  const implemented = (tasks?.applied ?? false) && (!diffReview || diff?.accepted === true);
  const apply: Stage = {
    id: 'apply',
    // `apply` is never `written`: whether implementation is finished is a
    // question about tasks.md checkboxes, not about a file existing.
    state: applyBlockedBy.length > 0 ? 'blocked' : implemented ? 'accepted' : 'ready',
    requires: status.applyRequires,
    blockedBy: applyBlockedBy,
    ...(tasks ? { tasks } : {}),
    ...(diffReview ? { signoff: diff ?? { accepted: false, drifted: false } } : {}),
  };

  const gaps: PrerequisiteGap[] = [];
  for (const a of status.artifacts) {
    if (a.status !== 'done') continue;
    const missing = a.requires.filter((r) => !written.has(r));
    if (missing.length > 0) gaps.push({ artifact: a.id, missing });
  }

  // The first stage a human can act on. A blocked stage is skipped (acting on
  // it is impossible), but a written-and-unreviewed one is NOT: reviewing it
  // is exactly the work this tool exists for, and it comes before writing the
  // next artifact.
  const current =
    stages.find((s) => s.state === 'written' && (s.review !== undefined || s.signoff !== undefined)) ??
    stages.find((s) => s.state === 'ready') ??
    null;

  return {
    name: status.changeName,
    schema: status.schemaName,
    root: status.changeRoot,
    stages,
    apply,
    waitingOn,
    ...(risks ? { risks } : {}),
    ...(consequence ? { consequence } : {}),
    ...(evidence ? { evidence } : {}),
    ...(defect ? { defect } : {}),
    ...(formal ? { formal } : {}),
    gaps,
    current,
    written: written.size,
    accepted: stages.filter((s) => s.state === 'accepted').length,
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

/**
 * Every artifact up to and including the specs accepted: what the slice is
 * meant to do is settled, so the next slice may be specified meanwhile. How
 * it is built — design, tasks — waits for the code before it (`buildsOnCode`).
 */
export function specified(pipeline: ChangePipeline | undefined): boolean {
  if (!pipeline || pipeline.stages.length === 0) return false;
  const specs = pipeline.stages.findIndex((s) => s.id === 'specs');
  const upTo = specs < 0 ? pipeline.stages : pipeline.stages.slice(0, specs + 1);
  return upTo.every((s) => s.state === 'accepted');
}

/**
 * Whether an artifact depends on the code that exists when it is written:
 * the design, the tasks and implementing, everything after the specs. A slice
 * writes those only once the slices before it are applied.
 *
 * The risks are about what the specs could break, so like the specs they may
 * be written ahead.
 */
export function buildsOnCode(pipeline: ChangePipeline, artifactId: string): boolean {
  if (artifactId === 'apply') return true;
  const ahead = Math.max(
    pipeline.stages.findIndex((s) => s.id === 'specs'),
    pipeline.stages.findIndex((s) => s.id === 'risks'),
  );
  return ahead >= 0 && pipeline.stages.findIndex((s) => s.id === artifactId) > ahead;
}
