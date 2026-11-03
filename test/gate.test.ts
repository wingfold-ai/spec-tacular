import { afterEach, describe, expect, test } from 'bun:test';
import { buildPipeline, buildsOnCode, type ReviewByArtifact } from '../src/core/pipeline.ts';
import { gateFor, riskWarnings, staleArtifacts } from '../src/core/gate.ts';
import type { OpenSpecArtifact, OpenSpecChangeStatus } from '../src/adapter/types.ts';
import type { ReviewSummary } from '../src/core/review.ts';

const a = (
  id: string,
  status: OpenSpecArtifact['status'],
  requires: string[] = [],
): OpenSpecArtifact => ({ id, status, requires, outputPath: `${id}.md` });

/** The spec-tacular schema's shape: design requires specs. */
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

const summary = (over: Partial<ReviewSummary> = {}): ReviewSummary => ({
  total: 10, accepted: 10, rejected: 0, deferred: 0, pending: 0, drifted: 0, complete: true,
  ...over,
});

const SEQUENCED = [
  a('proposal', 'done'),
  a('specs', 'done', ['proposal']),
  a('design', 'ready', ['specs']),
  a('tasks', 'blocked', ['specs', 'design']),
];

const pipeline = (reviews: ReviewByArtifact = {}) => buildPipeline(status(SEQUENCED), reviews);

describe('gateFor', () => {
  test('refuses design while spec requirements are still pending', () => {
    // M4's exit criterion.
    const gate = gateFor(
      pipeline({ specs: summary({ accepted: 4, pending: 6, complete: false }) }),
      'design',
    );
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toContain('design is not ready');
    expect(gate.allowed === false && gate.blockers).toEqual([
      'specs: 6 pending of 10 requirements',
    ]);
  });

  test('a rejected requirement blocks just as a pending one does', () => {
    const gate = gateFor(
      pipeline({ specs: summary({ accepted: 8, rejected: 2, complete: false }) }),
      'design',
    );
    expect(gate.allowed === false && gate.blockers[0]).toBe(
      'specs: 2 rejected of 10 requirements',
    );
  });

  test('counts both pending and rejected in the reason', () => {
    const gate = gateFor(
      pipeline({ specs: summary({ accepted: 5, pending: 3, rejected: 2, complete: false }) }),
      'design',
    );
    expect(gate.allowed === false && gate.blockers[0]).toBe(
      'specs: 3 pending and 2 rejected of 10 requirements',
    );
  });

  test('allows design once every requirement is accepted', () => {
    const gate = gateFor(pipeline({ specs: summary() }), 'design');
    expect(gate.allowed).toBe(true);
  });

  test('deferred requirements do not block — that is the point of deferring', () => {
    const gate = gateFor(
      pipeline({ specs: summary({ accepted: 8, deferred: 2, complete: true }) }),
      'design',
    );
    expect(gate.allowed).toBe(true);
  });

  test('refuses when a prerequisite has not been written at all', () => {
    const gate = gateFor(buildPipeline(status([
      a('proposal', 'ready'),
      a('specs', 'blocked', ['proposal']),
    ])), 'specs');
    expect(gate.allowed === false && gate.blockers).toEqual([
      'proposal has not been written yet',
    ]);
  });

  test('an artifact with no prerequisites is always allowed', () => {
    expect(gateFor(pipeline(), 'proposal').allowed).toBe(true);
  });

  test('reports every unmet prerequisite, not just the first', () => {
    const gate = gateFor(
      buildPipeline(status([
        a('proposal', 'done'),
        a('specs', 'ready', ['proposal']),
        a('design', 'ready', ['specs']),
        a('tasks', 'blocked', ['specs', 'design']),
      ])),
      'tasks',
    );
    expect(gate.allowed === false && gate.blockers).toEqual([
      'specs has not been written yet',
      'design has not been written yet',
    ]);
  });

  test('an unknown artifact is refused and the known ones are listed', () => {
    const gate = gateFor(pipeline(), 'nonsense');
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.blockers[0]).toContain('proposal, specs, design, tasks');
  });

  test('a prerequisite that is not an artifact in the schema is refused, not ignored', () => {
    const gate = gateFor(
      buildPipeline(status([a('proposal', 'done'), a('design', 'ready', ['ghost'])])),
      'design',
    );
    expect(gate.allowed === false && gate.blockers[0]).toContain('ghost is required');
  });

  test('a prose artifact is gated on existence, since acceptance is unmeasurable there', () => {
    // Honest about what cannot be checked: requiring acceptance with no review
    // data would block forever, and assuming it would be a lie.
    expect(gateFor(pipeline(), 'specs').allowed).toBe(true);
  });

  test('apply is gated by the schema apply.requires', () => {
    expect(gateFor(pipeline(), 'apply').allowed).toBe(false);
  });
});

describe('drift warnings', () => {
  const drifted = { specs: summary({ accepted: 9, pending: 1, drifted: 1, complete: false }) };

  test('drift on a prerequisite blocks and warns', () => {
    const gate = gateFor(pipeline(drifted), 'design');
    expect(gate.allowed).toBe(false);
    expect(gate.warnings).toEqual(['specs changed after review (1 requirement)']);
  });

  test('a written artifact whose prerequisite drifted is flagged stale', () => {
    // Both files still exist, so OpenSpec reports this change as fine.
    const stale = staleArtifacts(
      buildPipeline(
        status([
          a('proposal', 'done'),
          a('specs', 'done', ['proposal']),
          a('design', 'done', ['specs']),
        ]),
        drifted,
      ),
    );
    expect(stale).toEqual([
      { artifact: 'design', because: ['specs changed after review (1 requirement)'] },
    ]);
  });

  test('nothing is stale when no prerequisite drifted', () => {
    const clean = buildPipeline(
      status([a('proposal', 'done'), a('specs', 'done', ['proposal']), a('design', 'done', ['specs'])]),
      { specs: summary() },
    );
    expect(staleArtifacts(clean)).toEqual([]);
  });

  test('an unwritten artifact is never stale — there is nothing to be stale', () => {
    expect(staleArtifacts(pipeline(drifted))).toEqual([]);
  });

  test('pluralizes the drift count', () => {
    const gate = gateFor(
      pipeline({ specs: summary({ accepted: 7, pending: 3, drifted: 3, complete: false }) }),
      'design',
    );
    expect(gate.warnings[0]).toContain('(3 requirements)');
  });
});

describe('the Foundation gate', () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { foundationGate } = require('../src/core/gate.ts');
  const { foundationDir, scaffoldFoundation } = require('../src/core/foundation.ts');

  const dirs: string[] = [];
  const root = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'spectacular-fg-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('a scaffolded but unanswered Foundation blocks, naming what is open', () => {
    const r = root();
    scaffoldFoundation(r);
    const gate = foundationGate(r);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('ground rules are not settled');
    expect(gate.blockers.length).toBeGreaterThan(0);
    expect(gate.blockers[0]).toContain('foundation/');
  });

  test('questions left for later do not block the first change, but are named', () => {
    const { answerFoundation, guidedQuestions } = require('../src/core/foundation.ts');
    const r = root();
    // A new project: what nobody can answer on day one is left for later.
    scaffoldFoundation(r, { defer: true });
    expect(foundationGate(r).allowed).toBe(false);

    for (const q of guidedQuestions(r)) answerFoundation(q.item, 'Decided.');
    const gate = foundationGate(r);
    expect(gate.allowed).toBe(true);
    expect(gate.warnings).toContain('left for later: foundation/domain: Rules about the domain that must always hold.');
    expect(gate.warnings).toHaveLength(8);
  });

  test('an answered Foundation allows', () => {
    const r = root();
    mkdirSync(foundationDir(r), { recursive: true });
    writeFileSync(join(foundationDir(r), 'stack.md'), '# Stack\n\n## Language\n\nTypeScript.\n');
    expect(foundationGate(r).allowed).toBe(true);
  });

  test('no Foundation at all warns but never blocks', () => {
    // spec-tacular must stay usable on a repo that adopted OpenSpec before it
    // existed.
    const gate = foundationGate(root());
    expect(gate.allowed).toBe(true);
    expect(gate.warnings[0]).toContain('no Foundation yet');
  });
});

describe('risks in the pipeline', () => {
  const WITH_RISKS = [
    a('proposal', 'done'),
    a('specs', 'done', ['proposal']),
    a('risks', 'done', ['specs']),
    a('design', 'ready', ['specs', 'risks']),
    a('tasks', 'blocked', ['specs', 'risks', 'design']),
  ];

  test('design waits for every risk to be accepted, and says risks', () => {
    const p = buildPipeline(status(WITH_RISKS), {
      specs: summary(),
      risks: summary({ total: 3, accepted: 1, pending: 2, complete: false }),
    });
    const gate = gateFor(p, 'design');
    expect(gate.allowed === false && gate.blockers).toEqual(['risks: 2 pending of 3 risks']);
  });

  test('the risks may be written ahead, like the specs; the design may not', () => {
    const p = buildPipeline(status(WITH_RISKS), { specs: summary() }, {}, { waitingOn: ['before'] });
    expect(buildsOnCode(p, 'risks')).toBe(false);
    expect(buildsOnCode(p, 'design')).toBe(true);
  });

  test('names what the design and the tasks leave open', () => {
    const p = buildPipeline(status(WITH_RISKS), { specs: summary(), risks: summary() }, {}, {
      risks: { unanswered: ['A'], unguarded: ['A', 'B'], unproven: ['C'], outsideBoundary: ['x', 'y', 'z', 'w'], unmitigatedHigh: [] },
    });
    expect(gateFor(p, 'tasks').warnings).toContain('the design does not answer risk "A"');
    expect(gateFor(p, 'apply').warnings).toContain('no guard task for 2 risks: "A", "B"');
    expect(riskWarnings(p)).toEqual([
      'the design does not answer risk "A"',
      'no guard task for 2 risks: "A", "B"',
      'guard ticked off without being shown red: "C"',
      '4 files changed outside the boundary: x, y, z and 1 more',
    ]);
  });
});
