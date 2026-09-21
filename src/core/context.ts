/**
 * The context bundle handed to an agent with every call.
 *
 * Two jobs. It carries the project's ground rules, so generated specs and
 * designs are constrained by decisions already made rather than re-deciding
 * them per change (docs/problem-analysis.md §6, §9). And it states which
 * requirements a human has actually accepted, so an agent writing a design
 * knows what is settled and what is not.
 *
 * Foundation documents and ADRs are read if present and skipped if not: they
 * arrive in M7, and this deliberately works the moment those files exist
 * rather than needing to be revisited.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acceptedAdrs } from './decisions.ts';
import type { ReviewedItem } from './review.ts';

export interface ContextBundle {
  /** Ground rules: stack, architecture, conventions. */
  foundation: { name: string; content: string }[];
  /** Accepted architectural decision records. */
  decisions: { name: string; content: string }[];
  accepted: ReviewedItem[];
  deferred: ReviewedItem[];
  /** What could not be included, so the prompt can say so rather than imply completeness. */
  missing: string[];
}

function readMarkdownDir(dir: string): { name: string; content: string }[] {
  if (!existsSync(dir)) return [];
  const out: { name: string; content: string }[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (!entry.endsWith('.md') || statSync(path).isDirectory()) continue;
    try {
      out.push({ name: entry, content: readFileSync(path, 'utf8') });
    } catch {
      // Unreadable file: better to proceed with less context than to fail the job.
    }
  }
  return out;
}

export function buildContext(
  projectRoot: string,
  reviewed: ReviewedItem[],
): ContextBundle {
  const foundation = readMarkdownDir(join(projectRoot, 'spec-tacular', 'foundation'));
  // Only accepted ADRs are binding. A superseded one is history, and feeding
  // it to an agent as a rule would resurrect a decision the project reversed.
  const decisions = acceptedAdrs(projectRoot).map((adr) => ({
    name: `ADR-${String(adr.number).padStart(4, '0')}: ${adr.title}`,
    content: adr.content,
  }));

  const missing: string[] = [];
  if (foundation.length === 0) missing.push('no foundation documents yet');
  if (decisions.length === 0) missing.push('no architectural decision records yet');

  return {
    foundation,
    decisions,
    accepted: reviewed.filter((r) => r.state === 'accepted'),
    deferred: reviewed.filter((r) => r.state === 'deferred'),
    missing,
  };
}

/**
 * Renders the bundle as the prompt preamble.
 *
 * Accepted requirements are listed by name, not in full: the agent can read
 * the spec files, and pasting them wholesale would crowd out the instructions
 * that follow. What matters is which ones are settled.
 */
export function renderContext(bundle: ContextBundle): string {
  const out: string[] = [];

  if (bundle.foundation.length > 0) {
    out.push('# Project ground rules', '');
    out.push('These are settled. Conform to them, or say explicitly why you cannot.', '');
    for (const doc of bundle.foundation) {
      out.push(`## ${doc.name}`, '', doc.content.trim(), '');
    }
  }

  if (bundle.decisions.length > 0) {
    out.push('# Accepted architectural decisions', '');
    out.push(
      'Follow these. To depart from one, propose superseding it by number and',
      'say why — never diverge silently.',
      '',
    );
    for (const doc of bundle.decisions) {
      out.push(`## ${doc.name}`, '', doc.content.trim(), '');
    }
  }

  if (bundle.accepted.length > 0) {
    out.push('# Requirements a human has accepted', '');
    out.push(
      'These were reviewed and agreed one by one. Treat them as fixed input.',
      'If one turns out to be wrong or ambiguous, stop and say so — do not',
      'edit it and do not design around it.',
      '',
    );
    for (const item of bundle.accepted) {
      out.push(`- ${item.item.capability}: ${item.item.name}`);
    }
    out.push('');
  }

  if (bundle.deferred.length > 0) {
    out.push('# Requirements deferred for later verification', '');
    out.push('Accepted in principle, but not verifiable yet. Do not treat them as done.', '');
    for (const item of bundle.deferred) {
      const why = item.review.deferReason ? ` (${item.review.deferReason})` : '';
      out.push(`- ${item.item.capability}: ${item.item.name}${why}`);
    }
    out.push('');
  }

  if (bundle.missing.length > 0) {
    // Said out loud so the agent does not read an absent section as "there are
    // no constraints" — it means nobody has written them down yet.
    out.push(`(Context not available: ${bundle.missing.join('; ')}.)`, '');
  }

  return out.join('\n');
}

/** The full prompt: context bundle, then OpenSpec's own instructions. */
export function buildPrompt(bundle: ContextBundle, instructions: string): string {
  const context = renderContext(bundle);
  return context ? `${context}\n---\n\n${instructions}` : instructions;
}
