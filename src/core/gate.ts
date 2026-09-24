/**
 * Whether an artifact may be generated yet.
 *
 * This is where the sequencing argument gets teeth. OpenSpec's `requires` is
 * satisfied by a file existing, so `design` unblocks the moment `specs/` is
 * written — not when anyone has agreed the specs are right
 * (docs/problem-analysis.md §1, §2). The gate adds the missing condition:
 * a prerequisite must be *accepted*, not merely present.
 *
 * Enforced in two places on purpose. The schema (`design.requires: [specs]`)
 * fixes the order for anyone running plain `openspec`; this fixes the
 * acceptance condition, which a schema cannot express.
 */

import { foundationExists, isUnanswered, loadFoundation } from './foundation.ts';
import type { ChangePipeline, Stage } from './pipeline.ts';

export type GateDecision =
  | { allowed: true; warnings: string[] }
  | { allowed: false; reason: string; blockers: string[]; warnings: string[] };

/**
 * Acceptance is only required where it can be measured.
 *
 * Today only the specs artifact carries per-requirement review, so a prose
 * artifact (proposal, design, tasks) is gated on existence alone. Claiming
 * otherwise would either block every change forever or quietly treat
 * "unreviewable" as "reviewed" — both worse than saying so. Document-level
 * review is follow-up work; until it lands this function is deliberately
 * honest about what it cannot check.
 */
function describeBlocker(stage: Stage): string | null {
  if (stage.state === 'ready' || stage.state === 'blocked') {
    return `${stage.id} has not been written yet`;
  }
  const review = stage.review;
  if (!review) return null; // written, and nothing reviewable to check
  if (review.complete) return null;

  if (review.total === 0) {
    return `${stage.id} has no requirements that could be reviewed`;
  }
  const parts: string[] = [];
  if (review.pending > 0) parts.push(`${review.pending} pending`);
  if (review.rejected > 0) parts.push(`${review.rejected} rejected`);
  const detail = parts.length > 0 ? parts.join(' and ') : 'unreviewed';
  return `${stage.id}: ${detail} of ${review.total} requirements`;
}

/** A prerequisite that drifted after this artifact was written against it. */
function describeStaleness(stage: Stage): string | null {
  const drifted = stage.review?.drifted ?? 0;
  return drifted > 0
    ? `${stage.id} changed after review (${drifted} requirement${drifted === 1 ? '' : 's'})`
    : null;
}

export function gateFor(pipeline: ChangePipeline, artifactId: string): GateDecision {
  const all = [...pipeline.stages, pipeline.apply];
  const target = all.find((s) => s.id === artifactId);
  if (!target) {
    return {
      allowed: false,
      reason: `${pipeline.name} has no artifact called '${artifactId}'`,
      blockers: [`known artifacts: ${all.map((s) => s.id).join(', ')}`],
      warnings: [],
    };
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const id of target.requires) {
    const prerequisite = pipeline.stages.find((s) => s.id === id);
    if (!prerequisite) {
      // A schema naming a prerequisite that is not an artifact is a broken
      // schema; refusing is safer than silently ignoring the dependency.
      blockers.push(`${id} is required but is not an artifact in this schema`);
      continue;
    }
    const blocker = describeBlocker(prerequisite);
    if (blocker) blockers.push(blocker);
    const stale = describeStaleness(prerequisite);
    if (stale) warnings.push(stale);
  }

  if (blockers.length > 0) {
    return {
      allowed: false,
      reason: `${artifactId} is not ready to be written`,
      blockers,
      warnings,
    };
  }
  return { allowed: true, warnings };
}

/**
 * Artifacts written against a prerequisite that has since changed.
 *
 * The exact failure the sequencing fix is meant to prevent: a design written
 * against specs that were edited afterwards is silently wrong, and nothing in
 * OpenSpec notices because both files still exist.
 */
export interface StaleArtifact {
  artifact: string;
  because: string[];
}

export function staleArtifacts(pipeline: ChangePipeline): StaleArtifact[] {
  const out: StaleArtifact[] = [];
  for (const stage of pipeline.stages) {
    if (stage.state !== 'written' && stage.state !== 'accepted') continue;
    const because: string[] = [];
    for (const id of stage.requires) {
      const prerequisite = pipeline.stages.find((s) => s.id === id);
      const stale = prerequisite ? describeStaleness(prerequisite) : null;
      if (stale) because.push(stale);
    }
    if (because.length > 0) out.push({ artifact: stage.id, because });
  }
  return out;
}


/**
 * Whether the project's ground rules have been settled.
 *
 * The first change's design otherwise invents the architecture implicitly, and
 * every later change inherits an accident (docs/problem-analysis.md §9). So
 * the first artifact of a change is gated on the Foundation being answered.
 *
 * A project with no Foundation at all is not blocked: spec-tacular has to stay
 * usable on a repository that adopted OpenSpec before it existed. Only a
 * scaffolded-but-unanswered Foundation blocks, because there the questions
 * have been asked and left hanging.
 */
export function foundationGate(projectRoot: string): GateDecision {
  if (!foundationExists(projectRoot)) {
    return {
      allowed: true,
      warnings: ['no Foundation yet — run `spectacular init` to set the ground rules'],
    };
  }

  const unanswered = loadFoundation(projectRoot).filter(isUnanswered);
  if (unanswered.length === 0) return { allowed: true, warnings: [] };

  return {
    allowed: false,
    reason: 'the project\'s ground rules are not settled yet',
    blockers: unanswered.map((item) => `${item.capability}: ${item.name}`),
    warnings: [],
  };
}
