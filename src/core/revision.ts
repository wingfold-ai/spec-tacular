/**
 * Turns rejections into a revision instruction for the agent.
 *
 * Rejecting a requirement has to *do* something, or the review loop is just
 * bookkeeping. The bundle collects every rejection with its reason so the
 * agent rewrites exactly those requirements and leaves the accepted ones
 * alone — which is the whole point of reviewing them individually
 * (docs/problem-analysis.md §3).
 */

import type { ReviewedRequirement } from './review.ts';

export interface RevisionBundle {
  change: string;
  rejected: ReviewedRequirement[];
  /** Markdown instruction to hand to the agent. */
  instruction: string;
}

export function buildRevisionBundle(
  change: string,
  items: ReviewedRequirement[],
): RevisionBundle {
  const rejected = items.filter((i) => i.state === 'rejected');
  return { change, rejected, instruction: renderInstruction(change, rejected) };
}

function renderInstruction(change: string, rejected: ReviewedRequirement[]): string {
  if (rejected.length === 0) {
    return `No requirements were rejected in ${change}. Nothing to revise.`;
  }

  const lines: string[] = [
    `# Revision request: ${change}`,
    '',
    `${rejected.length} requirement${rejected.length === 1 ? ' was' : 's were'} rejected in review.`,
    'Revise ONLY these. Every other requirement in this change has been',
    'accepted by a human — leave them byte-for-byte unchanged.',
    '',
  ];

  // Grouped by capability so the agent opens each spec file once, and so a
  // reviewer reading this back can see whether one file attracted every
  // rejection.
  const byCapability = new Map<string, ReviewedRequirement[]>();
  for (const item of rejected) {
    const key = item.requirement.capability;
    byCapability.set(key, [...(byCapability.get(key) ?? []), item]);
  }

  for (const [capability, items] of [...byCapability].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${capability}`, '');
    lines.push(`File: \`${items[0]!.requirement.file}\``, '');
    for (const item of items) {
      lines.push(`### Requirement: ${item.requirement.name}`, '');
      lines.push(
        item.review.note?.trim()
          ? `**Reason for rejection:** ${item.review.note.trim()}`
          : '**Reason for rejection:** (none given)',
      );
      lines.push('');
    }
  }

  lines.push(
    '## Rules',
    '',
    '- Keep each requirement a behaviour contract: what is observable, not how',
    '  it is built.',
    '- Mark any concrete value that is illustrative rather than decided as',
    '  `{{example: ...}}`. Unmarked concrete values read as binding contracts.',
    '- Every requirement keeps at least one `#### Scenario:` with WHEN/THEN.',
    '- Do not rename a requirement unless the reason asks for it. A rename',
    '  discards its review history.',
    '',
  );

  return lines.join('\n');
}
