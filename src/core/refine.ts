/**
 * Revising one requirement with the agent, in conversation.
 *
 * Rejecting a requirement and waiting for a batch revision is the slow loop;
 * this is the fast one. On the review screen you say what should change
 * ("make the timeout configurable"), the agent answers with the revised
 * requirement, and you accept it, ask for more, or drop it. Only an accepted
 * revision touches the spec file, and then only that requirement's block —
 * every other byte of the file stays as it was.
 *
 * Every request carries the whole conversation in its context, so a fresh
 * session or a one-shot agent can answer it as well as the long-running
 * session that heard it all; the session is only sent what changed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ask } from './advisor.ts';
import { renderPrompt, type ContextSection, type PromptParts } from '../agent/prompt.ts';
import {
  buildCodeFenceMask,
  normalizeContent,
  normalizeRequirementName,
  REQUIREMENT_HEADER,
  SECTION_HEADER,
} from './markdown.ts';
import { hashBlock, parseSpecFile, slugify, type Requirement, type ReviewItem } from './requirements.ts';
import { isRisk, parseRisks, RISK_HEADER, type Risk } from './risks.ts';
import { setState, type ChangeReview } from './review.ts';
import { currentItem, moveTo, refresh, type ReviewSession } from './session.ts';
import { REVISION_RULES } from './revision.ts';

/**
 * What can be revised in conversation: a requirement, or a risk — each a
 * block in its file that is written back in place.
 */
export type Revisable = Requirement | Risk;

/** What the agent is shown besides the requirement itself. */
export interface RefineContext {
  requirement: Revisable;
  /** The spec file the requirement is in, as it is now. */
  spec: string;
  /** The change's proposal, when it has one: why the requirement exists. */
  proposal?: string;
}

/** One round: what was asked, and the requirement the agent answered with. */
export interface RefineTurn {
  instruction: string;
  revised: string;
}

export interface Refinement {
  /** The revised requirement block, header to last scenario line. */
  block: string;
  /** The agent's one-line account of what it changed. */
  summary: string;
  /** Worth knowing before accepting it, never blocking. */
  warnings: string[];
}

export const REFINE_SCHEMA = {
  type: 'object',
  properties: {
    requirement: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['requirement', 'summary'],
} as const;

/** Reads what the agent needs to know besides the requirement. */
export function refineContext(changeRoot: string, requirement: Revisable): RefineContext {
  const spec = readFileSync(requirement.file, 'utf8');
  const proposalPath = join(changeRoot, 'proposal.md');
  const proposal = existsSync(proposalPath) ? readFileSync(proposalPath, 'utf8') : undefined;
  return { requirement, spec, ...(proposal ? { proposal } : {}) };
}

// ---------------------------------------------------------------------------
// The prompt

const PREAMBLE = [
  'You help a developer revise one requirement of an OpenSpec change, in a',
  'conversation: they say what should change, you answer with the revised',
  'requirement, and they may ask for more changes after that. Each request',
  'builds on your latest proposal unless they say otherwise. Change what they',
  'ask for and nothing else — the rest of the requirement was already read and',
  'agreed with.',
].join('\n');

/** Keeps the proposal to what it says, not the template's reminders. */
function proseLines(text: string, max: number): string[] {
  const lines = normalizeContent(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.trimEnd());
  const kept = lines.filter((l, i) => l !== '' || (i > 0 && lines[i - 1] !== ''));
  return kept.length > max ? [...kept.slice(0, max), '…'] : kept;
}

/**
 * Each proposal's lines are tagged with its round. Two rounds share most of
 * their lines, and a session sent only the difference must still be able to
 * tell which proposal a line belongs to.
 */
function conversationLines(turns: RefineTurn[]): string[] {
  return turns.flatMap((turn, i) => [
    `[${i + 1}] the developer asked: ${turn.instruction.replace(/\s*\n\s*/g, ' / ')}`,
    `[${i + 1}] you proposed:`,
    ...turn.revised.split('\n').map((l) => `[${i + 1}] | ${l}`),
  ]);
}

export function buildRefineParts(
  context: RefineContext,
  turns: RefineTurn[],
  instruction: string,
): PromptParts {
  const req = context.requirement;
  const risk = isRisk(req);
  const noun = risk ? 'risk' : 'requirement';
  const current = readBlockFrom(context.spec, req);
  const sections: ContextSection[] = [];
  if (context.proposal) {
    sections.push({ heading: 'Why the change exists (its proposal)', lines: proseLines(context.proposal, 80) });
  }
  sections.push(
    {
      heading: risk ? "The change's risks document it is part of" : `The spec it is part of (capability ${req.capability})`,
      lines: normalizeContent(context.spec).split('\n').map((l) => l.trimEnd()),
    },
    {
      heading: `The ${noun}, as it is in the file now`,
      lines: (current.ok ? current.block : '').split('\n'),
    },
    {
      heading: 'This conversation so far',
      lines: conversationLines(turns),
      empty: '(nothing yet: this is the first request)',
    },
  );

  const from = turns.length > 0 ? `your latest proposal, [${turns.length}]` : `the ${noun} as it is in the file now`;
  const task = [
    `The developer asks you to change the ${noun} "${req.name}":`,
    '',
    instruction.trim(),
    '',
    `Start from ${from}. Return the whole revised ${noun} in \`requirement\`,`,
    'and in `summary` one short sentence saying what you changed.',
  ].join('\n');

  if (risk) return { preamble: PREAMBLE.replace(/requirement/g, 'risk'), context: sections, task, rules: RISK_RULES };

  const rules = [
    'Format — the requirement is written back into the spec file exactly as you',
    'return it:',
    '- It starts with `### Requirement: <name>` and is one requirement: no `## `',
    '  headings, no second `### Requirement:`.',
    '- Its statement uses SHALL or MUST.',
    '- Each scenario is `#### Scenario: <name>` followed by `- **WHEN** …` and',
    '  `- **THEN** …` bullets (and `- **AND** …`).',
    '- No code fence around it and no commentary inside it.',
    ...REVISION_RULES,
    ...(req.operation === 'MODIFIED'
      ? ['- Keep the name exactly: in a MODIFIED section the name says which', '  existing requirement this one replaces.']
      : []),
  ].join('\n');

  return { preamble: PREAMBLE, context: sections, task, rules };
}

const RISK_RULES = [
  'Format — the risk is written back into the risks document exactly as you',
  'return it:',
  '- It starts with `### Risk: <name>` and is one risk: no other heading.',
  '- Then one bullet per field, `- **Field:** text`, in this order: Hazard,',
  '  Affects, Boundary, Causes (optional), Severity (high | medium | low),',
  '  Guard, Check — or, for a risk knowingly left unmitigated, Unmitigated',
  '  (why) instead of Guard and Check — and Known hazard (HAZ-NNNN) when it',
  '  is an instance of a register entry.',
  '- A formal form, when it has one, stays in its ```formal fence after the',
  '  fields; keep it consistent with what you changed.',
  '- No code fence around it and no commentary inside it.',
].join('\n');

/** Strips a code fence the agent put around the whole answer anyway. */
function unfence(text: string): string {
  const fenced = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return fenced ? fenced[1]! : text;
}

/**
 * The agent's answer as a requirement block that can go into the file, or an
 * error saying why it cannot.
 *
 * Checked by parsing it the way the file will be parsed: an answer that
 * reads as two requirements, or as none, would restructure the spec rather
 * than revise one requirement in it.
 */
export function parseRefinement(raw: unknown, context: RefineContext): Refinement {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const text = typeof record['requirement'] === 'string' ? record['requirement'] : '';
  const block = normalizeContent(unfence(text))
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
  if (block === '') throw new Error('The agent answered without a requirement');

  const lines = block.split('\n');
  const mask = buildCodeFenceMask(lines);
  if (isRisk(context.requirement)) return parseRiskRefinement(block, lines, mask, record, context.requirement, context.spec);
  if (!REQUIREMENT_HEADER.test(lines[0]!)) {
    throw new Error('The revision does not start with "### Requirement:"');
  }
  if (lines.some((l, i) => !mask[i] && SECTION_HEADER.test(l))) {
    throw new Error('The revision has a "## " heading in it, which would split the spec file');
  }
  const parsed = parseSpecFile(`## ADDED Requirements\n\n${block}\n`, context.requirement.capability, context.requirement.file);
  if (parsed.requirements.length !== 1) {
    throw new Error(`The revision holds ${parsed.requirements.length} requirements, not one`);
  }

  const revised = parsed.requirements[0]!;
  const original = context.requirement;
  const warnings: string[] = [];
  if (revised.name !== original.name) {
    // Another requirement of that name would take this one's place in review.
    const others = parseSpecFile(context.spec, original.capability, original.file).requirements
      .filter((r) => r.line !== original.line);
    if (others.some((r) => slugify(r.name) === slugify(revised.name))) {
      throw new Error(`The revision renames it to "${revised.name}", which another requirement in this spec already uses`);
    }
    warnings.push(
      original.operation === 'MODIFIED'
        ? `Renames a MODIFIED requirement to "${revised.name}" — OpenSpec finds the requirement it replaces by name`
        : `Renames it to "${revised.name}"`,
    );
  }
  if (revised.scenarios.length === 0) warnings.push('It has no scenario left');
  if (revised.hash === original.hash) warnings.push('Nothing changed');

  const summary = typeof record['summary'] === 'string' ? record['summary'].trim() : '';
  return { block, summary, warnings };
}

function parseRiskRefinement(
  block: string,
  lines: string[],
  mask: boolean[],
  record: Record<string, unknown>,
  original: Risk,
  document: string,
): Refinement {
  if (!RISK_HEADER.test(lines[0]!)) throw new Error('The revision does not start with "### Risk:"');
  if (lines.some((l, i) => i > 0 && !mask[i] && /^#{1,3}\s/.test(l))) {
    throw new Error('The revision has a heading in it, which would split the risks document');
  }
  const parsed = parseRisks(block, original.file);
  if (parsed.length !== 1) throw new Error(`The revision holds ${parsed.length} risks, not one`);
  const revised = parsed[0]!;
  const warnings: string[] = [];
  if (revised.name !== original.name) {
    const others = parseRisks(document, original.file).filter((r) => r.line !== original.line);
    if (others.some((r) => slugify(r.name) === slugify(revised.name))) {
      throw new Error(`The revision renames it to "${revised.name}", which another risk already uses`);
    }
    warnings.push(`Renames it to "${revised.name}" — the design and the tasks refer to it by name`);
  }
  if (!revised.hazard) warnings.push('It has no Hazard left');
  if (!revised.unmitigated && (!revised.guard || !revised.check)) warnings.push('It has no Guard and Check, and is not marked Unmitigated');
  if (revised.hash === original.hash) warnings.push('Nothing changed');
  const summary = typeof record['summary'] === 'string' ? record['summary'].trim() : '';
  return { block, summary, warnings };
}

/** Asks the agent for one round of revision. */
export class RequirementRefiner {
  constructor(private readonly ask: Ask) {}

  async propose(context: RefineContext, turns: RefineTurn[], instruction: string): Promise<Refinement> {
    const parts = buildRefineParts(context, turns, instruction);
    // Reasoning about wording, with nothing to look up.
    const raw = await this.ask(renderPrompt(parts), REFINE_SCHEMA, { mode: 'think', parts });
    return parseRefinement(raw, context);
  }
}

// ---------------------------------------------------------------------------
// The file

interface Located {
  /** The file split on `\n`; a CRLF file's lines keep their `\r`. */
  lines: string[];
  crlf: boolean;
  /** The block is `lines[start, end)`, its trailing blank lines excluded. */
  start: number;
  end: number;
}

/**
 * Finds a requirement's block in the file's own text, checking it is still
 * the text that was reviewed.
 *
 * Located in the raw text, not a normalized copy, because it is written back
 * into the raw text: normalizing would rewrite a CRLF file's every line.
 */
function locate(content: string, requirement: Revisable): Located | { reason: string } {
  // A lone CR is a line break to the parser but not to `split('\n')`, so
  // the line numbers would disagree.
  if (/\r(?!\n)/.test(content)) return { reason: 'the spec file uses bare CR line endings; edit it with E' };
  const lines = content.split('\n');
  const plain = (i: number) => (lines[i] ?? '').replace(/\r$/, '').replace(/^﻿/, '');
  const normalized = lines.map((_, i) => plain(i));
  const mask = buildCodeFenceMask(normalized);

  const risk = isRisk(requirement);
  const start = requirement.line - 1;
  const header = normalized[start];
  const match = header === undefined || mask[start] ? null : (risk ? RISK_HEADER : REQUIREMENT_HEADER).exec(header);
  const name = risk ? match?.[1]?.trim() : match?.[1] && normalizeRequirementName(match[1]);
  if (!name || name !== requirement.name) {
    return { reason: `the ${risk ? 'risks document' : 'spec file'} changed since it was read — reopen the review` };
  }
  // A risk ends at any heading of its level or above, as risks.ts reads it.
  const ends = (line: string) => (risk ? /^#{1,3}\s/.test(line) : REQUIREMENT_HEADER.test(line) || SECTION_HEADER.test(line));
  let end = normalized.length;
  for (let i = start + 1; i < normalized.length; i++) {
    if (!mask[i] && ends(normalized[i]!)) {
      end = i;
      break;
    }
  }
  if (hashBlock(normalized.slice(start, end).join('\n')) !== requirement.hash) {
    return { reason: `the ${risk ? 'risk' : 'requirement'} changed since it was read — reopen the review` };
  }
  while (end > start + 1 && normalized[end - 1]!.trim() === '') end--;
  return { lines, crlf: content.includes('\r\n'), start, end };
}

function readBlockFrom(content: string, requirement: Revisable): { ok: true; block: string } | { ok: false; reason: string } {
  const found = locate(content, requirement);
  if ('reason' in found) return { ok: false, reason: found.reason };
  return {
    ok: true,
    block: found.lines.slice(found.start, found.end).map((l) => l.replace(/\r$/, '')).join('\n'),
  };
}

/** A requirement's Markdown, as it is in its file. */
export function readRequirementBlock(requirement: Revisable): { ok: true; block: string } | { ok: false; reason: string } {
  try {
    return readBlockFrom(readFileSync(requirement.file, 'utf8'), requirement);
  } catch (err) {
    return { ok: false, reason: `could not read ${requirement.file}: ${(err as Error).message}` };
  }
}

/**
 * Replaces one requirement's block in its file with `block`.
 *
 * The blank lines after the block, and everything before and after it, are
 * kept byte for byte — line endings included.
 */
export function writeRequirementBlock(requirement: Revisable, block: string): { ok: true } | { ok: false; reason: string } {
  let content: string;
  try {
    content = readFileSync(requirement.file, 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not read ${requirement.file}: ${(err as Error).message}` };
  }
  const found = locate(content, requirement);
  if ('reason' in found) return { ok: false, reason: found.reason };

  const replacement = normalizeContent(block).split('\n').map((l) => (found.crlf ? `${l}\r` : l));
  // A block that ended the file without a newline keeps ending it that way.
  if (found.end === found.lines.length && found.crlf) {
    replacement[replacement.length - 1] = replacement[replacement.length - 1]!.replace(/\r$/, '');
  }
  const lines = [...found.lines.slice(0, found.start), ...replacement, ...found.lines.slice(found.end)];
  try {
    writeFileSync(requirement.file, lines.join('\n'), 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not write ${requirement.file}: ${(err as Error).message}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Review state

/**
 * Carries review state across a revision of one requirement.
 *
 * Ids are slugs of names, disambiguated by position when two share a name,
 * so renaming one requirement can shift the id of another in the same file.
 * Its state follows it by position — the file's requirements are the same
 * blocks in the same order, only one of them was rewritten — and the revised
 * one goes back to pending: its new text has not been reviewed by anyone.
 */
export function remapAfterRevision(
  review: ChangeReview,
  before: ReviewItem[],
  after: ReviewItem[],
  revised: ReviewItem,
): { review: ChangeReview; revisedId: string } {
  const inFile = (items: ReviewItem[]) => items.filter((i) => i.file === revised.file);
  const was = inFile(before);
  const now = inFile(after);
  const at = was.findIndex((i) => i.id === revised.id);
  const revisedNow = was.length === now.length && at >= 0 ? now[at]! : null;
  if (!revisedNow) return { review, revisedId: revised.id };

  const requirements = { ...review.requirements };
  const moved = was
    .map((item, i) => ({ from: item.id, to: now[i]!.id, entry: review.requirements[item.id] }))
    .filter((m) => m.from !== m.to);
  for (const m of moved) delete requirements[m.from];
  for (const m of moved) if (m.entry) requirements[m.to] = m.entry;

  const remapped = setState({ ...review, requirements }, revisedNow, 'pending');
  return { review: { ...remapped, cursor: revisedNow.id }, revisedId: revisedNow.id };
}

/**
 * Writes an accepted revision and re-reads the queue, with the cursor on the
 * revised requirement — pending again, for its new text to be reviewed.
 */
export function acceptRefinement(
  session: ReviewSession,
  requirement: Revisable,
  block: string,
  reparse: () => ReviewItem[],
): { ok: true; session: ReviewSession } | { ok: false; reason: string } {
  const before = session.items.map((i) => i.item);
  const written = writeRequirementBlock(requirement, block);
  if (!written.ok) return written;
  const after = reparse();
  const { review, revisedId } = remapAfterRevision(session.review, before, after, requirement);
  const rebuilt = refresh({ ...session, review }, after);
  const at = rebuilt.items.findIndex((i) => i.item.id === revisedId);
  const next = at >= 0 ? moveTo(rebuilt, at) : rebuilt;
  return { ok: true, session: currentItem(next) ? next : rebuilt };
}
