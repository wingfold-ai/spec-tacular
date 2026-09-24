import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completeSlice,
  loadRoadmap,
  nextPromotable,
  promoteSlice,
  roadmapPath,
  saveRoadmap,
  scaffoldRoadmap,
  type Roadmap,
} from '../src/core/roadmap.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-road-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const roadmap = (): Roadmap => ({
  vision: 'A tool for reviewing specs.',
  slices: [
    { id: 'auth', summary: 'Users can sign in', status: 'planned', dependsOn: [] },
    { id: 'export', summary: 'Users can export', status: 'planned', dependsOn: ['auth'] },
    { id: 'billing', summary: 'Users can pay', status: 'planned', dependsOn: [] },
  ],
});

describe('persistence', () => {
  test('round-trips', () => {
    const r = root();
    saveRoadmap(r, roadmap());
    expect(loadRoadmap(r)).toEqual(roadmap());
  });

  test('scaffolds once and never overwrites', () => {
    const r = root();
    expect(scaffoldRoadmap(r)).toBe(true);
    expect(loadRoadmap(r)?.vision).toContain('TBD');

    saveRoadmap(r, roadmap());
    expect(scaffoldRoadmap(r)).toBe(false);
    expect(loadRoadmap(r)?.vision).toBe('A tool for reviewing specs.');
  });

  test('an absent roadmap is null, not an error', () => {
    expect(loadRoadmap(root())).toBeNull();
  });

  test('broken YAML degrades rather than throwing', () => {
    const r = root();
    mkdirSync(join(r, 'spec-tacular'), { recursive: true });
    writeFileSync(roadmapPath(r), 'vision: [unclosed\n');
    expect(loadRoadmap(r)).toBeNull();
  });

  test('a slice with no id is dropped, and an unknown status reads as planned', () => {
    // The safe reading is that a slice has not started, never that it is done.
    const r = root();
    mkdirSync(join(r, 'spec-tacular'), { recursive: true });
    writeFileSync(
      roadmapPath(r),
      'vision: v\nslices:\n  - summary: nameless\n  - id: ok\n    status: nonsense\n',
    );
    const loaded = loadRoadmap(r)!;
    expect(loaded.slices.map((s) => s.id)).toEqual(['ok']);
    expect(loaded.slices[0]!.status).toBe('planned');
  });
});

describe('promoting', () => {
  test('makes a slice active', () => {
    const result = promoteSlice(roadmap(), 'auth');
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.roadmap.slices[0]!.status).toBe('active');
  });

  test('only one slice may be active at a time', () => {
    // The single rule that stops a greenfield project becoming a dozen
    // changes nobody can review.
    const promoted = promoteSlice(roadmap(), 'auth');
    const second = promoteSlice(promoted.ok === true ? promoted.roadmap : roadmap(), 'billing');
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toContain('already active');
    expect(second.ok === false && second.reason).toContain('one slice at a time');
  });

  test('refuses while a dependency is unfinished', () => {
    const result = promoteSlice(roadmap(), 'export');
    expect(result.ok === false && result.reason).toContain('depends on auth');
  });

  test('allows once the dependency is done', () => {
    const done = completeSlice(roadmap(), 'auth');
    expect(promoteSlice(done.ok === true ? done.roadmap : roadmap(), 'export').ok).toBe(true);
  });

  test('a dependency that does not exist blocks rather than passing on a typo', () => {
    const broken: Roadmap = {
      vision: '',
      slices: [{ id: 'a', summary: '', status: 'planned', dependsOn: ['typo'] }],
    };
    expect(promoteSlice(broken, 'a').ok).toBe(false);
  });

  test('refuses an unknown or finished slice', () => {
    expect(promoteSlice(roadmap(), 'nope').ok).toBe(false);
    const done = completeSlice(roadmap(), 'auth');
    const again = promoteSlice(done.ok === true ? done.roadmap : roadmap(), 'auth');
    expect(again.ok === false && again.reason).toContain('already done');
  });
});

describe('nextPromotable', () => {
  test('is the first unblocked planned slice', () => {
    expect(nextPromotable(roadmap())?.id).toBe('auth');
  });

  test('is nothing while a slice is active', () => {
    const promoted = promoteSlice(roadmap(), 'auth');
    expect(nextPromotable(promoted.ok === true ? promoted.roadmap : roadmap())).toBeNull();
  });

  test('skips a slice whose dependency is unfinished', () => {
    const only: Roadmap = {
      vision: '',
      slices: [
        { id: 'a', summary: '', status: 'done', dependsOn: [] },
        { id: 'b', summary: '', status: 'planned', dependsOn: ['c'] },
        { id: 'c', summary: '', status: 'done', dependsOn: [] },
      ],
    };
    expect(nextPromotable(only)?.id).toBe('b');
  });

  test('is null when everything is done', () => {
    let current = roadmap();
    for (const id of ['auth', 'export', 'billing']) {
      const done = completeSlice(current, id);
      if (done.ok) current = done.roadmap;
    }
    expect(nextPromotable(current)).toBeNull();
  });
});
