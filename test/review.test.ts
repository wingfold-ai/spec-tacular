import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpecFile, type Requirement } from '../src/core/requirements.ts';
import {
  applyRenames,
  emptyReview,
  loadReview,
  reconcile,
  reviewPath,
  saveReview,
  setState,
  summarize,
  REVIEW_SCHEMA_VERSION,
} from '../src/core/review.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SPEC = `## ADDED Requirements

### Requirement: Alpha
The system SHALL alpha.

### Requirement: Beta
The system SHALL beta.
`;

const reqs = (md = SPEC): Requirement[] =>
  parseSpecFile(md, 'cap', '/p/specs/cap/spec.md').requirements;

describe('persistence', () => {
  test('round-trips through the sidecar', () => {
    const root = tmp();
    const [alpha] = reqs();
    const review = setState(emptyReview('c'), alpha!, 'accepted');
    saveReview(root, review);

    const loaded = loadReview(root, 'c');
    expect(loaded.requirements['cap#alpha']?.state).toBe('accepted');
    expect(loaded.requirements['cap#alpha']?.hash).toBe(alpha!.hash);
    expect(loaded.schemaVersion).toBe(REVIEW_SCHEMA_VERSION);
  });

  test('a hand-edited state file is honoured', () => {
    // M2's exit criterion: the sidecar is plain JSON a human can edit.
    const root = tmp();
    const path = reviewPath(root, 'c');
    mkdirSync(join(root, '.spec-tacular', 'review'), { recursive: true });
    const [alpha] = reqs();
    writeFileSync(
      path,
      JSON.stringify({
        change: 'c',
        schemaVersion: 1,
        requirements: { 'cap#alpha': { state: 'deferred', hash: alpha!.hash, reviewedAt: null, deferReason: 'awaiting-deployment' } },
      }),
    );
    const [first] = reconcile(reqs(), loadReview(root, 'c'));
    expect(first!.state).toBe('deferred');
    expect(first!.review.deferReason).toBe('awaiting-deployment');
  });

  test('a missing file is an empty review, not an error', () => {
    expect(loadReview(tmp(), 'nope').requirements).toEqual({});
  });

  test('malformed JSON degrades to an empty review', () => {
    const root = tmp();
    mkdirSync(join(root, '.spec-tacular', 'review'), { recursive: true });
    writeFileSync(reviewPath(root, 'c'), '{not json');
    expect(loadReview(root, 'c').requirements).toEqual({});
  });

  test('a file from a newer spec-tacular is ignored, not silently rewritten', () => {
    const root = tmp();
    mkdirSync(join(root, '.spec-tacular', 'review'), { recursive: true });
    writeFileSync(
      reviewPath(root, 'c'),
      JSON.stringify({ change: 'c', schemaVersion: REVIEW_SCHEMA_VERSION + 1, requirements: { x: { state: 'accepted' } } }),
    );
    expect(loadReview(root, 'c').requirements).toEqual({});
  });

  test('leaves no temp file behind', () => {
    const root = tmp();
    saveReview(root, emptyReview('c'));
    const entries = readFileSync(reviewPath(root, 'c'), 'utf8');
    expect(entries).toContain('"change"');
    expect(() => readFileSync(`${reviewPath(root, 'c')}.${process.pid}.tmp`, 'utf8')).toThrow();
  });
});

describe('drift detection', () => {
  test('an edit after acceptance resets the state to pending', () => {
    const [alpha] = reqs();
    const review = setState(emptyReview('c'), alpha!, 'accepted');

    const edited = reqs(SPEC.replace('SHALL alpha.', 'SHALL alpha differently.'));
    const [first] = reconcile(edited, review);

    expect(first!.state).toBe('pending');
    expect(first!.drifted).toBe(true);
    // The stored decision is preserved so the UI can say what it *was*.
    expect(first!.review.state).toBe('accepted');
  });

  test('reformatting does not count as drift', () => {
    const [alpha] = reqs();
    const review = setState(emptyReview('c'), alpha!, 'accepted');
    const reformatted = reqs(SPEC.replace('The system SHALL alpha.', 'The  system   SHALL alpha.\n'));
    const [first] = reconcile(reformatted, review);
    expect(first!.state).toBe('accepted');
    expect(first!.drifted).toBe(false);
  });

  test('a pending requirement can never be drifted', () => {
    const [first] = reconcile(reqs(), emptyReview('c'));
    expect(first!.state).toBe('pending');
    expect(first!.drifted).toBe(false);
  });

  test('a requirement no longer in the Markdown drops out of the queue', () => {
    const [alpha] = reqs();
    const review = setState(emptyReview('c'), alpha!, 'accepted');
    const reduced = reqs('## ADDED Requirements\n\n### Requirement: Beta\nThe system SHALL beta.\n');
    expect(reconcile(reduced, review).map((r) => r.item.id)).toEqual(['cap#beta']);
  });
});

describe('rename migration', () => {
  test('carries state from the old id to the new one', () => {
    const [alpha] = reqs();
    const review = setState(emptyReview('c'), alpha!, 'accepted');
    const migrated = applyRenames(review, [{ from: 'Alpha', to: 'Alpha renamed', capability: 'cap' }]);

    expect(migrated.requirements['cap#alpha']).toBeUndefined();
    expect(migrated.requirements['cap#alpha-renamed']?.state).toBe('accepted');
  });

  test('does not overwrite state already held under the new name', () => {
    const [alpha, beta] = reqs();
    let review = setState(emptyReview('c'), alpha!, 'accepted');
    review = setState(review, beta!, 'rejected');
    const migrated = applyRenames(review, [{ from: 'Alpha', to: 'Beta', capability: 'cap' }]);
    expect(migrated.requirements['cap#beta']?.state).toBe('rejected');
  });

  test('no renames is a no-op', () => {
    const review = setState(emptyReview('c'), reqs()[0]!, 'accepted');
    expect(applyRenames(review, [])).toBe(review);
  });
});

describe('summarize', () => {
  test('counts each state and reports completeness', () => {
    const [alpha, beta] = reqs();
    let review = setState(emptyReview('c'), alpha!, 'accepted');
    expect(summarize(reconcile(reqs(), review))).toMatchObject({
      total: 2, accepted: 1, pending: 1, complete: false,
    });

    review = setState(review, beta!, 'deferred', { deferReason: 'awaiting-deployment' });
    // Deferred counts toward completeness — that is what lets a change close
    // with deployment-dependent work outstanding (problem-analysis §8).
    expect(summarize(reconcile(reqs(), review))).toMatchObject({
      total: 2, accepted: 1, deferred: 1, pending: 0, complete: true,
    });
  });

  test('a rejected requirement blocks completeness', () => {
    const [alpha, beta] = reqs();
    let review = setState(emptyReview('c'), alpha!, 'accepted');
    review = setState(review, beta!, 'rejected', { note: 'too specific' });
    expect(summarize(reconcile(reqs(), review)).complete).toBe(false);
  });

  test('drift makes a complete change incomplete again', () => {
    const [alpha, beta] = reqs();
    let review = setState(emptyReview('c'), alpha!, 'accepted');
    review = setState(review, beta!, 'accepted');
    expect(summarize(reconcile(reqs(), review)).complete).toBe(true);

    const edited = reqs(SPEC.replace('SHALL beta.', 'SHALL beta more.'));
    const after = summarize(reconcile(edited, review));
    expect(after.complete).toBe(false);
    expect(after.drifted).toBe(1);
  });

  test('an empty queue is not complete', () => {
    // A specs artifact with no parseable requirements is a problem to show,
    // not a stage to wave through.
    expect(summarize([])).toMatchObject({ total: 0, complete: false });
  });
});
