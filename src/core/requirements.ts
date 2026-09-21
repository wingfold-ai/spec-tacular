/**
 * Flattens a change's spec deltas into one ordered review queue.
 *
 * This is the data the review loop walks: every requirement across every
 * capability in a change, in document order, each one independently
 * reviewable. The pile-of-files problem (docs/problem-analysis.md §3) is
 * solved here, not in the UI — the UI only shows one element of this list at
 * a time.
 */

import { createHash } from 'node:crypto';
import {
  buildCodeFenceMask,
  DELTA_HEADER,
  normalizeContent,
  normalizeRequirementName,
  RENAME_FROM,
  RENAME_TO,
  REQUIREMENT_HEADER,
  REQUIREMENTS_HEADER,
  SCENARIO_HEADER,
  SECTION_HEADER,
} from './markdown.ts';

export type DeltaOperation = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED';

export interface Scenario {
  name: string;
  /** Body lines, verbatim, trailing blanks trimmed. */
  body: string[];
}

/**
 * Anything a human reviews one at a time.
 *
 * A spec requirement and a design decision differ in what they say but not in
 * how they are reviewed: both are a named block of text that gets accepted,
 * rejected or deferred, and both must drop back to pending when edited. That
 * shared behaviour lives on this type so the two can never drift apart — the
 * review loop, the sidecar and drift detection are written once.
 */
export interface ReviewItem {
  /** `<group>#<slug>` — stable across edits that do not rename it. */
  id: string;
  /** The capability for a requirement; `design` for a decision. */
  capability: string;
  name: string;
  text: string;
  /** Absolute path of the file it lives in. */
  file: string;
  /** 1-based line of its header, so `$EDITOR` can jump to it. */
  line: number;
  /** Hash of the normalized block. Drift detection compares against this. */
  hash: string;
}

export interface Requirement extends ReviewItem {
  operation: DeltaOperation;
  scenarios: Scenario[];
}

/**
 * Narrows a review item to a spec requirement.
 *
 * Needed wherever behaviour is requirement-specific — scenarios to render,
 * prose to lint for premature concreteness. A design decision has neither.
 */
export function isRequirement(item: ReviewItem): item is Requirement {
  return Array.isArray((item as Requirement).scenarios);
}

export interface Rename {
  from: string;
  to: string;
  capability: string;
}

export interface ParsedSpec {
  capability: string;
  requirements: Requirement[];
  renames: Rename[];
}

/** `Theme selection!` → `theme-selection`. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // A name of only punctuation would otherwise collapse to the empty string
  // and collide with every other such name.
  return slug || 'unnamed';
}

/**
 * Normalizes a requirement block for hashing.
 *
 * Cosmetic edits — reflowing, trailing spaces, extra blank lines — must NOT
 * reset a human's acceptance, or the tool punishes people for tidying files.
 * Any change to the words must. So whitespace is collapsed and everything else
 * is preserved exactly, including case and punctuation.
 */
export function normalizeForHash(block: string): string {
  return normalizeContent(block)
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => l.length > 0)
    .join('\n');
}

export function hashBlock(block: string): string {
  return `sha256:${createHash('sha256').update(normalizeForHash(block)).digest('hex').slice(0, 32)}`;
}

/** Splits a requirement's body into leading prose and its scenarios. */
function splitBody(
  bodyLines: string[],
  mask: boolean[],
): { text: string; scenarios: Scenario[] } {
  const textLines: string[] = [];
  const scenarios: Scenario[] = [];
  let current: Scenario | null = null;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i] ?? '';
    if (!mask[i] && SCENARIO_HEADER.test(line)) {
      if (current) scenarios.push(current);
      current = {
        // `#### Scenario: Foo` → `Foo`; a bare `#### Foo` keeps `Foo`. Both
        // forms appear in the wild, and neither should be dropped.
        name: normalizeRequirementName(
          line.replace(/^####\s+/, '').replace(/^Scenario:\s*/i, ''),
        ),
        body: [],
      };
      continue;
    }
    if (current) current.body.push(line);
    else textLines.push(line);
  }
  if (current) scenarios.push(current);

  for (const s of scenarios) {
    while (s.body.length > 0 && (s.body[s.body.length - 1] ?? '').trim() === '') s.body.pop();
  }

  return { text: textLines.join('\n').trim(), scenarios };
}

/**
 * Parses one delta spec file.
 *
 * Handles both the delta form (`## ADDED Requirements`) and a main spec
 * (`## Requirements`), because the same review loop is used for both once a
 * change is archived.
 */
export function parseSpecFile(
  content: string,
  capability: string,
  file: string,
): ParsedSpec {
  const lines = normalizeContent(content).split('\n');
  const mask = buildCodeFenceMask(lines);

  const requirements: Requirement[] = [];
  const renames: Rename[] = [];
  // Slug collisions inside one capability would silently merge two
  // requirements into one review entry, so they are disambiguated instead.
  const seen = new Map<string, number>();

  let operation: DeltaOperation | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (mask[i]) continue;

    const delta = line.match(DELTA_HEADER);
    if (delta?.[1]) {
      operation = delta[1].toUpperCase() as DeltaOperation;
      continue;
    }
    if (REQUIREMENTS_HEADER.test(line)) {
      // A main spec's requirements are the accepted baseline. They are
      // surfaced as ADDED so the queue shape stays uniform.
      operation = 'ADDED';
      continue;
    }
    // Any other `## ` header (`## Purpose`, `## Impact`) ends the current
    // section. Without this, prose after a delta section would be swept into
    // the last requirement.
    if (SECTION_HEADER.test(line)) {
      operation = null;
      continue;
    }

    if (operation === 'RENAMED') {
      const from = line.match(RENAME_FROM);
      if (from?.[1]) {
        // A FROM is only a rename once its TO arrives; an unpaired one is
        // malformed and is dropped rather than guessed at.
        const to = findNextTo(lines, mask, i);
        if (to) renames.push({ from: normalizeRequirementName(from[1]), to, capability });
      }
      continue;
    }

    if (operation === null) continue;

    const header = line.match(REQUIREMENT_HEADER);
    if (!header?.[1]) continue;

    const name = normalizeRequirementName(header[1]);
    const bodyLines: string[] = [];
    const bodyMask: boolean[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (!mask[j] && (REQUIREMENT_HEADER.test(next) || SECTION_HEADER.test(next))) break;
      bodyLines.push(next);
      bodyMask.push(mask[j] ?? false);
    }

    const { text, scenarios } = splitBody(bodyLines, bodyMask);

    const base = slugify(name);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const slug = count === 1 ? base : `${base}~${count}`;

    requirements.push({
      id: `${capability}#${slug}`,
      capability,
      name,
      operation,
      text,
      scenarios,
      file,
      line: i + 1,
      hash: hashBlock([line, ...bodyLines].join('\n')),
    });

    i = j - 1;
  }

  return { capability, requirements, renames };
}

/** The next `TO:` before any further `FROM:`. Mirrors OpenSpec's pairing rule. */
function findNextTo(lines: string[], mask: boolean[], from: number): string | null {
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (mask[i]) continue;
    if (SECTION_HEADER.test(line) || RENAME_FROM.test(line)) return null;
    const to = line.match(RENAME_TO);
    if (to?.[1]) return normalizeRequirementName(to[1]);
  }
  return null;
}

/** The capability path for a spec file: its directory relative to `specs/`. */
export function capabilityFromPath(specPath: string): string {
  const normalized = specPath.replace(/\\/g, '/');
  const marker = '/specs/';
  const at = normalized.lastIndexOf(marker);
  const tail = at === -1 ? normalized : normalized.slice(at + marker.length);
  const dir = tail.replace(/\/[^/]+$/, '');
  return dir === tail ? 'unknown' : dir;
}
