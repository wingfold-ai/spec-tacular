/**
 * Loads a change's full review queue: every requirement across every
 * capability, joined with its stored review state.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenSpecChangeStatus } from '../adapter/types.ts';
import { loadDecisions } from './decisions.ts';
import {
  capabilityFromPath,
  parseSpecFile,
  type Rename,
  type Requirement,
  type ReviewItem,
} from './requirements.ts';
import {
  applyRenames,
  loadReview,
  reconcile,
  summarize,
  type ChangeReview,
  type ReviewedItem,
  type ReviewSummary,
} from './review.ts';

export interface ChangeReviewQueue {
  change: string;
  requirements: ReviewedItem[];
  summary: ReviewSummary;
  review: ChangeReview;
  /** Spec files that could not be read, so the UI can say so rather than under-report. */
  unreadable: string[];
}

/**
 * The id of the artifact that holds requirement specs.
 *
 * Found by looking for an artifact whose output path points into `specs/`,
 * rather than assuming the id is literally `specs`. Both the `spec-driven` and
 * `spec-tacular` schemas happen to call it that, but a custom schema need not,
 * and the architecture promises this layer stays schema-agnostic.
 */
export function specsArtifactId(status: OpenSpecChangeStatus): string | null {
  for (const artifact of status.artifacts) {
    const path = status.artifactPaths[artifact.id]?.outputPath ?? '';
    if (/(^|\/)specs\//.test(path.replace(/\\/g, '/'))) return artifact.id;
  }
  return null;
}

/** The spec files of a change, from the paths OpenSpec already resolved. */
export function specFilesOf(status: OpenSpecChangeStatus): string[] {
  const id = specsArtifactId(status);
  return id ? (status.artifactPaths[id]?.existingOutputPaths ?? []) : [];
}

/** The change's design decisions, reviewable like any other item. */
export function loadChangeDecisions(status: OpenSpecChangeStatus) {
  return loadDecisions(join(status.changeRoot, 'design.md'));
}

export function loadChangeReview(
  projectRoot: string,
  status: OpenSpecChangeStatus,
  options: { includeDecisions?: boolean } = {},
): ChangeReviewQueue {
  const requirements: Requirement[] = [];
  const renames: Rename[] = [];
  const unreadable: string[] = [];

  // Sorted so the queue order is stable across runs — resuming a review must
  // land you where you left off, and filesystem order does not guarantee that.
  for (const file of [...specFilesOf(status)].sort()) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      unreadable.push(file);
      continue;
    }
    const parsed = parseSpecFile(content, capabilityFromPath(file), file);
    requirements.push(...parsed.requirements);
    renames.push(...parsed.renames);
  }

  // Decisions come after requirements: a design is written against settled
  // specs, so reviewing it first would be reviewing it out of order.
  const items: ReviewItem[] = [...requirements];
  if (options.includeDecisions) items.push(...loadChangeDecisions(status));

  const review = applyRenames(loadReview(projectRoot, status.changeName), renames);
  const reviewed = reconcile(items, review);

  return {
    change: status.changeName,
    requirements: reviewed,
    summary: summarize(reviewed),
    review,
    unreadable,
  };
}
