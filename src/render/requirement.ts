/**
 * Renders one requirement for review.
 *
 * One requirement, full width, nothing else competing for attention. The
 * failure mode being fixed is a wall of requirements; recreating that wall in
 * a TUI would fix nothing (docs/tui-design.md).
 *
 * Shared by the TUI and by `--print`, so the two can never disagree about what
 * a requirement looks like.
 */

import { isRequirement } from '../core/requirements.ts';
import type { ReviewedItem } from '../core/review.ts';
import type { ReviewSummary } from '../core/review.ts';

export interface RequirementViewOptions {
  /** 1-based position in the queue. */
  index: number;
  total: number;
  summary: ReviewSummary;
  /** Terminal width to wrap prose at. */
  width?: number;
}

const DEFAULT_WIDTH = 76;

/** Greedy word wrap. Long unbreakable tokens (URLs, paths) overflow rather than split. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line === '') line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line !== '') out.push(line);
  }
  return out;
}

export function renderProgressBar(summary: ReviewSummary, width = 28): string {
  const { total } = summary;
  if (total === 0) return '';
  // Each segment is floored, then `pending` absorbs the remainder, so the bar
  // is always exactly `width` wide and never over-reports progress.
  const seg = (n: number) => Math.floor((n / total) * width);
  const accepted = seg(summary.accepted);
  const deferred = seg(summary.deferred);
  const rejected = seg(summary.rejected);
  const rest = Math.max(0, width - accepted - deferred - rejected);
  return '█'.repeat(accepted) + '▒'.repeat(deferred) + '▓'.repeat(rejected) + '░'.repeat(rest);
}

export function renderCounts(summary: ReviewSummary): string {
  const bits = [`${summary.accepted} accepted`];
  if (summary.rejected) bits.push(`${summary.rejected} rejected`);
  if (summary.deferred) bits.push(`${summary.deferred} deferred`);
  bits.push(`${summary.pending} pending`);
  return bits.join(' · ');
}

export function renderRequirement(
  item: ReviewedItem,
  opts: RequirementViewOptions,
): string {
  const width = opts.width ?? DEFAULT_WIDTH;
  const r = item.item;
  const out: string[] = [];

  const noun = isRequirement(r)
    ? 'requirement'
    : r.capability.startsWith('foundation/')
      ? 'ground rule'
      : 'decision';
  const operation = isRequirement(r) ? `   [${r.operation}]` : '';
  out.push(`${r.capability}   ${noun} ${opts.index} of ${opts.total}${operation}`);
  out.push('');
  out.push(`${noun.charAt(0).toUpperCase()}${noun.slice(1)}: ${r.name}`);
  out.push('');
  out.push(...wrap(r.text, width));
  out.push('');

  const scenarios = isRequirement(r) ? r.scenarios : [];
  for (const scenario of scenarios) {
    out.push(`  Scenario: ${scenario.name}`);
    for (const line of scenario.body) out.push(`    ${line}`);
    out.push('');
  }
  if (isRequirement(r) && scenarios.length === 0) {
    // Worth saying out loud: OpenSpec requires at least one scenario, so none
    // is a defect in the spec, not merely an empty section. A decision has
    // none by nature, so the warning is scoped to requirements.
    out.push('  (no scenarios — every requirement must have at least one)');
    out.push('');
  }

  if (item.drifted) {
    out.push(
      `  ! changed since you marked it ${item.review.state} — review it again`,
      '',
    );
  } else if (item.state !== 'pending') {
    out.push(`  state: ${item.state}${item.review.note ? ` — ${item.review.note}` : ''}`, '');
  }

  out.push(`${renderProgressBar(opts.summary)}  ${renderCounts(opts.summary)}`);
  return out.join('\n');
}
