/**
 * The review record: `openspec/changes/<id>/review.md`, what a human decided
 * about a change, in a file that travels with it.
 *
 * The decisions are the one thing spec-tacular adds to OpenSpec, and the
 * sidecar they live in (`.spec-tacular/review/<change>.json`) is local
 * state. The record is written from it on every decision and once more before
 * archiving, so `openspec archive` moves it into the archive and the decisions
 * stay readable with plain OpenSpec and git, without spec-tacular — and the
 * marker on its first line shows spec-tacular was used (core/provenance.ts).
 *
 * It is written, never read back. The same decisions give the same file: no
 * clock, no absolute paths, items in queue order.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenSpecChangeStatus } from '../adapter/types.ts';
import { loadChangeReview, type ChangeReviewQueue } from './change-review.ts';
import { loadEvidence, type ItemEvidence } from './evidence.ts';
import { isHarnessItem, loadAllowed, type AllowedSurvivors } from './formal/harness.ts';
import { withMarker } from './provenance.ts';
import { isQuestion } from './questions.ts';
import type { ReviewItem } from './requirements.ts';
import type { ReviewedItem } from './review.ts';

export const RECORD_FILE = 'review.md';

export interface RecordExtras {
  /** Surviving mutants allowed per component, with the reason given. */
  allowed?: AllowedSurvivors[];
  /** Items whose evidence was waived, with the reason. */
  waivers?: { item: string; reason: string; at: string }[];
  /** Each item's evidence at archive time, where the project keeps evidence. */
  evidence?: ItemEvidence[];
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

/** What kind of item it is, and where it belongs, for a reader of the file. */
export function describeItem(item: ReviewItem): string {
  if (isQuestion(item)) return `Question on “${item.parentName}”: ${item.question}${item.answer ? ` — ${item.answer}` : ''}`;
  if (item.capability === 'risks') return `Risk: ${item.name}`;
  if (item.capability === 'design') return `Decision: ${item.name}`;
  if (isHarnessItem(item)) return `Harness (${item.capability.slice('harness/'.length)}): ${item.name}`;
  return `Requirement (${item.capability}): ${item.name}`;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function renderReviewRecord(queue: ChangeReviewQueue, extras: RecordExtras = {}): string {
  const by = (state: ReviewedItem['state']) => queue.requirements.filter((r) => r.state === state);
  const accepted = by('accepted');
  const rejected = by('rejected');
  const deferred = by('deferred');
  const pending = by('pending');

  const lines = [
    '<!-- Written by spec-tacular from its review state; edits here are overwritten. -->',
    `# Review: ${queue.change}`,
    '',
    `${accepted.length} accepted · ${rejected.length} rejected · ${deferred.length} deferred · ${pending.length} pending`,
    '',
  ];

  const documents = Object.entries(queue.review.documents ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (documents.length > 0) {
    lines.push('## Documents accepted as a whole', '');
    for (const [artifact, d] of documents) lines.push(`- ${artifact} — ${day(d.acceptedAt)}`);
    lines.push('');
  }

  const section = (title: string, items: ReviewedItem[], detail: (r: ReviewedItem) => string) => {
    if (items.length === 0) return;
    lines.push(`## ${title}`, '');
    for (const r of items) {
      const extra = detail(r);
      const when = day(r.review.reviewedAt);
      lines.push(`- ${describeItem(r.item)}${extra ? ` — ${extra}` : ''}${when ? ` (${when})` : ''}`);
    }
    lines.push('');
  };
  section('Accepted', accepted, () => '');
  section('Rejected', rejected, (r) => (r.review.note ? `why: ${oneLine(r.review.note)}` : ''));
  section('Deferred', deferred, (r) => (r.review.deferReason ? `waits for: ${oneLine(r.review.deferReason)}` : ''));
  section('Not decided yet', pending, (r) => (r.drifted ? 'changed since it was reviewed' : ''));

  const allowed = [...(extras.allowed ?? [])].sort((a, b) => a.component.localeCompare(b.component));
  if (allowed.length > 0) {
    lines.push('## Surviving mutants allowed', '');
    for (const a of allowed) lines.push(`- ${a.component}: ${a.survivors.length} — ${oneLine(a.reason)} (${day(a.at)})`);
    lines.push('');
  }

  const waivers = [...(extras.waivers ?? [])].sort((a, b) => a.item.localeCompare(b.item));
  if (waivers.length > 0) {
    lines.push('## Evidence waived', '');
    for (const w of waivers) lines.push(`- ${w.item} — ${oneLine(w.reason)} (${day(w.at)})`);
    lines.push('');
  }

  if (extras.evidence && extras.evidence.length > 0) {
    lines.push('## Evidence at archive', '');
    for (const e of extras.evidence) {
      lines.push(`- ${e.state}: ${describeItem(e.item)}${e.tests.length > 0 ? ` — ${e.tests.join(', ')}` : ''}`);
    }
    lines.push('');
  }

  return withMarker(lines.join('\n'), 'markdown');
}

/** The waivers in a change's evidence log, the latest per item. */
export function waiversOf(projectRoot: string, change: string): RecordExtras['waivers'] {
  const latest = new Map<string, { item: string; reason: string; at: string }>();
  for (const r of loadEvidence(projectRoot, change)) {
    if (r.kind === 'waive') latest.set(r.item, { item: r.item, reason: r.reason, at: r.at });
  }
  return [...latest.values()];
}

/** The allowances of the harness components a change's items run through. */
export function allowancesOf(projectRoot: string, queue: ChangeReviewQueue): AllowedSurvivors[] {
  const components = new Set(
    queue.requirements.filter((r) => isHarnessItem(r.item)).map((r) => r.item.capability.slice('harness/'.length)),
  );
  return [...components].flatMap((c) => loadAllowed(projectRoot, c) ?? []);
}

/**
 * Writes the change's record from its review state, and returns its path.
 * Nothing is written for a change folder that no longer exists — an archived
 * change's record was written before it moved.
 */
export function writeReviewRecord(
  projectRoot: string,
  status: OpenSpecChangeStatus,
  options: { evidence?: ItemEvidence[] } = {},
): string | null {
  if (!existsSync(status.changeRoot)) return null;
  const queue = loadChangeReview(projectRoot, status, { includeDecisions: true });
  const path = join(status.changeRoot, RECORD_FILE);
  const content = renderReviewRecord(queue, {
    allowed: allowancesOf(projectRoot, queue),
    waivers: waiversOf(projectRoot, status.changeName),
    ...(options.evidence ? { evidence: options.evidence } : {}),
  });
  writeFileSync(path, `${content.trimEnd()}\n`, 'utf8');
  return path;
}
