import { describe, expect, test } from 'bun:test';
import { buildPipeline } from '../src/core/pipeline.ts';
import { renderOverview, renderPipelineBar } from '../src/render/text.ts';
import type { OpenSpecArtifact, OpenSpecChangeStatus } from '../src/adapter/types.ts';

const a = (
  id: string,
  status: OpenSpecArtifact['status'],
  requires: string[] = [],
): OpenSpecArtifact => ({ id, status, requires, outputPath: `${id}.md` });

const status: OpenSpecChangeStatus = {
  changeName: 'add-dark-mode',
  schemaName: 'spec-driven',
  changeRoot: '/tmp/add-dark-mode',
  artifactPaths: {},
  isPlanningComplete: false,
  applyRequires: ['tasks'],
  nextSteps: [],
  artifacts: [
    a('proposal', 'done'),
    a('specs', 'done', ['proposal']),
    a('design', 'ready', ['proposal']),
    a('tasks', 'done', ['specs', 'design']),
  ],
};

describe('renderPipelineBar', () => {
  test('shows every stage plus apply, in schema order', () => {
    const bar = renderPipelineBar(buildPipeline(status));
    expect(bar).toContain('* proposal');
    expect(bar).toContain('> design');
    expect(bar).toContain('apply');
    expect(bar.indexOf('proposal')).toBeLessThan(bar.indexOf('design'));
  });

  test('emits no ANSI codes unless colour is requested', () => {
    expect(renderPipelineBar(buildPipeline(status))).not.toContain('\x1b[');
    expect(renderPipelineBar(buildPipeline(status), { color: true })).toContain('\x1b[');
  });
});

describe('renderOverview', () => {
  const out = renderOverview([buildPipeline(status)], { root: '/tmp/proj' });

  test('names the change and its next actionable stage', () => {
    expect(out).toContain('add-dark-mode');
    expect(out).toContain('next: design');
  });

  test('surfaces an unwritten prerequisite by name', () => {
    expect(out).toContain('tasks exists but design was never written');
  });

  test('distinguishes written from accepted in the legend', () => {
    expect(out).toContain('+ accepted');
    expect(out).toContain('* written (review unfinished)');
  });

  test('an artifact with no review data is never shown as accepted', () => {
    // Absence of review is not evidence of review.
    expect(renderPipelineBar(buildPipeline(status))).toContain('* specs');
    expect(renderPipelineBar(buildPipeline(status))).not.toContain('+ specs');
  });

  test('shows review progress when the artifact carries requirements', () => {
    const withReview = renderOverview(
      [
        buildPipeline(status, {
          specs: { total: 10, accepted: 7, rejected: 1, deferred: 0, pending: 2, drifted: 0, complete: false },
        }),
      ],
      {},
    );
    expect(withReview).toContain('specs: 7/10 accepted · 1 rejected · 2 pending');
  });

  test('marks a fully reviewed artifact accepted and calls out drift', () => {
    const accepted = buildPipeline(status, {
      specs: { total: 4, accepted: 3, rejected: 0, deferred: 1, pending: 0, drifted: 0, complete: true },
    });
    expect(renderPipelineBar(accepted)).toContain('+ specs');

    const drifted = renderOverview([
      buildPipeline(status, {
        specs: { total: 4, accepted: 3, rejected: 0, deferred: 0, pending: 1, drifted: 1, complete: false },
      }),
    ]);
    expect(drifted).toContain('1 changed since review');
  });

  test('reports changes that failed to load', () => {
    const withFailure = renderOverview([buildPipeline(status)], { failed: ['broken'] });
    expect(withFailure).toContain('failed to load: broken');
  });

  test('handles an empty project without crashing', () => {
    expect(renderOverview([])).toContain('0 changes');
  });
});
