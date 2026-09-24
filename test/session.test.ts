import { describe, expect, test } from 'bun:test';
import { parseSpecFile, type Requirement } from '../src/core/requirements.ts';
import { emptyReview, setState, type ChangeReview } from '../src/core/review.ts';
import {
  currentItem,
  decide,
  move,
  openSession,
  position,
  refresh,
  skip,
} from '../src/core/session.ts';
import { buildRevisionBundle } from '../src/core/revision.ts';

const SPEC = `## ADDED Requirements

### Requirement: Alpha
SHALL alpha.

#### Scenario: A
- **WHEN** a
- **THEN** b

### Requirement: Beta
SHALL beta.

### Requirement: Gamma
SHALL gamma.
`;

const reqs = (md = SPEC): Requirement[] =>
  parseSpecFile(md, 'cap', '/p/specs/cap/spec.md').requirements;

const open = (review: ChangeReview = emptyReview('c'), md = SPEC) =>
  openSession('c', reqs(md), review);

const names = (s: ReturnType<typeof open>) => s.items.map((i) => i.item.name);

describe('opening and resuming', () => {
  test('a fresh session starts at the first requirement', () => {
    const s = open();
    expect(names(s)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(currentItem(s)?.item.name).toBe('Alpha');
    expect(position(s)).toEqual({ index: 1, total: 3 });
  });

  test('resumes at the stored cursor', () => {
    const review = { ...emptyReview('c'), cursor: 'cap#gamma' };
    expect(currentItem(open(review))?.item.name).toBe('Gamma');
  });

  test('with no cursor, starts at the first requirement still needing attention', () => {
    // Reopening a mostly-reviewed change should not make you walk past the
    // accepted ones to reach the work.
    let review = setState(emptyReview('c'), reqs()[0]!, 'accepted');
    review = setState(review, reqs()[1]!, 'accepted');
    expect(currentItem(open(review))?.item.name).toBe('Gamma');
  });

  test('a stored cursor pointing at a deleted requirement falls back safely', () => {
    const review = { ...emptyReview('c'), cursor: 'cap#deleted' };
    expect(currentItem(open(review))?.item.name).toBe('Alpha');
  });

  test('an empty queue yields no current item and does not throw', () => {
    const s = open(emptyReview('c'), '# Spec Delta\n');
    expect(currentItem(s)).toBeNull();
    expect(position(s)).toEqual({ index: 0, total: 0 });
    expect(decide(s, 'accepted')).toBe(s);
    expect(skip(s)).toBe(s);
    expect(move(s, 1)).toBe(s);
  });
});

describe('navigation', () => {
  test('n/p move one step and clamp at the ends', () => {
    let s = open();
    s = move(s, 1);
    expect(currentItem(s)?.item.name).toBe('Beta');
    s = move(s, -1);
    expect(currentItem(s)?.item.name).toBe('Alpha');
    // Clamped, not wrapped: wrapping loses your place in a long queue.
    s = move(s, -1);
    expect(currentItem(s)?.item.name).toBe('Alpha');
    s = move(s, 99);
    expect(currentItem(s)?.item.name).toBe('Gamma');
  });

  test('moving records the cursor so the position survives a restart', () => {
    const s = move(open(), 2);
    expect(s.review.cursor).toBe('cap#gamma');
    expect(currentItem(open(s.review))?.item.name).toBe('Gamma');
  });
});

describe('deciding', () => {
  test('accepting records the state and advances to the next open item', () => {
    const s = decide(open(), 'accepted');
    expect(s.items[0]!.state).toBe('accepted');
    expect(currentItem(s)?.item.name).toBe('Beta');
    expect(s.summary.accepted).toBe(1);
  });

  test('a rejection carries its reason', () => {
    const s = decide(open(), 'rejected', { note: 'names an endpoint' });
    expect(s.items[0]!.state).toBe('rejected');
    expect(s.items[0]!.review.note).toBe('names an endpoint');
  });

  test('a deferral carries its reason and counts toward completeness', () => {
    let s = open();
    s = decide(s, 'deferred', { deferReason: 'awaiting-deployment' });
    s = decide(s, 'accepted');
    s = decide(s, 'accepted');
    expect(s.summary).toMatchObject({ deferred: 1, accepted: 2, complete: true });
  });

  test('deciding the last open item wraps to the first still-open one', () => {
    // "Next" here means "what else needs me", which has no spatial meaning —
    // unlike n/p, which must not wrap.
    let s = open();
    s = move(s, 2);              // at Gamma
    s = decide(s, 'accepted');   // Gamma done; Alpha and Beta still open
    expect(currentItem(s)?.item.name).toBe('Alpha');
  });

  test('accepting the final open item leaves the cursor put', () => {
    let s = open();
    s = decide(s, 'accepted');
    s = decide(s, 'accepted');
    s = decide(s, 'accepted');
    expect(s.summary.complete).toBe(true);
    expect(currentItem(s)?.item.name).toBe('Gamma');
  });

  test('a rejected requirement is still open, so review returns to it', () => {
    let s = open();
    s = decide(s, 'rejected', { note: 'too specific' });
    expect(currentItem(s)?.item.name).toBe('Beta');
    s = decide(s, 'accepted');
    s = decide(s, 'accepted');
    // Alpha was rejected, so it is the only thing left needing attention.
    expect(currentItem(s)?.item.name).toBe('Alpha');
  });

  test('skipping advances without recording a decision', () => {
    const s = skip(open());
    expect(s.items[0]!.state).toBe('pending');
    expect(currentItem(s)?.item.name).toBe('Beta');
  });
});

describe('refresh after an external edit', () => {
  test('keeps your place when the requirement still exists', () => {
    let s = move(open(), 1);
    s = refresh(s, reqs(SPEC.replace('SHALL gamma.', 'SHALL gamma differently.')));
    expect(currentItem(s)?.item.name).toBe('Beta');
  });

  test('surfaces drift on a requirement that was edited after acceptance', () => {
    let s = decide(open(), 'accepted');
    s = refresh(s, reqs(SPEC.replace('SHALL alpha.', 'SHALL alpha otherwise.')));
    expect(s.items[0]!.drifted).toBe(true);
    expect(s.items[0]!.state).toBe('pending');
  });

  test('clamps the cursor when requirements disappear', () => {
    let s = move(open(), 2);
    s = refresh(s, reqs('## ADDED Requirements\n\n### Requirement: Alpha\nSHALL alpha.\n'));
    expect(position(s)).toEqual({ index: 1, total: 1 });
  });
});

describe('revision bundle', () => {
  test('lists only the rejected requirements, with reasons', () => {
    let s = open();
    s = decide(s, 'rejected', { note: 'names an endpoint that is not decided' });
    s = decide(s, 'accepted');

    const bundle = buildRevisionBundle('c', s.items);
    expect(bundle.rejected.map((r) => r.item.name)).toEqual(['Alpha']);
    expect(bundle.instruction).toContain('Requirement: Alpha');
    expect(bundle.instruction).toContain('names an endpoint that is not decided');
    // The accepted one must not be offered up for rewriting.
    expect(bundle.instruction).not.toContain('Requirement: Beta');
    expect(bundle.instruction).toContain('leave them byte-for-byte unchanged');
  });

  test('says so plainly when nothing was rejected', () => {
    const bundle = buildRevisionBundle('c', open().items);
    expect(bundle.rejected).toEqual([]);
    expect(bundle.instruction).toContain('Nothing to revise');
  });

  test('handles a rejection with no reason given', () => {
    const s = decide(open(), 'rejected');
    expect(buildRevisionBundle('c', s.items).instruction).toContain('(none given)');
  });
});
