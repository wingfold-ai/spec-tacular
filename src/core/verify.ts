/**
 * Verifying a pending requirement into the accepted baseline.
 *
 * This is the only place spec-tacular writes to `openspec/specs/`, which the
 * adapter rule otherwise forbids. There is no OpenSpec command for "add this
 * requirement to a main spec" — archive is the only path in, and the whole
 * point of the register is that these requirements missed it.
 *
 * So the write is made as conservative as possible: the requirement block goes
 * in verbatim under the spec's `## Requirements` section, formatted by the
 * same rules the parser reads, and the caller is expected to run
 * `openspec validate` afterwards to confirm OpenSpec still accepts the file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildCodeFenceMask,
  normalizeContent,
  normalizeRequirementName,
  REQUIREMENT_HEADER,
  REQUIREMENTS_HEADER,
  SECTION_HEADER,
} from './markdown.ts';
import { findEntry, loadRegister, saveRegister, type PendingEntry } from './pending.ts';

export type VerifyResult =
  | { ok: true; entry: PendingEntry; specFile: string; created: boolean }
  | { ok: false; reason: string };

export function specFileFor(projectRoot: string, capability: string): string {
  return join(projectRoot, 'openspec', 'specs', capability, 'spec.md');
}

/**
 * Moves one register entry into its capability's main spec.
 *
 * Removing it from the register only after the spec write succeeds: an entry
 * present in both places is recoverable, one lost from both is not.
 */
export function verifyRequirement(
  projectRoot: string,
  capability: string,
  name: string,
): VerifyResult {
  const register = loadRegister(projectRoot);
  const entry = findEntry(register, capability, name);
  if (!entry) {
    return { ok: false, reason: `nothing pending for '${name}' in ${capability}` };
  }

  const specFile = specFileFor(projectRoot, capability);
  const created = !existsSync(specFile);

  let updated: string;
  try {
    updated = created
      ? newSpec(capability, entry)
      : appendRequirement(readFileSync(specFile, 'utf8'), entry);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  try {
    mkdirSync(dirname(specFile), { recursive: true });
    writeFileSync(specFile, updated, 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not write ${specFile}: ${(err as Error).message}` };
  }

  saveRegister(
    projectRoot,
    register.filter((e) => !(e.capability === entry.capability && e.name === entry.name)),
  );
  return { ok: true, entry, specFile, created };
}

function block(entry: PendingEntry): string[] {
  return ['', `### Requirement: ${entry.name}`, '', entry.body];
}

/**
 * A capability whose spec never existed, because every one of its requirements
 * was deferred. The Purpose is a placeholder a human has to fill in — inventing
 * one would be exactly the guessing this tool exists to stop.
 */
function newSpec(capability: string, entry: PendingEntry): string {
  return [
    `# ${capability}`,
    '',
    '## Purpose',
    '',
    `TBD — describe what ${capability} is for. This spec was created by verifying`,
    'a requirement that was deferred when its change closed.',
    '',
    '## Requirements',
    ...block(entry),
    '',
  ].join('\n');
}

function appendRequirement(content: string, entry: PendingEntry): string {
  const lines = normalizeContent(content).split('\n');
  const mask = buildCodeFenceMask(lines);

  const target = normalizeRequirementName(entry.name);
  for (let i = 0; i < lines.length; i++) {
    const header = mask[i] ? null : (lines[i] ?? '').match(REQUIREMENT_HEADER);
    if (header?.[1] && normalizeRequirementName(header[1]) === target) {
      throw new Error(`'${entry.name}' is already in the spec — remove it from the register by hand`);
    }
  }

  let section = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!mask[i] && REQUIREMENTS_HEADER.test(lines[i] ?? '')) {
      section = i;
      break;
    }
  }
  if (section === -1) {
    // No Requirements section: append one rather than guessing where it went.
    return [...lines, '', '## Requirements', ...block(entry), ''].join('\n').replace(/\n{3,}/g, '\n\n');
  }

  // Insert at the end of the section, not the end of the file: a spec may have
  // sections after Requirements, and a requirement under them would be lost.
  let end = lines.length;
  for (let i = section + 1; i < lines.length; i++) {
    if (!mask[i] && SECTION_HEADER.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  while (end > section + 1 && (lines[end - 1] ?? '').trim() === '') end--;

  return [...lines.slice(0, end), ...block(entry), '', ...lines.slice(end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
