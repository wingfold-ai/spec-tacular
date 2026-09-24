/**
 * Plain-text rendering of the pipeline.
 *
 * Exists so the overview works without a TTY — in CI, over a pipe, in a remote
 * session — and so the layout can be unit-tested without driving a terminal.
 * The TUI renders the same model; this is the reference output, not a fallback
 * afterthought.
 */

import type { ChangePipeline, Stage, StageState } from '../core/pipeline.ts';

const MARK: Record<StageState, string> = {
  written: '*', //  written to disk (not yet "accepted" — that is M2)
  ready: '>', //    actionable now
  blocked: 'o', //  prerequisites unmet
};

export interface RenderOptions {
  /** Emit ANSI colour. Off when not a TTY. */
  color?: boolean;
}

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function paint(s: string, code: string, on: boolean): string {
  return on ? `${code}${s}${RESET}` : s;
}

/** One change as a single line: `* proposal  * specs  > design  o tasks`. */
export function renderPipelineBar(p: ChangePipeline, opts: RenderOptions = {}): string {
  const color = opts.color ?? false;
  const cells = [...p.stages, p.apply].map((s) => {
    const cell = `${MARK[s.state]} ${s.id}`;
    if (s.state === 'ready') return paint(cell, BOLD, color);
    if (s.state === 'blocked') return paint(cell, DIM, color);
    return cell;
  });
  return cells.join('  ');
}

function describeBlocked(stage: Stage): string {
  return `${stage.id} blocked by ${stage.blockedBy.join(', ')}`;
}

/** The full overview: every change, its pipeline, and anything inconsistent. */
export function renderOverview(
  pipelines: ChangePipeline[],
  opts: RenderOptions & { failed?: string[]; root?: string } = {},
): string {
  const color = opts.color ?? false;
  const out: string[] = [];

  if (opts.root) out.push(paint(opts.root, DIM, color));
  out.push(
    `${pipelines.length} change${pipelines.length === 1 ? '' : 's'}`,
    '',
  );

  const width = Math.max(0, ...pipelines.map((p) => p.name.length));

  for (const p of pipelines) {
    out.push(
      `${paint(p.name.padEnd(width), BOLD, color)}  ${renderPipelineBar(p, opts)}`,
    );

    const next = p.current
      ? `next: ${p.current.id}`
      : 'planning complete — ready to apply';
    out.push(`${' '.repeat(width)}  ${paint(next, DIM, color)}`);

    for (const g of p.gaps) {
      // Worded as an observation, not a verdict: an optional artifact that was
      // deliberately skipped looks identical on disk. See PrerequisiteGap.
      out.push(
        `${' '.repeat(width)}  ` +
          paint(
            `? ${g.artifact} exists but ${g.missing.join(', ')} was never written`,
            YELLOW,
            color,
          ),
      );
    }
    out.push('');
  }

  const blocked = pipelines.flatMap((p) =>
    [...p.stages, p.apply].filter((s) => s.state === 'blocked').map(describeBlocked),
  );
  const withGaps = pipelines.filter((p) => p.gaps.length > 0);

  out.push(
    paint(
      `${blocked.length} blocked stage${blocked.length === 1 ? '' : 's'} · ` +
        `${withGaps.length} change${withGaps.length === 1 ? '' : 's'} with an unwritten prerequisite`,
      DIM,
      color,
    ),
  );

  if (opts.failed?.length) {
    out.push(
      paint(`${opts.failed.length} change(s) failed to load: ${opts.failed.join(', ')}`, YELLOW, color),
    );
  }

  out.push(
    paint(
      'note: "written" means the file exists, not that anyone accepted it —\n' +
        'review state arrives in M2. A "?" marks an artifact whose prerequisite\n' +
        'was never written; under spec-driven that may be a deliberate skip.',
      DIM,
      color,
    ),
  );

  return out.join('\n');
}
