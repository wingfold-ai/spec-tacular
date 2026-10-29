/**
 * Whether an artifact may be generated yet.
 *
 * This is where the sequencing argument gets teeth. OpenSpec's `requires` is
 * satisfied by a file existing, so `design` unblocks the moment `specs/` is
 * written — not when anyone has agreed the specs are right
 * (docs/problem-analysis.md §1, §2). The gate adds the missing condition:
 * a prerequisite must be *accepted*, not merely present.
 *
 * Enforced in two places on purpose. The schema (`design.requires: [specs]`)
 * fixes the order for anyone running plain `openspec`; this fixes the
 * acceptance condition, which a schema cannot express.
 */

import { foundationExists, isDeferred, isUnanswered, loadFoundation } from './foundation.ts';
import { buildsOnCode, type ChangePipeline, type Stage } from './pipeline.ts';

export type GateDecision =
  | { allowed: true; warnings: string[] }
  | { allowed: false; reason: string; blockers: string[]; warnings: string[] };

/**
 * Acceptance is only required where it can be measured.
 *
 * The specs are accepted requirement by requirement; a prose artifact
 * (proposal, design, tasks) as a whole, once read (core/signoff.ts). One
 * with neither — no review data loaded — is gated on existence alone, rather
 * than blocking forever or treating "unreviewable" as "reviewed".
 */
function describeBlocker(stage: Stage): string | null {
  if (stage.state === 'ready' || stage.state === 'blocked') {
    return `${stage.id} has not been written yet`;
  }
  if (stage.signoff && !stage.signoff.accepted) {
    return stage.signoff.drifted
      ? `${stage.id} changed since it was accepted`
      : `${stage.id} has not been accepted yet`;
  }
  const review = stage.review;
  if (!review) return null; // written, and nothing reviewable to check
  if (review.complete) return null;

  const noun = stage.id === 'risks' ? 'risks' : 'requirements';
  if (review.total === 0) {
    return `${stage.id} has no ${noun} that could be reviewed`;
  }
  const parts: string[] = [];
  if (review.pending > 0) parts.push(`${review.pending} pending`);
  if (review.rejected > 0) parts.push(`${review.rejected} rejected`);
  const detail = parts.length > 0 ? parts.join(' and ') : 'unreviewed';
  return `${stage.id}: ${detail} of ${review.total} ${noun}`;
}

/** A prerequisite that drifted after this artifact was written against it. */
function describeStaleness(stage: Stage): string | null {
  if (stage.signoff?.drifted) return `${stage.id} changed after it was accepted`;
  const drifted = stage.review?.drifted ?? 0;
  return drifted > 0
    ? `${stage.id} changed after review (${drifted} requirement${drifted === 1 ? '' : 's'})`
    : null;
}

export function gateFor(pipeline: ChangePipeline, artifactId: string): GateDecision {
  const all = [...pipeline.stages, pipeline.apply];
  const target = all.find((s) => s.id === artifactId);
  if (!target) {
    return {
      allowed: false,
      reason: `${pipeline.name} has no artifact called '${artifactId}'`,
      blockers: [`known artifacts: ${all.map((s) => s.id).join(', ')}`],
      warnings: [],
    };
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const id of target.requires) {
    const prerequisite = pipeline.stages.find((s) => s.id === id);
    if (!prerequisite) {
      // A schema naming a prerequisite that is not an artifact is a broken
      // schema; refusing is safer than silently ignoring the dependency.
      blockers.push(`${id} is required but is not an artifact in this schema`);
      continue;
    }
    const blocker = describeBlocker(prerequisite);
    if (blocker) blockers.push(blocker);
    const stale = describeStaleness(prerequisite);
    if (stale) warnings.push(stale);
  }

  // Risks the design left unanswered, or the tasks left unguarded, are named
  // where they matter next. Warnings, not blockers: the name is a cheap link
  // to check, and a design can answer a risk in words the check misses.
  const risks = pipeline.risks;
  if (risks && artifactId === 'tasks' && risks.unanswered.length > 0) {
    warnings.push(`the design does not answer ${listOf(risks.unanswered, 'risk')}`);
  }
  if (risks && artifactId === 'apply' && risks.unguarded.length > 0) {
    warnings.push(`no guard task for ${listOf(risks.unguarded, 'risk')}`);
  }

  // The consequence class's rules, where they bear on this artifact. A
  // waived rule is named where it would have applied, with the reason.
  const consequence = pipeline.consequence;
  if (consequence && artifactId === 'design' && risks && risks.unmitigatedHigh.length > 0) {
    const waived = consequence.waived.find((t) => t.rule === 'guard-high-risks');
    if (consequence.rules.includes('guard-high-risks')) {
      blockers.push(
        `a ${consequence.class} change cannot leave a high-severity risk unmitigated: ` +
          risks.unmitigatedHigh.map((n) => `"${n}"`).join(', '),
      );
    } else if (waived) {
      warnings.push(`high-severity risks left unmitigated, allowed for ${waived.class} because: ${waived.reason}`);
    }
  }

  // A formula that cannot be read, names what the glossary does not define,
  // or contradicts another, is not something to design against — the same
  // reason contradicting requirements stop the design agent.
  const formal = pipeline.formal;
  if (formal && artifactId === 'design') {
    for (const e of formal.errors) blockers.push(`the formal form of "${e.item}": ${e.problems.join('; ')}`);
    for (const c of formal.conflicts) blockers.push(c);
  }

  // A slice builds on the ones before it: what it does may be specified
  // ahead, but how it is built waits until their code exists.
  if (buildsOnCode(pipeline, artifactId)) {
    for (const change of pipeline.waitingOn) blockers.push(`${change} is not applied yet`);
  }

  if (blockers.length > 0) {
    return {
      allowed: false,
      reason: `${artifactId} is not ready to be written`,
      blockers,
      warnings,
    };
  }
  return { allowed: true, warnings };
}

/** `risk "A"` or `2 risks: "A", "B"`. */
function listOf(names: string[], noun: string): string {
  const quoted = names.map((n) => `"${n}"`).join(', ');
  return names.length === 1 ? `${noun} ${quoted}` : `${names.length} ${noun}s: ${quoted}`;
}

/**
 * What is open about a change's risks and boundary, worded for the overview.
 *
 * Each line names the risks or files it is about: "2 risks unguarded" sends
 * someone looking, "no guard task for risk X" tells them where.
 */
export function riskWarnings(pipeline: ChangePipeline): string[] {
  const risks = pipeline.risks;
  if (!risks) return [];
  const out: string[] = [];
  if (risks.unanswered.length > 0) out.push(`the design does not answer ${listOf(risks.unanswered, 'risk')}`);
  if (risks.unguarded.length > 0) out.push(`no guard task for ${listOf(risks.unguarded, 'risk')}`);
  if (risks.unproven.length > 0) {
    out.push(`guard ticked off without being shown red: ${risks.unproven.map((n) => `"${n}"`).join(', ')}`);
  }
  const outside = risks.outsideBoundary;
  if (outside.length > 0) {
    const shown = outside.slice(0, 3).join(', ');
    const more = outside.length > 3 ? ` and ${outside.length - 3} more` : '';
    out.push(`${outside.length} file${outside.length === 1 ? '' : 's'} changed outside the boundary: ${shown}${more}`);
  }
  return out;
}

/**
 * What the change's consequence class says about it, worded for the overview:
 * its class, when it reached into a higher one than it declared, and what is
 * still owed — or waived — for it.
 */
export function classWarnings(pipeline: ChangePipeline): string[] {
  const c = pipeline.consequence;
  if (!c?.class) return [];
  const out: string[] = [];
  if (c.raisedBy.length > 0) {
    const shown = c.raisedBy.slice(0, 3).join(', ');
    const more = c.raisedBy.length > 3 ? ` and ${c.raisedBy.length - 3} more` : '';
    out.push(`declared ${c.declared ?? 'unclassified'}, but changed ${c.class} code: ${shown}${more}`);
  }
  const diff = pipeline.apply.signoff;
  if (c.rules.includes('diff-review') && pipeline.apply.tasks?.applied && diff && !diff.accepted) {
    out.push(
      diff.drifted
        ? `the code changed since you accepted it — read the implementation diff again (${c.class})`
        : `a ${c.class} change: read and accept the implementation diff before it counts as implemented`,
    );
  }
  for (const t of c.waived) out.push(`waived for ${t.class}: ${t.rule} — ${t.reason}`);
  return out;
}

/**
 * What the change still owes in evidence, once implementing has started.
 * Before then every item is missing by definition, and saying so would be
 * noise.
 */
export function evidenceWarnings(pipeline: ChangePipeline): string[] {
  const e = pipeline.evidence;
  if (!e || e.complete || e.total === 0 || (pipeline.apply.tasks?.done ?? 0) === 0) return [];
  const parts: string[] = [];
  if (e.failing) parts.push(`${e.failing} failing`);
  if (e.stale) parts.push(`${e.stale} stale`);
  if (e.unconnected) parts.push(`${e.unconnected} through a harness not shown to reach the code`);
  if (e.missing) parts.push(`${e.missing} without evidence`);
  return [`evidence ${e.passing + e.excepted}/${e.total}: ${parts.join(', ')} — see \`spec-tacular evidence ${pipeline.name}\``];
}

/** For a defect change: what does not fit whose bug the report says it is. */
export function defectWarnings(pipeline: ChangePipeline): string[] {
  return pipeline.defect?.warnings ?? [];
}

/** What is wrong with the change's formal forms; it holds up the design. */
export function formalWarnings(pipeline: ChangePipeline): string[] {
  const f = pipeline.formal;
  if (!f) return [];
  const stale = f.staleMatrices ?? [];
  return [
    ...f.errors.map((e) => `formal form of "${e.item}": ${e.problems.join('; ')}`),
    ...f.conflicts,
    ...(stale.length > 0
      ? [`test matrix missing or out of date for ${stale.map((n) => `"${n}"`).join(', ')} — run \`spec-tacular matrix ${pipeline.name} --write\``]
      : []),
    // Said once implementing has started; before, every harness is missing.
    ...((pipeline.apply.tasks?.done ?? 0) > 0
      ? (f.unconnected ?? []).map((u) => `harness for ${u.component} not connected: ${u.because[0]}${u.because.length > 1 ? ` (+${u.because.length - 1} more)` : ''}`)
      : []),
  ];
}

/** A defect change's kind, for its label: `defect · requirement bug`. */
export function defectLabel(pipeline: ChangePipeline): string | null {
  const d = pipeline.defect;
  if (!d) return null;
  return d.report.fault ? `defect · ${d.report.fault === 'gap' ? 'gap' : `${d.report.fault} bug`}` : 'defect';
}

/**
 * Artifacts written against a prerequisite that has since changed.
 *
 * The exact failure the sequencing fix is meant to prevent: a design written
 * against specs that were edited afterwards is silently wrong, and nothing in
 * OpenSpec notices because both files still exist.
 */
export interface StaleArtifact {
  artifact: string;
  because: string[];
}

export function staleArtifacts(pipeline: ChangePipeline): StaleArtifact[] {
  const out: StaleArtifact[] = [];
  for (const stage of pipeline.stages) {
    if (stage.state !== 'written' && stage.state !== 'accepted') continue;
    const because: string[] = [];
    for (const id of stage.requires) {
      const prerequisite = pipeline.stages.find((s) => s.id === id);
      const stale = prerequisite ? describeStaleness(prerequisite) : null;
      if (stale) because.push(stale);
    }
    if (because.length > 0) out.push({ artifact: stage.id, because });
  }
  return out;
}


/**
 * Whether the project's ground rules have been settled.
 *
 * The first change's design otherwise invents the architecture implicitly, and
 * every later change inherits an accident (docs/problem-analysis.md §9). So
 * the first artifact of a change is gated on the Foundation being answered.
 *
 * A project with no Foundation at all is not blocked: spec-tacular has to stay
 * usable on a repository that adopted OpenSpec before it existed. Only a
 * scaffolded-but-unanswered Foundation blocks, because there the questions
 * have been asked and left hanging. A question left for later on purpose
 * does not block either — deciding it is not needed yet is a decision — but
 * it is named in the warnings, so nobody forgets it is open.
 */
export function foundationGate(projectRoot: string): GateDecision {
  if (!foundationExists(projectRoot)) {
    return {
      allowed: true,
      warnings: ['no Foundation yet — run `spec-tacular init` to set the ground rules'],
    };
  }

  const items = loadFoundation(projectRoot);
  const unanswered = items.filter(isUnanswered);
  const warnings = items
    .filter(isDeferred)
    .map((item) => `left for later: ${item.capability}: ${item.name}`);
  if (unanswered.length === 0) return { allowed: true, warnings };

  return {
    allowed: false,
    reason: 'the project\'s ground rules are not settled yet',
    blockers: unanswered.map((item) => `${item.capability}: ${item.name}`),
    warnings,
  };
}
