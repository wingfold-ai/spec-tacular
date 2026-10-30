/**
 * The review session: a cursor over a change's requirement queue, plus the
 * decisions made against it.
 *
 * Pure and I/O-free on purpose. The review loop is the product
 * (docs/problem-analysis.md §3), so its behaviour — what "next" means, what a
 * decision does to the cursor, where you land when you come back — is defined
 * here and tested without a terminal. The TUI only draws the current item.
 */

import type { ReviewItem } from './requirements.ts';
import {
  reconcile,
  setState,
  summarize,
  type ChangeReview,
  type ReviewedItem,
  type ReviewState,
  type ReviewSummary,
} from './review.ts';

export interface ReviewSession {
  change: string;
  items: ReviewedItem[];
  /** Index into `items`. Always valid when `items` is non-empty. */
  cursor: number;
  review: ChangeReview;
  summary: ReviewSummary;
}

/** A state that means "this requirement still needs you". */
function isOpen(item: ReviewedItem): boolean {
  return item.state === 'pending' || item.state === 'rejected';
}

function build(
  change: string,
  items: ReviewItem[],
  review: ChangeReview,
  cursor: number,
): ReviewSession {
  const reviewed = reconcile(items, review);
  return {
    change,
    items: reviewed,
    cursor: reviewed.length === 0 ? 0 : Math.min(Math.max(cursor, 0), reviewed.length - 1),
    review,
    summary: summarize(reviewed),
  };
}

/**
 * Opens a session, resuming where the last one stopped.
 *
 * The stored cursor is a requirement id, not an index: an index would silently
 * point at a different requirement as soon as one is added or removed above it,
 * which is exactly when resuming matters most.
 */
export function openSession(
  change: string,
  items: ReviewItem[],
  review: ChangeReview,
): ReviewSession {
  const reviewed = reconcile(items, review);
  const stored = review.cursor ? reviewed.findIndex((i) => i.item.id === review.cursor) : -1;
  // No stored position (or it points at a requirement that is gone): start at
  // the first thing that needs attention rather than at the top, so reopening
  // a mostly-reviewed change does not make you walk past the accepted ones.
  // Where you left off only while it still needs you: once it is decided,
  // what came after it (new risks, a harness) is where the work is.
  const firstOpen = reviewed.findIndex(isOpen);
  const start = stored !== -1 && (isOpen(reviewed[stored]!) || firstOpen === -1) ? stored : Math.max(firstOpen, 0);
  return build(change, items, review, start);
}

export function currentItem(session: ReviewSession): ReviewedItem | null {
  return session.items[session.cursor] ?? null;
}

/** Moves the cursor by `delta`, clamped. Never wraps — see `moveTo`. */
export function move(session: ReviewSession, delta: number): ReviewSession {
  if (session.items.length === 0) return session;
  // Clamped rather than wrapping: `n` at the end of the queue jumping to the
  // start would lose your place in a list of forty requirements.
  const next = Math.min(Math.max(session.cursor + delta, 0), session.items.length - 1);
  return withCursor(session, next);
}

export function moveTo(session: ReviewSession, index: number): ReviewSession {
  if (session.items.length === 0) return session;
  return withCursor(session, Math.min(Math.max(index, 0), session.items.length - 1));
}

function withCursor(session: ReviewSession, cursor: number): ReviewSession {
  const id = session.items[cursor]?.item.id ?? null;
  return { ...session, cursor, review: { ...session.review, cursor: id } };
}

/**
 * The next requirement still needing attention, searching forward and then
 * wrapping once.
 *
 * Wrapping is right here but wrong for `n`/`p`: this answers "what else needs
 * me?", which has no spatial meaning, whereas `n` is a step through a list.
 * Returns the current index when nothing is open.
 */
export function nextOpenIndex(session: ReviewSession, from: number): number {
  const n = session.items.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (isOpen(session.items[i]!)) return i;
  }
  return from;
}

/** `s` — leave the decision for later and move on. */
export function skip(session: ReviewSession): ReviewSession {
  if (session.items.length === 0) return session;
  return withCursor(session, nextOpenIndex(session, session.cursor));
}

/**
 * Records a decision and advances to the next open requirement.
 *
 * Returns the session unchanged when the queue is empty, so a caller need not
 * special-case it before every keystroke.
 */
export function decide(
  session: ReviewSession,
  state: ReviewState,
  extra: { note?: string; deferReason?: string } = {},
): ReviewSession {
  const item = currentItem(session);
  if (!item) return session;

  const review = setState(session.review, item.item, state, extra);
  const items = session.items.map((i) => i.item);
  // Rebuilt at the old cursor first so `nextOpenIndex` sees the decision that
  // was just made; otherwise accepting the last open item would loop back to it.
  const updated = build(session.change, items, review, session.cursor);
  return withCursor(updated, nextOpenIndex(updated, updated.cursor));
}

/** Re-reads the queue from freshly parsed Markdown, keeping your place. */
export function refresh(session: ReviewSession, items: ReviewItem[]): ReviewSession {
  const id = currentItem(session)?.item.id;
  const rebuilt = build(session.change, items, session.review, session.cursor);
  const at = id ? rebuilt.items.findIndex((i) => i.item.id === id) : -1;
  return at === -1 ? rebuilt : withCursor(rebuilt, at);
}

/** Position in the queue, 1-based, for display. */
export function position(session: ReviewSession): { index: number; total: number } {
  return {
    index: session.items.length === 0 ? 0 : session.cursor + 1,
    total: session.items.length,
  };
}
