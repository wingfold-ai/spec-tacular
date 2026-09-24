/**
 * Review state — the thing OpenSpec does not have.
 *
 * OpenSpec decides an artifact is complete by checking that its file exists
 * (`artifact-graph/state.ts`). That cannot answer "which specs have been
 * finished off and accepted", so spec-tacular keeps acceptance in a sidecar
 * OpenSpec never reads.
 *
 * The sidecar is never trusted on its own. Every requirement carries the hash
 * of the text that was accepted, and every load re-hashes the Markdown and
 * compares. Files get edited outside this tool — by you, by an agent — and a
 * review tool that keeps claiming "accepted" for text nobody accepted is worse
 * than having no review tool at all.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReviewItem, Rename } from './requirements.ts';

export type ReviewState = 'pending' | 'accepted' | 'rejected' | 'deferred';

/** Bumped only on a breaking change to the on-disk shape. */
export const REVIEW_SCHEMA_VERSION = 1;

export interface RequirementReview {
  state: ReviewState;
  /** Hash of the text that was reviewed. Null while still pending. */
  hash: string | null;
  reviewedAt: string | null;
  /** Why it was rejected — fed back to the agent as a revision instruction. */
  note?: string;
  /** Why it was deferred, e.g. `awaiting-deployment` (problem-analysis §8). */
  deferReason?: string;
}

export interface ChangeReview {
  change: string;
  schemaVersion: number;
  requirements: Record<string, RequirementReview>;
  /**
   * Where the last review session stopped, as a requirement id.
   *
   * An id rather than an index: an index silently points at a different
   * requirement as soon as one is inserted above it, and resuming matters most
   * exactly when the specs have been revised.
   */
  cursor?: string | null;
}

/** A review item joined with its state, as the UI consumes it. */
export interface ReviewedItem {
  item: ReviewItem;
  state: ReviewState;
  review: RequirementReview;
  /**
   * The text changed since it was reviewed. `state` is already forced back to
   * `pending`; this flag is what lets the UI say *why* it went back.
   */
  drifted: boolean;
}

export interface ReviewSummary {
  total: number;
  accepted: number;
  rejected: number;
  deferred: number;
  pending: number;
  drifted: number;
  /**
   * Every requirement is accepted or deferred, and nothing has drifted.
   * This — not file existence — is what gates the next stage.
   */
  complete: boolean;
}

const PENDING: RequirementReview = { state: 'pending', hash: null, reviewedAt: null };

export function emptyReview(change: string): ChangeReview {
  return { change, schemaVersion: REVIEW_SCHEMA_VERSION, requirements: {} };
}

export function reviewPath(projectRoot: string, change: string): string {
  return join(projectRoot, '.spec-tacular', 'review', `${change}.json`);
}

/**
 * Loads the sidecar. A missing, unreadable or malformed file yields an empty
 * review rather than throwing: losing review state is annoying, but refusing
 * to open the project at all is worse, and the state rebuilds by re-reviewing.
 */
export function loadReview(projectRoot: string, change: string): ChangeReview {
  let raw: string;
  try {
    raw = readFileSync(reviewPath(projectRoot, change), 'utf8');
  } catch {
    return emptyReview(change);
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ChangeReview>;
    if (
      typeof parsed.schemaVersion !== 'number' ||
      parsed.schemaVersion > REVIEW_SCHEMA_VERSION
    ) {
      // Written by a newer spec-tacular. Its extra fields would be silently
      // dropped on the next save, so it is left untouched and ignored.
      return emptyReview(change);
    }
    return {
      change,
      schemaVersion: parsed.schemaVersion,
      requirements: parsed.requirements ?? {},
      cursor: parsed.cursor ?? null,
    };
  } catch {
    return emptyReview(change);
  }
}

/** Writes atomically, so an interrupted save cannot truncate the sidecar. */
export function saveReview(projectRoot: string, review: ChangeReview): void {
  const path = reviewPath(projectRoot, review.change);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * Carries review state across an explicit rename.
 *
 * OpenSpec's `RENAMED Requirements` delta states the rename outright, so it
 * need not be guessed from similarity: without this the old id looks deleted
 * and the new one unreviewed, silently discarding an acceptance.
 */
export function applyRenames(review: ChangeReview, renames: Rename[]): ChangeReview {
  if (renames.length === 0) return review;

  const requirements = { ...review.requirements };
  for (const rename of renames) {
    const fromId = idFor(rename.capability, rename.from);
    const toId = idFor(rename.capability, rename.to);
    const carried = requirements[fromId];
    // An existing entry at the destination wins: it was reviewed under the
    // new name, which is more recent than whatever the old name held.
    if (carried && !requirements[toId]) {
      requirements[toId] = carried;
      delete requirements[fromId];
    }
  }
  return { ...review, requirements };
}

function idFor(capability: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${capability}#${slug || 'unnamed'}`;
}

/**
 * Joins parsed requirements with stored state, resetting anything that drifted.
 *
 * Note the direction: the Markdown is the source of truth and the sidecar is
 * an annotation on it. A requirement the parser no longer sees simply
 * disappears from the queue, and its stale entry is dropped on the next save.
 */
export function reconcile(items: ReviewItem[], review: ChangeReview): ReviewedItem[] {
  return items.map((item) => {
    const stored = review.requirements[item.id] ?? PENDING;
    // A pending entry has no hash and cannot have drifted — only a decision
    // can be invalidated by an edit.
    const drifted =
      stored.state !== 'pending' && stored.hash !== null && stored.hash !== item.hash;

    return {
      item,
      state: drifted ? 'pending' : stored.state,
      review: stored,
      drifted,
    };
  });
}

export function summarize(reviewed: ReviewedItem[]): ReviewSummary {
  const count = (s: ReviewState) => reviewed.filter((r) => r.state === s).length;
  const accepted = count('accepted');
  const deferred = count('deferred');
  const drifted = reviewed.filter((r) => r.drifted).length;

  return {
    total: reviewed.length,
    accepted,
    rejected: count('rejected'),
    deferred,
    pending: count('pending'),
    drifted,
    // An empty queue is not complete: a specs artifact with no parseable
    // requirements is a problem to surface, not a stage to wave through.
    complete: reviewed.length > 0 && accepted + deferred === reviewed.length,
  };
}

/** Records a decision, stamping the hash of the exact text that was reviewed. */
export function setState(
  review: ChangeReview,
  item: ReviewItem,
  state: ReviewState,
  extra: { note?: string; deferReason?: string } = {},
): ChangeReview {
  const entry: RequirementReview = {
    state,
    hash: state === 'pending' ? null : item.hash,
    reviewedAt: state === 'pending' ? null : new Date().toISOString(),
    ...(extra.note ? { note: extra.note } : {}),
    ...(extra.deferReason ? { deferReason: extra.deferReason } : {}),
  };
  return {
    ...review,
    requirements: { ...review.requirements, [item.id]: entry },
  };
}
