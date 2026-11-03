/**
 * Plain-text rendering of the pipeline.
 *
 * Exists so the overview works without a TTY — in CI, over a pipe, in a remote
 * session — and so the layout can be unit-tested without driving a terminal.
 * The TUI renders the same model; this is the reference output, not a fallback
 * afterthought.
 */

import {
  classWarnings,
  defectLabel,
  defectWarnings,
  evidenceWarnings,
  formalWarnings,
  riskWarnings,
  staleArtifacts,
} from '../core/gate.ts';
import type { ChangePipeline, Stage, StageState } from '../core/pipeline.ts';

const MARK: Record<StageState, string> = {
  accepted: '+', // written AND fully reviewed
  written: '*', //  written to disk, review unfinished or unknown
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
const GREEN = '\x1b[32m';
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
    if (s.state === 'accepted') return paint(cell, GREEN, color);
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
      ? `next: ${p.current.id}${p.current.state === 'written' ? ' (review)' : ''}`
      : 'planning complete — ready to apply';
    out.push(`${' '.repeat(width)}  ${paint(next, DIM, color)}`);
    const label = defectLabel(p);
    if (label) out.push(`${' '.repeat(width)}  ${paint(label, DIM, color)}`);
    if (p.formal && p.formal.formal > 0) {
      out.push(`${' '.repeat(width)}  ${paint(`formal: ${p.formal.formal}/${p.formal.total} requirements`, DIM, color)}`);
    }
    if (p.consequence?.class) {
      const rules = p.consequence.rules.length > 0 ? ` — ${p.consequence.rules.join(', ')}` : '';
      out.push(`${' '.repeat(width)}  ${paint(`class ${p.consequence.class}${rules}`, DIM, color)}`);
    }
    if (p.evidence && p.evidence.total > 0) {
      const e = p.evidence;
      const bits = [`${e.passing}/${e.total} verified`];
      if (e.excepted) bits.push(`${e.excepted} excepted`);
      if (e.failing) bits.push(`${e.failing} failing`);
      if (e.stale) bits.push(`${e.stale} stale`);
      if (e.unconnected) bits.push(`${e.unconnected} not connected`);
      if (e.missing) bits.push(`${e.missing} missing`);
      out.push(`${' '.repeat(width)}  ${paint(`evidence: ${bits.join(' · ')}`, e.complete ? GREEN : DIM, color)}`);
    }

    for (const stage of p.stages) {
      const r = stage.review;
      if (!r) continue;
      const bits = [`${r.accepted}/${r.total} accepted`];
      if (r.rejected) bits.push(`${r.rejected} rejected`);
      if (r.deferred) bits.push(`${r.deferred} deferred`);
      if (r.pending) bits.push(`${r.pending} pending`);
      // Drift is called out separately and in warning colour: it means a
      // decision a human already made is no longer valid.
      const line = `${stage.id}: ${bits.join(' · ')}`;
      out.push(
        `${' '.repeat(width)}  ` +
          paint(line, r.complete ? GREEN : DIM, color) +
          (r.drifted ? paint(`  ! ${r.drifted} changed since review`, YELLOW, color) : ''),
      );
    }

    // A downstream artifact written against something that changed since is
    // the precise failure the sequencing fix exists to prevent, and OpenSpec
    // cannot see it: both files still exist, so it reports everything fine.
    for (const stale of staleArtifacts(p)) {
      out.push(
        `${' '.repeat(width)}  ` +
          paint(`! ${stale.artifact} may be stale — ${stale.because.join('; ')}`, YELLOW, color),
      );
    }

    // What the risks still lack, files changed outside the boundary, and
    // what the change's class still asks for.
    for (const warning of [
      ...riskWarnings(p),
      ...classWarnings(p),
      ...evidenceWarnings(p),
      ...defectWarnings(p),
      ...formalWarnings(p),
    ]) {
      out.push(`${' '.repeat(width)}  ${paint(`! ${warning}`, YELLOW, color)}`);
    }

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
  const stale = pipelines.filter((p) => staleArtifacts(p).length > 0);
  const withGaps = pipelines.filter((p) => p.gaps.length > 0);

  out.push(
    paint(
      `${blocked.length} blocked stage${blocked.length === 1 ? '' : 's'} · ` +
        `${withGaps.length} change${withGaps.length === 1 ? '' : 's'} with an unwritten prerequisite · ` +
        `${stale.length} with a possibly stale artifact`,
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
      'legend: + accepted · * written (review unfinished) · > ready · o blocked.\n' +
        'A "?" marks an artifact whose prerequisite was never written; under\n' +
        'spec-driven that may be a deliberate skip.',
      DIM,
      color,
    ),
  );

  return out.join('\n');
}
