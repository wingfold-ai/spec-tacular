import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenSpecArtifact, OpenSpecChangeStatus } from '../src/adapter/types.ts';
import { gateFor, staleArtifacts } from '../src/core/gate.ts';
import { nextStep } from '../src/core/guide.ts';
import { buildPipeline, type SignoffByArtifact } from '../src/core/pipeline.ts';
import { loadReview, saveReview, type ReviewSummary } from '../src/core/review.ts';
import { acceptDocument, hashDocument, loadSignoff } from '../src/core/signoff.ts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'spectacular-signoff-'));
  roots.push(root);
  return root;
};

const a = (id: string, status: OpenSpecArtifact['status'], requires: string[] = []): OpenSpecArtifact =>
  ({ id, status, requires, outputPath: `${id}.md` });

const status = (artifacts: OpenSpecArtifact[]): OpenSpecChangeStatus => ({
  changeName: 'c',
  schemaName: 'spec-tacular',
  changeRoot: '/tmp/c',
  artifactPaths: {},
  isPlanningComplete: false,
  applyRequires: ['tasks'],
  nextSteps: [],
  artifacts,
});

const specsDone: ReviewSummary = {
  total: 3, accepted: 3, rejected: 0, deferred: 0, pending: 0, drifted: 0, complete: true,
};

const ACCEPTED = { accepted: true, drifted: false };
const UNREAD = { accepted: false, drifted: false };
const CHANGED = { accepted: false, drifted: true };

describe('accepting a document', () => {
  test('holds for the text that was accepted, and no other', () => {
    const root = tempRoot();
    expect(loadSignoff(root, 'c', 'proposal', '# Why\nBecause.')).toEqual(UNREAD);

    acceptDocument(root, 'c', 'proposal', '# Why\nBecause.');
    expect(loadSignoff(root, 'c', 'proposal', '# Why\nBecause.')).toEqual(ACCEPTED);
    // Whitespace is not a change; words are.
    expect(loadSignoff(root, 'c', 'proposal', '# Why\n\n  Because.  ')).toEqual(ACCEPTED);
    expect(loadSignoff(root, 'c', 'proposal', '# Why\nBecause we must.')).toEqual(CHANGED);
    // One document's acceptance says nothing about another's.
    expect(loadSignoff(root, 'c', 'design', '# Why\nBecause.')).toEqual(UNREAD);
  });

  test('ticking tasks off is implementing them, not changing the plan', () => {
    const plan = '## 1. Setup\n- [ ] 1.1 Add the schema\n- [ ] 1.2 Wire it up';
    expect(hashDocument('## 1. Setup\n- [x] 1.1 Add the schema\n- [X] 1.2 Wire it up')).toBe(hashDocument(plan));
    expect(hashDocument('## 1. Setup\n- [ ] 1.1 Add the schema')).not.toBe(hashDocument(plan));
  });

  test('lives beside the requirement review, without disturbing it', () => {
    const root = tempRoot();
    saveReview(root, {
      change: 'c',
      schemaVersion: 1,
      requirements: { 'auth/login': { state: 'accepted', hash: 'sha256:x', reviewedAt: '2026-09-29' } },
      cursor: 'auth/login',
    });
    acceptDocument(root, 'c', 'proposal', 'text');
    const review = loadReview(root, 'c');
    expect(review.requirements['auth/login']?.state).toBe('accepted');
    expect(review.cursor).toBe('auth/login');
    expect(Object.keys(review.documents ?? {})).toEqual(['proposal']);
  });
});

describe('in the pipeline', () => {
  const change = (signoffs: SignoffByArtifact) =>
    buildPipeline(
      status([
        a('proposal', 'done'),
        a('specs', 'done', ['proposal']),
        a('design', 'done', ['specs']),
        a('tasks', 'ready', ['specs', 'design']),
      ]),
      { specs: specsDone },
      signoffs,
    );

  test('an accepted document is ticked off, as accepted specs are', () => {
    const p = change({ proposal: ACCEPTED, design: ACCEPTED });
    expect(p.stages.map((s) => s.state)).toEqual(['accepted', 'accepted', 'accepted', 'ready']);
    expect(p.accepted).toBe(3);
    expect(p.current?.id).toBe('tasks');
  });

  test('one not accepted yet is the next thing to do: read it', () => {
    const p = change({ proposal: ACCEPTED, design: UNREAD });
    expect(p.stages[2]?.state).toBe('written');
    expect(p.current?.id).toBe('design');
    const step = nextStep(p, true);
    expect(step.actions).toEqual(['read']);
    expect(step.artifact).toBe('design');
    expect(step.text).toBe('Read the design, then accept it or ask for changes.');
  });

  test('the next stage waits for it', () => {
    const gate = gateFor(change({ proposal: ACCEPTED, design: UNREAD }), 'tasks');
    expect(gate.allowed === false && gate.blockers).toEqual(['design has not been accepted yet']);
    expect(gateFor(change({ proposal: ACCEPTED, design: ACCEPTED }), 'tasks').allowed).toBe(true);
  });

  test('changed since it was accepted: read again, and what came after is stale', () => {
    const p = change({ proposal: CHANGED, design: ACCEPTED });
    expect(p.stages[0]?.state).toBe('written');
    expect(nextStep(p, true).text).toContain('The proposal changed since you accepted it');
    expect(gateFor(p, 'specs').allowed === false && gateFor(p, 'specs')).toMatchObject({
      blockers: ['proposal changed since it was accepted'],
    });
    expect(staleArtifacts(p)).toEqual([
      { artifact: 'specs', because: ['proposal changed after it was accepted'] },
    ]);
  });
});
