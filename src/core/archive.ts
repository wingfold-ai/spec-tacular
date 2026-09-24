/**
 * The archive split.
 *
 * Accepted requirements merge into `openspec/specs/` through OpenSpec's own
 * archive; deferred ones divert to the pending-validation register instead. A
 * change whose only outstanding work needs a deployed environment closes
 * cleanly, and what was never verified stays visible and out of the accepted
 * baseline (docs/problem-analysis.md §8).
 *
 * This rewrites a change's delta files before archiving, which the adapter
 * rule otherwise forbids. The exception is narrow and the content is never
 * lost: every removed requirement is written to the register first, in full,
 * with what would verify it. Preparation is a separate, inspectable step from
 * the archive itself precisely because it edits files.
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  buildCodeFenceMask,
  normalizeContent,
  REQUIREMENT_HEADER,
  SECTION_HEADER,
  normalizeRequirementName,
} from './markdown.ts';
import { addToRegister, type PendingEntry } from './pending.ts';
import type { ReviewedItem } from './review.ts';
import { isRequirement } from './requirements.ts';

export interface ArchivePlan {
  change: string;
  /** Requirements that will merge into the accepted baseline. */
  merging: string[];
  /** Requirements that will divert to the register. */
  diverting: PendingEntry[];
  /** Requirements neither accepted nor deferred — these block the archive. */
  unresolved: string[];
  /** Delta files that would be left with no requirements at all. */
  emptied: string[];
}

/** What would happen, without touching anything. */
export function planArchive(change: string, reviewed: ReviewedItem[]): ArchivePlan {
  const requirements = reviewed.filter((r) => isRequirement(r.item));

  const merging: string[] = [];
  const diverting: PendingEntry[] = [];
  const unresolved: string[] = [];

  for (const entry of requirements) {
    if (entry.state === 'accepted') merging.push(entry.item.id);
    else if (entry.state === 'deferred') {
      diverting.push({
        capability: entry.item.capability,
        name: entry.item.name,
        body: requirementBody(entry.item.file, entry.item.name),
        change,
        deferred: new Date().toISOString().slice(0, 10),
        needs: entry.review.deferReason || 'not recorded',
      });
    } else unresolved.push(entry.item.id);
  }

  // A file every one of whose requirements diverts would be left empty, and
  // OpenSpec rejects a change with zero deltas.
  const byFile = new Map<string, { total: number; kept: number }>();
  for (const entry of requirements) {
    const file = entry.item.file;
    const counts = byFile.get(file) ?? { total: 0, kept: 0 };
    counts.total++;
    if (entry.state !== 'deferred') counts.kept++;
    byFile.set(file, counts);
  }
  const emptied = [...byFile].filter(([, c]) => c.kept === 0).map(([file]) => file);

  return { change, merging, diverting, unresolved, emptied };
}

/** The requirement's block as written, for preservation in the register. */
function requirementBody(file: string, name: string): string {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const lines = normalizeContent(content).split('\n');
  const mask = buildCodeFenceMask(lines);
  const target = normalizeRequirementName(name);

  for (let i = 0; i < lines.length; i++) {
    const header = (lines[i] ?? '').match(REQUIREMENT_HEADER);
    if (mask[i] || !header?.[1] || normalizeRequirementName(header[1]) !== target) continue;

    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (!mask[j] && (REQUIREMENT_HEADER.test(next) || SECTION_HEADER.test(next))) break;
      body.push(next);
    }
    return body.join('\n').trim();
  }
  return '';
}

export interface PrepareResult {
  plan: ArchivePlan;
  /** Delta files rewritten to drop diverted requirements. */
  rewritten: string[];
  /** Delta files removed because nothing was left in them. */
  removed: string[];
}

export class ArchiveBlockedError extends Error {
  constructor(readonly plan: ArchivePlan) {
    super(
      `${plan.change} has ${plan.unresolved.length} requirement(s) that are neither accepted nor deferred. ` +
        'Review them, or defer the ones that cannot be verified yet.',
    );
    this.name = 'ArchiveBlockedError';
  }
}

/**
 * Moves deferred requirements to the register and strips them from the deltas.
 *
 * Refuses outright when anything is still unreviewed: archiving then would be
 * exactly the `--yes` behaviour this replaces, merging text nobody agreed to.
 */
export function prepareArchive(
  projectRoot: string,
  change: string,
  reviewed: ReviewedItem[],
): PrepareResult {
  const plan = planArchive(change, reviewed);
  if (plan.unresolved.length > 0) throw new ArchiveBlockedError(plan);

  if (plan.diverting.length === 0) return { plan, rewritten: [], removed: [] };

  // The register is written first: if a rewrite fails afterwards, a
  // requirement recorded twice is recoverable, one recorded nowhere is not.
  addToRegister(projectRoot, plan.diverting);

  const deferredByFile = new Map<string, Set<string>>();
  for (const entry of reviewed) {
    if (entry.state !== 'deferred' || !isRequirement(entry.item)) continue;
    const set = deferredByFile.get(entry.item.file) ?? new Set<string>();
    set.add(normalizeRequirementName(entry.item.name));
    deferredByFile.set(entry.item.file, set);
  }

  const rewritten: string[] = [];
  const removed: string[] = [];
  for (const [file, names] of deferredByFile) {
    if (plan.emptied.includes(file)) {
      // An empty delta file would fail OpenSpec's validation, and a capability
      // whose every requirement is unverified has nothing to merge.
      try {
        unlinkSync(file);
        removed.push(file);
      } catch {
        // Already gone.
      }
      continue;
    }
    if (removeRequirements(file, names)) rewritten.push(file);
  }

  return { plan, rewritten, removed };
}

/** Strips the named requirement blocks from a delta file. */
function removeRequirements(file: string, names: ReadonlySet<string>): boolean {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  const lines = normalizeContent(content).split('\n');
  const mask = buildCodeFenceMask(lines);
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const header = mask[i] ? null : line.match(REQUIREMENT_HEADER);
    if (header?.[1] && names.has(normalizeRequirementName(header[1]))) {
      // Skip the whole block.
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j] ?? '';
        if (!mask[j] && (REQUIREMENT_HEADER.test(next) || SECTION_HEADER.test(next))) break;
      }
      i = j - 1;
      continue;
    }
    kept.push(line);
  }

  // Collapse the blank run a removed block leaves behind, so the file reads as
  // if the requirement had never been there.
  const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  writeFileSync(file, `${cleaned}\n`, 'utf8');
  return true;
}
