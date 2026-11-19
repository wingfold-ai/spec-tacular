import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext, buildPrompt, renderContext } from '../src/core/context.ts';
import { parseSpecFile } from '../src/core/requirements.ts';
import { emptyReview, reconcile, setState } from '../src/core/review.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-ctx-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SPEC = `## ADDED Requirements

### Requirement: Alpha
SHALL alpha.

### Requirement: Beta
SHALL beta.

### Requirement: Gamma
SHALL gamma.
`;

const reqs = () => parseSpecFile(SPEC, 'cap', '/p/specs/cap/spec.md').requirements;

function reviewed() {
  const all = reqs();
  let review = setState(emptyReview('c'), all[0]!, 'accepted');
  review = setState(review, all[1]!, 'deferred', { deferReason: 'awaiting-deployment' });
  review = setState(review, all[2]!, 'rejected', { note: 'too specific' });
  return reconcile(all, review);
}

describe('buildContext', () => {
  test('separates accepted from deferred and excludes rejected', () => {
    // A rejected requirement is not something to build against.
    const bundle = buildContext(root(), reviewed());
    expect(bundle.accepted.map((r) => r.item.name)).toEqual(['Alpha']);
    expect(bundle.deferred.map((r) => r.item.name)).toEqual(['Beta']);
  });

  test('reads foundation documents and ADRs when they exist', () => {
    const r = root();
    mkdirSync(join(r, 'spec-tacular', 'foundation'), { recursive: true });
    mkdirSync(join(r, 'spec-tacular', 'decisions'), { recursive: true });
    writeFileSync(join(r, 'spec-tacular', 'foundation', 'stack.md'), '# Stack\nTypeScript.');
    writeFileSync(join(r, 'spec-tacular', 'decisions', '0001-errors.md'), '# ADR 1\nResult types.');

    const bundle = buildContext(r, []);
    expect(bundle.foundation.map((d) => d.name)).toEqual(['stack.md']);
    expect(bundle.decisions[0]!.content).toContain('Result types');
    expect(bundle.missing).toEqual([]);
  });

  test('says what is missing rather than implying there are no rules', () => {
    // An absent section must not read as "there are no constraints".
    const bundle = buildContext(root(), []);
    expect(bundle.missing).toEqual([
      'no foundation documents yet',
      'no architectural decision records yet',
    ]);
  });

  test('ignores non-markdown files', () => {
    const r = root();
    mkdirSync(join(r, 'spec-tacular', 'foundation'), { recursive: true });
    writeFileSync(join(r, 'spec-tacular', 'foundation', 'notes.txt'), 'ignored');
    expect(buildContext(r, []).foundation).toEqual([]);
  });
});

describe('renderContext', () => {
  test('lists accepted requirements and tells the agent to treat them as fixed', () => {
    const out = renderContext(buildContext(root(), reviewed()));
    expect(out).toContain('Requirements a human has accepted');
    expect(out).toContain('cap: Alpha');
    expect(out).toContain('do not design around it');
  });

  test('marks deferred requirements with their reason and warns they are not done', () => {
    const out = renderContext(buildContext(root(), reviewed()));
    expect(out).toContain('cap: Beta (awaiting-deployment)');
    expect(out).toContain('Do not treat them as done');
  });

  test('never includes a rejected requirement', () => {
    expect(renderContext(buildContext(root(), reviewed()))).not.toContain('Gamma');
  });

  test('tells the agent not to diverge from an ADR silently', () => {
    const r = root();
    mkdirSync(join(r, 'spec-tacular', 'decisions'), { recursive: true });
    writeFileSync(join(r, 'spec-tacular', 'decisions', '0001-x.md'), '# ADR');
    expect(renderContext(buildContext(r, []))).toContain('never diverge silently');
  });

  test('states what context was unavailable', () => {
    expect(renderContext(buildContext(root(), []))).toContain('Context not available');
  });
});

describe('buildPrompt', () => {
  test('puts context before the instructions', () => {
    const prompt = buildPrompt(buildContext(root(), reviewed()), 'INSTRUCTIONS HERE');
    expect(prompt.indexOf('Alpha')).toBeLessThan(prompt.indexOf('INSTRUCTIONS HERE'));
    expect(prompt).toContain('INSTRUCTIONS HERE');
  });

  test('is just the instructions when there is no context at all', () => {
    const empty = { vision: '', foundation: [], decisions: [], accepted: [], deferred: [], missing: [] };
    expect(buildPrompt(empty, 'ONLY THIS')).toBe('ONLY THIS');
  });
});

describe('the roadmap in the context', () => {
  const ROADMAP = `vision: Split expenses
slices:
  - id: add-groups
    summary: Create a group
    status: done
  - id: add-expenses
    summary: Add an expense to a group
    status: active
    dependsOn: [add-groups]
  - id: settle-up
    summary: Settle balances
    status: planned
`;

  test('every agent sees the slices and which one its change is', () => {
    const d = root();
    mkdirSync(join(d, 'spec-tacular'), { recursive: true });
    writeFileSync(join(d, 'spec-tacular', 'roadmap.yaml'), ROADMAP);
    const text = renderContext(buildContext(d, [], 'add-expenses'));
    expect(text).toContain('# Roadmap');
    expect(text).toContain('This change is `add-expenses`');
    expect(text).toContain('- add-groups (done): Create a group');
    expect(text).toContain('- add-expenses (active) ← this change: Add an expense to a group');
    expect(text).toContain('- settle-up (planned): Settle balances');
  });

  test('a change outside the roadmap still sees it, without a current slice', () => {
    const d = root();
    mkdirSync(join(d, 'spec-tacular'), { recursive: true });
    writeFileSync(join(d, 'spec-tacular', 'roadmap.yaml'), ROADMAP);
    const text = renderContext(buildContext(d, [], 'fix-typo'));
    expect(text).toContain('# Roadmap');
    expect(text).not.toContain('This change is');
  });

  test('no roadmap, no section', () => {
    expect(renderContext(buildContext(root(), []))).not.toContain('# Roadmap');
  });
});
