/**
 * The pending-validation register.
 *
 * OpenSpec's archive counts unchecked boxes in `tasks.md` and blocks, offering
 * only `--yes` (archive anyway, losing the record of what was never verified)
 * or `--skip-specs` (archive without merging specs at all). Both are
 * all-or-nothing: there is no way to say *these requirements are verified,
 * that one waits for a deployed environment* (docs/problem-analysis.md §8).
 *
 * The register is that missing middle. A deferred requirement leaves the
 * change but does not enter the accepted baseline — it waits here, in full,
 * with what would verify it, until someone can.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildCodeFenceMask,
  normalizeContent,
  REQUIREMENT_HEADER,
  SECTION_HEADER,
  normalizeRequirementName,
} from './markdown.ts';

export interface PendingEntry {
  capability: string;
  name: string;
  /** The requirement block verbatim, metadata lines excluded. */
  body: string;
  /** The change it was deferred from. */
  change: string;
  /** ISO date it was deferred. */
  deferred: string;
  /** What would verify it — the reason given at review time. */
  needs: string;
}

export function registerPath(projectRoot: string): string {
  return join(projectRoot, 'spec-tacular', 'pending-validation.md');
}

const META = /^\*\*(Change|Deferred|Needs):\*\*\s*(.*)$/;

const HEADER = [
  '# Pending validation',
  '',
  'Requirements that were accepted in principle but could not be verified when',
  'their change closed — typically because they need a deployed environment.',
  '',
  'They are **not** part of the accepted baseline in `openspec/specs/`. Verify',
  'one and it moves there:',
  '',
  '```',
  'spec-tacular verify "<capability>" --requirement "<name>"',
  '```',
  '',
];

/** Reads the register. A missing file is an empty register, not an error. */
export function loadRegister(projectRoot: string): PendingEntry[] {
  const path = registerPath(projectRoot);
  if (!existsSync(path)) return [];

  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const lines = normalizeContent(content).split('\n');
  const mask = buildCodeFenceMask(lines);
  const entries: PendingEntry[] = [];
  let capability = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (mask[i]) continue;

    if (SECTION_HEADER.test(line)) {
      capability = line.replace(/^##\s+/, '').trim();
      continue;
    }

    const header = line.match(REQUIREMENT_HEADER);
    if (!header?.[1]) continue;

    const name = normalizeRequirementName(header[1]);
    const bodyLines: string[] = [];
    const meta: Record<string, string> = {};
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (!mask[j] && (REQUIREMENT_HEADER.test(next) || SECTION_HEADER.test(next))) break;
      const m = next.match(META);
      // Metadata is kept out of the body so verifying writes the requirement
      // into the spec exactly as it was reviewed, with no register bookkeeping.
      if (m?.[1]) meta[m[1].toLowerCase()] = (m[2] ?? '').trim();
      else bodyLines.push(next);
    }

    entries.push({
      capability,
      name,
      body: bodyLines.join('\n').trim(),
      change: meta['change'] ?? '',
      deferred: meta['deferred'] ?? '',
      needs: meta['needs'] ?? '',
    });
    i = j - 1;
  }

  return entries;
}

/** Rewrites the register, grouped by capability. */
export function saveRegister(projectRoot: string, entries: PendingEntry[]): void {
  const path = registerPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });

  if (entries.length === 0) {
    writeFileSync(path, [...HEADER, '_Nothing is waiting on validation._', ''].join('\n'), 'utf8');
    return;
  }

  const byCapability = new Map<string, PendingEntry[]>();
  for (const entry of entries) {
    byCapability.set(entry.capability, [...(byCapability.get(entry.capability) ?? []), entry]);
  }

  const out = [...HEADER];
  for (const [capability, group] of [...byCapability].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`## ${capability}`, '');
    for (const entry of group) {
      out.push(`### Requirement: ${entry.name}`, '');
      if (entry.body) out.push(entry.body, '');
      out.push(`**Change:** ${entry.change}`);
      out.push(`**Deferred:** ${entry.deferred}`);
      out.push(`**Needs:** ${entry.needs}`, '');
    }
  }
  writeFileSync(path, out.join('\n'), 'utf8');
}

/** Adds entries, replacing any that match an existing capability and name. */
export function addToRegister(projectRoot: string, incoming: PendingEntry[]): PendingEntry[] {
  const existing = loadRegister(projectRoot).filter(
    (e) => !incoming.some((i) => i.capability === e.capability && i.name === e.name),
  );
  const merged = [...existing, ...incoming];
  saveRegister(projectRoot, merged);
  return merged;
}

export function findEntry(
  entries: PendingEntry[],
  capability: string,
  name: string,
): PendingEntry | null {
  const fold = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    entries.find((e) => e.capability === capability && fold(e.name) === fold(name)) ?? null
  );
}
