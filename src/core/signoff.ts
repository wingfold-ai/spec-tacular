/**
 * Accepting a prose artifact as a whole.
 *
 * The specs are reviewed requirement by requirement (core/review.ts). A
 * proposal, a design or a task list is read and accepted in one piece — but it
 * is still a human's decision, and the next stage waits for it just the same.
 *
 * Like a requirement's acceptance, it holds only for the text that was read:
 * the hash is re-checked on every load, and an edit or a redraft since sends
 * the document back to be read again.
 */

import { parseDecisions } from './decisions.ts';
import { hashBlock } from './requirements.ts';
import { NOTE, SHOWN_RED, stripMarkers } from './markers.ts';
import { stripMarker } from './provenance.ts';
import { loadReview, saveReview, setState } from './review.ts';

/** Where a written document stands. */
export interface Signoff {
  /** Accepted, and unchanged since. */
  accepted: boolean;
  /** Accepted once, but the text changed since. */
  drifted: boolean;
}

/**
 * The hash a document is accepted under. Ticking a task off is implementing
 * the plan, not changing it, so checkboxes count as unticked — and so do
 * recording that a guard test was shown red and the agent's `(note: …)`
 * on a task (core/markers.ts). The generated-by marker is not content either
 * (core/provenance.ts).
 */
export function hashDocument(content: string): string {
  return hashBlock(stripMarkers(stripMarker(content).replace(/^(\s*[-*]\s+)\[[xX]\]/gm, '$1[ ]'), [NOTE, SHOWN_RED]));
}

/** Whether `artifact` of `change`, as `content` now reads, is accepted. */
export function loadSignoff(projectRoot: string, change: string, artifact: string, content: string): Signoff {
  const stored = loadReview(projectRoot, change).documents?.[artifact];
  if (!stored) return { accepted: false, drifted: false };
  const same = stored.hash === hashDocument(content);
  return { accepted: same, drifted: !same };
}

/** Records that a human read `content` of `artifact` and accepted it. */
export function acceptDocument(projectRoot: string, change: string, artifact: string, content: string): void {
  let review = loadReview(projectRoot, change);
  // A design read and accepted whole accepts each decision in it as it
  // reads now: later, only a decision whose text changes is asked again.
  if (artifact === 'design') {
    for (const decision of parseDecisions(content, 'design.md')) {
      const stored = review.requirements[decision.id];
      if (!stored || stored.state === 'pending' || stored.hash !== decision.hash) review = setState(review, decision, 'accepted');
    }
  }
  saveReview(projectRoot, {
    ...review,
    documents: {
      ...review.documents,
      [artifact]: { hash: hashDocument(content), acceptedAt: new Date().toISOString() },
    },
  });
}
