/**
 * Loads a change's full review queue: every requirement across every
 * capability, joined with its stored review state.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenSpecChangeStatus } from '../adapter/types.ts';
import { loadDecisions } from './decisions.ts';
import { loadRisks, type Risk } from './risks.ts';
import { changeMatrices } from './formal/files.ts';
import { formalOf } from './formal/formal.ts';
import { loadGlossary } from './formal/glossary.ts';
import { componentHarness, harnessItems } from './formal/harness.ts';
import {
  capabilityFromPath,
  parseSpecFile,
  slugify,
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
  /** Everything to review, in order: requirements, then risks, then decisions. */
  requirements: ReviewedItem[];
  /** The spec requirements alone: what the specs stage is accepted on. */
  summary: ReviewSummary;
  /** The risks alone, once written: what the risks stage is accepted on. */
  risks?: ReviewSummary;
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

/** The id of the artifact that writes `risks.md`, when the schema has one. */
export function risksArtifactId(status: OpenSpecChangeStatus): string | null {
  for (const artifact of status.artifacts) {
    const path = status.artifactPaths[artifact.id]?.outputPath ?? '';
    if (/(^|\/)risks\.md$/.test(path.replace(/\\/g, '/'))) return artifact.id;
  }
  return null;
}

/** The harness items of the components a change's matrices run through. */
export function changeHarnessItems(projectRoot: string, change: string, items: ReviewItem[]): ReviewItem[] {
  if (!items.some((i) => formalOf(i))) return [];
  const glossary = loadGlossary(projectRoot);
  const components = [...new Set(changeMatrices(projectRoot, change, items, glossary).map((e) => slugify(e.matrix.component)))];
  return components.flatMap((c) => harnessItems(projectRoot, componentHarness(projectRoot, c), glossary));
}

/** Whether the change has written its risks. */
export function risksWritten(status: OpenSpecChangeStatus): boolean {
  const id = risksArtifactId(status);
  return id !== null && status.artifacts.some((a) => a.id === id && a.status === 'done');
}

/** The change's risks, once written. */
export function loadChangeRisks(status: OpenSpecChangeStatus): Risk[] {
  const id = risksArtifactId(status);
  if (!id || !risksWritten(status)) return [];
  return loadRisks(status.artifactPaths[id]?.resolvedOutputPath ?? join(status.changeRoot, 'risks.md'));
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

  // The queue follows the pipeline: risks are written against settled specs,
  // and a design against both, so reviewing either first is out of order.
  const risks = loadChangeRisks(status);
  const items: ReviewItem[] = [...requirements, ...risks];
  if (options.includeDecisions) items.push(...loadChangeDecisions(status));
  // Last, once implementing has written them: how each variable of the
  // change's matrices is bound to the code — reviewed like any other item.
  items.push(...changeHarnessItems(projectRoot, status.changeName, [...requirements, ...risks]));

  const review = applyRenames(loadReview(projectRoot, status.changeName), renames);
  const reviewed = reconcile(items, review);
  const ofKind = (capability: (c: string) => boolean) =>
    summarize(reviewed.filter((r) => capability(r.item.capability)));

  return {
    change: status.changeName,
    requirements: reviewed,
    summary: ofKind((c) => c !== 'risks' && c !== 'design' && !c.startsWith('harness/')),
    // Written but unreadable still gets a summary — an empty one, which is
    // never complete — so the stage says so instead of waving it through.
    ...(risksWritten(status) ? { risks: ofKind((c) => c === 'risks') } : {}),
    review,
    unreadable,
  };
}
