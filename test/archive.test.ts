import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveBlockedError, planArchive, prepareArchive } from '../src/core/archive.ts';
import { loadRegister } from '../src/core/pending.ts';
import { parseSpecFile } from '../src/core/requirements.ts';
import { emptyReview, reconcile, setState, type ChangeReview } from '../src/core/review.ts';

const SPEC = `# Spec Delta

## ADDED Requirements

### Requirement: Export produces a file
The system SHALL produce a portable file.

#### Scenario: Local export
- **WHEN** a user exports
- **THEN** a file is written

### Requirement: Export completes against a deployment
The system SHALL complete an export end to end in a deployed environment.

#### Scenario: Deployed export
- **WHEN** run against a deployment
- **THEN** the export finishes

### Requirement: Export is audited
The system SHALL record who exported what.
`;

const dirs: string[] = [];
const project = (content = SPEC, capability = 'data-export') => {
  const root = mkdtempSync(join(tmpdir(), 'spectacular-arch-'));
  dirs.push(root);
  const dir = join(root, 'openspec', 'changes', 'add-export', 'specs', capability);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'spec.md');
  writeFileSync(file, content, 'utf8');
  return { root, file };
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const load = (file: string, capability = 'data-export') =>
  parseSpecFile(readFileSync(file, 'utf8'), capability, file).requirements;

/** Accept the first and third, defer the second. */
function mixed(file: string): ChangeReview {
  const reqs = load(file);
  let review = setState(emptyReview('add-export'), reqs[0]!, 'accepted');
  review = setState(review, reqs[1]!, 'deferred', { deferReason: 'needs a deployed instance' });
  review = setState(review, reqs[2]!, 'accepted');
  return review;
}

describe('planArchive', () => {
  test('splits accepted from deferred', () => {
    const { file } = project();
    const plan = planArchive('add-export', reconcile(load(file), mixed(file)));

    expect(plan.merging).toEqual([
      'data-export#export-produces-a-file',
      'data-export#export-is-audited',
    ]);
    expect(plan.diverting.map((d) => d.name)).toEqual([
      'Export completes against a deployment',
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  test('carries the deferral reason and the full requirement into the register entry', () => {
    const { file } = project();
    const [diverted] = planArchive('add-export', reconcile(load(file), mixed(file))).diverting;

    expect(diverted!.needs).toBe('needs a deployed instance');
    expect(diverted!.change).toBe('add-export');
    expect(diverted!.body).toContain('#### Scenario: Deployed export');
  });

  test('a requirement that was never reviewed is unresolved', () => {
    const { file } = project();
    const reqs = load(file);
    const review = setState(emptyReview('add-export'), reqs[0]!, 'accepted');
    expect(planArchive('add-export', reconcile(reqs, review)).unresolved).toHaveLength(2);
  });

  test('a rejected requirement is unresolved too', () => {
    const { file } = project();
    const reqs = load(file);
    let review = setState(emptyReview('add-export'), reqs[0]!, 'accepted');
    review = setState(review, reqs[1]!, 'rejected', { note: 'too specific' });
    review = setState(review, reqs[2]!, 'accepted');
    expect(planArchive('add-export', reconcile(reqs, review)).unresolved).toEqual([
      'data-export#export-completes-against-a-deployment',
    ]);
  });

  test('notices a file that would be left with nothing', () => {
    const { file } = project();
    const reqs = load(file);
    let review = emptyReview('add-export');
    for (const r of reqs) review = setState(review, r, 'deferred', { deferReason: 'needs a deployment' });
    expect(planArchive('add-export', reconcile(reqs, review)).emptied).toEqual([file]);
  });

  test('records "not recorded" when a deferral somehow has no reason', () => {
    const { file } = project();
    const reqs = load(file);
    let review = setState(emptyReview('add-export'), reqs[0]!, 'accepted');
    review = setState(review, reqs[1]!, 'deferred');
    review = setState(review, reqs[2]!, 'accepted');
    expect(planArchive('add-export', reconcile(reqs, review)).diverting[0]!.needs).toBe(
      'not recorded',
    );
  });
});

describe('prepareArchive', () => {
  test('writes the register and strips the deferred requirement from the delta', () => {
    const { root, file } = project();
    const result = prepareArchive(root, 'add-export', reconcile(load(file), mixed(file)));

    const spec = readFileSync(file, 'utf8');
    expect(spec).toContain('### Requirement: Export produces a file');
    expect(spec).toContain('### Requirement: Export is audited');
    // Gone from what will merge into the baseline...
    expect(spec).not.toContain('Export completes against a deployment');
    expect(spec).not.toContain('#### Scenario: Deployed export');
    // ...but preserved in full, with what would verify it.
    const [pending] = loadRegister(root);
    expect(pending!.name).toBe('Export completes against a deployment');
    expect(pending!.body).toContain('#### Scenario: Deployed export');
    expect(pending!.needs).toBe('needs a deployed instance');
    expect(result.rewritten).toEqual([file]);
  });

  test('leaves the surviving requirements readable', () => {
    const { root, file } = project();
    prepareArchive(root, 'add-export', reconcile(load(file), mixed(file)));
    // The delta must still parse, or OpenSpec's archive cannot merge it.
    expect(load(file).map((r) => r.name)).toEqual([
      'Export produces a file',
      'Export is audited',
    ]);
    expect(readFileSync(file, 'utf8')).not.toMatch(/\n{3,}/);
  });

  test('removes a delta file whose every requirement deferred', () => {
    // An empty delta fails OpenSpec's validation, and a capability with
    // nothing verified has nothing to merge.
    const { root, file } = project();
    const reqs = load(file);
    let review = emptyReview('add-export');
    for (const r of reqs) review = setState(review, r, 'deferred', { deferReason: 'needs a deployment' });

    const result = prepareArchive(root, 'add-export', reconcile(reqs, review));
    expect(result.removed).toEqual([file]);
    expect(existsSync(file)).toBe(false);
    expect(loadRegister(root)).toHaveLength(3);
  });

  test('refuses while anything is unreviewed', () => {
    // Archiving then would merge text nobody agreed to — exactly what `--yes`
    // does, which is the behaviour this replaces.
    const { root, file } = project();
    const reqs = load(file);
    const review = setState(emptyReview('add-export'), reqs[0]!, 'accepted');
    expect(() => prepareArchive(root, 'add-export', reconcile(reqs, review))).toThrow(
      ArchiveBlockedError,
    );
    // And nothing was touched.
    expect(readFileSync(file, 'utf8')).toBe(SPEC);
    expect(loadRegister(root)).toEqual([]);
  });

  test('a change with nothing deferred is left alone entirely', () => {
    const { root, file } = project();
    const reqs = load(file);
    let review = emptyReview('add-export');
    for (const r of reqs) review = setState(review, r, 'accepted');

    const result = prepareArchive(root, 'add-export', reconcile(reqs, review));
    expect(result).toMatchObject({ rewritten: [], removed: [] });
    expect(readFileSync(file, 'utf8')).toBe(SPEC);
  });
});
