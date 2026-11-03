/**
 * The generated-by marker: one fixed string on the first line of every file
 * spec-tacular writes itself, so that its use shows in a project's history and
 * one code search finds it: `"generated-by: spec-tacular"`.
 *
 * In Markdown it is an HTML comment, which GitHub does not show (front matter
 * would render as a table on top of every ADR) and OpenSpec accepts. In YAML
 * it is a comment.
 *
 * The version is the one that created the file, and stays: an upgrade must
 * not rewrite every file in a repository. And the marker is never content —
 * a signed-off document does not drift for having one.
 */

import { readFileSync } from 'node:fs';
import { version } from '../../package.json';

export const MARKER = 'generated-by: spec-tacular';

export type MarkerKind = 'markdown' | 'yaml';

const LINE = /^(?:<!--\s*generated-by: spec-tacular[^\n]*?-->|#\s*generated-by: spec-tacular[^\n]*)[ \t]*(?:\r?\n|$)/;

export function markerLine(kind: MarkerKind, at = version): string {
  return kind === 'markdown' ? `<!-- ${MARKER} ${at} -->` : `# ${MARKER} ${at}`;
}

/** The marker line `content` starts with, if any. */
export function markerOf(content: string): string | null {
  return LINE.exec(content)?.[0].replace(/\r?\n$/, '') ?? null;
}

/** `content` without the marker line it starts with. */
export function stripMarker(content: string): string {
  return content.replace(LINE, '');
}

/**
 * `content` with the marker on its first line. A marker it already has is
 * kept; one `previous` (the file as it was) had is carried over, so a file
 * regenerated whole keeps the version that created it.
 */
export function withMarker(content: string, kind: MarkerKind, previous?: string | null): string {
  if (markerOf(content)) return content;
  const kept = previous ? markerOf(previous) : null;
  return `${kept ?? markerLine(kind)}\n${content}`;
}

/** The file's current text, or null — for carrying a marker over on rewrite. */
export function readPrevious(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
