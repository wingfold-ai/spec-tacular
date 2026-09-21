/**
 * Marking a flagged value as an example, in place.
 *
 * This writes to a spec file, which the adapter rule otherwise forbids. The
 * exception is deliberate and narrow: that rule exists so spec-tacular never
 * creates, archives or restructures OpenSpec's artifacts behind its back. This
 * is a human editing the prose of one requirement — the same thing `e` does
 * through `$EDITOR`, minus the round trip — and it changes no structure.
 *
 * It is a pure substitution inside one requirement's block. Everything else in
 * the file is left byte-for-byte alone, and if the target cannot be located
 * unambiguously it declines rather than guessing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { markAsExample } from './examples.ts';
import { normalizeContent, REQUIREMENT_HEADER, SECTION_HEADER } from './markdown.ts';
import { buildCodeFenceMask } from './markdown.ts';
import type { Requirement } from './requirements.ts';

export type MarkResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Wraps the first occurrence of `value` within `requirement`'s block.
 *
 * Scoped to the block rather than the file so marking a value in one
 * requirement cannot silently rewrite an identical word in another.
 */
export function markExampleInFile(requirement: Requirement, value: string): MarkResult {
  let original: string;
  try {
    original = readFileSync(requirement.file, 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not read ${requirement.file}: ${(err as Error).message}` };
  }

  const normalized = normalizeContent(original);
  const lines = normalized.split('\n');
  const mask = buildCodeFenceMask(lines);

  // The requirement's recorded line is 1-based and must still hold the header;
  // if the file moved under us, editing by offset would corrupt it.
  const headerIndex = requirement.line - 1;
  const header = lines[headerIndex];
  if (header === undefined || mask[headerIndex] || !REQUIREMENT_HEADER.test(header)) {
    return { ok: false, reason: 'the file changed since it was read — reopen the change' };
  }

  let end = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!mask[i] && (REQUIREMENT_HEADER.test(line) || SECTION_HEADER.test(line))) {
      end = i;
      break;
    }
  }

  const block = lines.slice(headerIndex, end).join('\n');
  const marked = markAsExample(block, value);
  if (marked === null) {
    return { ok: false, reason: `'${value}' is not in this requirement, or is already an example` };
  }

  const updated = [...lines.slice(0, headerIndex), ...marked.split('\n'), ...lines.slice(end)].join(
    '\n',
  );
  try {
    writeFileSync(requirement.file, updated, 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not write ${requirement.file}: ${(err as Error).message}` };
  }
  return { ok: true, value };
}
