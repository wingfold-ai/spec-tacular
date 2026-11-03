/**
 * The boundary of a change: what it expects to touch.
 *
 * Nothing stated what a change was allowed to change, so an agent editing
 * files far outside it went unnoticed until someone read the whole diff. The
 * proposal now names the areas of code the change expects to touch, and once
 * implementing has started, files changed outside them are listed on the
 * change for a human to accept or question.
 *
 * Advisory by construction, like the concreteness linter: a change can have a
 * good reason to reach further than it planned, and only a person can tell.
 */

import { execFileSync } from 'node:child_process';
import { buildCodeFenceMask, normalizeContent, SECTION_HEADER } from './markdown.ts';

const BOUNDARY_SECTION = /^##\s+Boundary\s*$/i;

/**
 * The path patterns a proposal's `## Boundary` section names in backticks.
 * Null when it has no such section: a proposal written before boundaries
 * existed declares nothing, which is not the same as declaring nothing may
 * change.
 */
export function parseBoundary(proposal: string): string[] | null {
  const lines = normalizeContent(proposal).split('\n');
  const mask = buildCodeFenceMask(lines);
  const start = lines.findIndex((l, i) => !mask[i] && BOUNDARY_SECTION.test(l));
  if (start === -1) return null;

  const patterns: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (!mask[i] && SECTION_HEADER.test(lines[i] ?? '')) break;
    for (const m of (lines[i] ?? '').matchAll(/`([^`\s]+)`/g)) patterns.push(m[1]!);
  }
  return patterns;
}

/**
 * A path pattern as a regular expression: `**` any number of directories,
 * `*` anything within one, `?` one character. A pattern ending in `/`, or
 * naming a directory without wildcards, covers everything under it.
 */
function toRegExp(pattern: string): RegExp {
  const clean = pattern.replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (c === '*' && clean[i + 1] === '*') {
      out += '.*';
      i++;
      if (clean[i + 1] === '/') i++;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // Without wildcards, a pattern is a file or a directory: both match.
  const tail = clean.endsWith('/') ? '.*' : /[*?]/.test(clean) ? '' : '(/.*)?';
  return new RegExp(`^${out}${tail}$`);
}

export function withinBoundary(path: string, patterns: string[]): boolean {
  return patterns.some((p) => toRegExp(p).test(path));
}

/**
 * Where spec-tacular and OpenSpec keep their own records. Writing those is
 * part of every change, so it is never outside a boundary.
 */
const BOOKKEEPING = /^(openspec|spec-tacular|\.spec-tacular)\//;

/**
 * Changed files the boundary does not cover. `generated` are files
 * spec-tacular itself writes into the project — the matrix tests and their
 * runner — which no change has to claim.
 */
export function outsideBoundary(changed: string[], patterns: string[], generated: string[] = []): string[] {
  const isGenerated = (f: string) => generated.some((g) => f === g || f.startsWith(`${g.replace(/\/$/, '')}/`));
  return changed.filter((f) => !BOOKKEEPING.test(f) && !isGenerated(f) && !withinBoundary(f, patterns)).sort();
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** The branch work is merged into: origin's default, else `main` or `master`. */
function defaultBranch(cwd: string): string | null {
  const head = git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])?.trim();
  if (head) return head.replace(/^refs\/remotes\//, '');
  for (const name of ['main', 'master']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', name]) !== null) return name;
  }
  return null;
}

/**
 * Files changed on this branch: committed since it left the default branch,
 * plus everything uncommitted and untracked. Null outside a git repository —
 * then there is nothing to compare, which is not the same as nothing changed.
 */
export function changedFiles(cwd: string): string[] | null {
  if (git(cwd, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return null;
  const files = new Set<string>();
  const add = (out: string | null) => {
    for (const line of (out ?? '').split('\n')) if (line.trim()) files.add(line.trim());
  };

  const base = defaultBranch(cwd);
  const forkPoint = base ? git(cwd, ['merge-base', 'HEAD', base])?.trim() : null;
  // Relative to the project, which need not be the repository's root.
  add(git(cwd, ['diff', '--name-only', '--relative', forkPoint || 'HEAD']));
  add(git(cwd, ['ls-files', '--others', '--exclude-standard']));
  return [...files];
}

/**
 * What this branch changed in the code, as one diff: committed since it left
 * the default branch, uncommitted, and new files — the tool's own records
 * left out. This is what a person reads to accept an implementation, so it
 * is everything the agent wrote, not a summary of it. Null outside git.
 */
export function implementationDiff(cwd: string): string | null {
  if (git(cwd, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return null;
  const base = defaultBranch(cwd);
  const forkPoint = (base ? git(cwd, ['merge-base', 'HEAD', base])?.trim() : null) || 'HEAD';
  const exclude = ['openspec', 'spec-tacular', '.spec-tacular'].map((d) => `:(exclude)${d}`);
  const parts = [git(cwd, ['diff', '--relative', forkPoint, '--', '.', ...exclude]) ?? ''];

  const untracked = (git(cwd, ['ls-files', '--others', '--exclude-standard']) ?? '')
    .split('\n')
    .filter((f) => f.trim() && !BOOKKEEPING.test(f))
    .sort();
  for (const file of untracked) {
    // `--no-index` exits 1 when the files differ, which they always do here.
    try {
      execFileSync('git', ['diff', '--no-index', '--', '/dev/null', file], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      parts.push(String((err as { stdout?: string }).stdout ?? ''));
    }
  }
  return parts.join('').trimEnd();
}
