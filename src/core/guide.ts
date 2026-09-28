/**
 * The guide: where a project is in getting started, and what to do next.
 *
 * The TUI used to assume a project that was already set up, with changes
 * already written — anything else was a blank screen or an exit. This names
 * every state a first run passes through, so each one can say what comes next
 * instead of leaving you to know the right command.
 *
 * Derivation only. Nothing here acts; the TUI offers the action it names.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOpenSpecProject } from '../adapter/openspec.ts';
import { foundationExists, isDeferred, isUnanswered, loadFoundation } from './foundation.ts';
import { gateFor } from './gate.ts';
import type { ChangePipeline, Stage } from './pipeline.ts';
import { loadRoadmap } from './roadmap.ts';
import { isGreenfield, loadSession } from './vision.ts';

export type ProjectStage =
  /** No `openspec/` directory — nothing to work on yet. */
  | { kind: 'no-openspec' }
  /** OpenSpec, but not spec-tacular's schema and ground rules. */
  | { kind: 'no-foundation' }
  /** Ground rules scaffolded; some questions still open. */
  | { kind: 'foundation'; answered: number; total: number }
  /** Ground rules settled on a new project: describe the vision next. */
  | { kind: 'vision' }
  /** Ground rules settled; nothing proposed yet. */
  | { kind: 'no-changes' }
  | { kind: 'working' };

/**
 * The steps a first run walks through, as the stepper shows them. A new
 * project describes its vision before its first change; one with a baseline
 * goes straight to a change.
 */
export function setupSteps(greenfield: boolean): string[] {
  return greenfield
    ? ['Set up', 'Ground rules', 'Vision', 'First change']
    : ['Set up', 'Ground rules', 'First change'];
}

/** Index into `setupSteps(greenfield)`, or null once setup is over. */
export function setupStep(stage: ProjectStage, greenfield = false): number | null {
  switch (stage.kind) {
    case 'no-openspec':
    case 'no-foundation':
      return 0;
    case 'foundation':
      return 1;
    case 'vision':
      return 2;
    case 'no-changes':
      return greenfield ? 3 : 2;
    case 'working':
      return null;
  }
}

export function schemaInstalled(projectRoot: string): boolean {
  return existsSync(join(projectRoot, 'openspec', 'schemas', 'spec-tacular'));
}

/**
 * Where the project is.
 *
 * A project that already has changes but no Foundation is `working`, not
 * sent back to setup: it adopted OpenSpec before spec-tacular existed, and the
 * gate deliberately lets it proceed (core/gate.ts). The overview still nudges.
 */
export function projectStage(projectRoot: string, changeCount: number): ProjectStage {
  if (!isOpenSpecProject(projectRoot)) return { kind: 'no-openspec' };

  if (!foundationExists(projectRoot)) {
    return changeCount === 0 ? { kind: 'no-foundation' } : { kind: 'working' };
  }

  // Questions left for later are neither asked nor counted.
  const items = loadFoundation(projectRoot).filter((i) => !isDeferred(i));
  const answered = items.filter((i) => !isUnanswered(i)).length;
  if (answered < items.length) return { kind: 'foundation', answered, total: items.length };

  if (changeCount > 0) return { kind: 'working' };
  // A new project with no roadmap yet starts from its vision — unless the
  // developer said it is not new, or already has a roadmap to work from.
  const session = loadSession(projectRoot);
  const started = session?.skipped || (loadRoadmap(projectRoot)?.slices.length ?? 0) > 0;
  return isGreenfield(projectRoot) && !started ? { kind: 'vision' } : { kind: 'no-changes' };
}

/** What a change's next step is, and which keys act on it. */
export interface NextStep {
  text: string;
  /** Keys the overview offers for this step. */
  actions: ('review' | 'draft' | 'write' | 'foundation')[];
  /** The artifact `draft`/`write` act on. */
  artifact?: string;
}

function reviewNoun(stage: Stage): string {
  return stage.id === 'design' ? 'decision' : 'requirement';
}

/**
 * The single next thing to do on a change.
 *
 * One step, not a list: the point is to never leave someone choosing between
 * five commands they have not learnt yet.
 */
export function nextStep(pipeline: ChangePipeline, foundationSettled: boolean): NextStep {
  const stage = pipeline.current;

  if (!stage) {
    if (pipeline.apply.state === 'ready') {
      return {
        text: 'Planning is done — an agent can start implementing it, in the background.',
        actions: ['draft'],
        artifact: 'apply',
      };
    }
    return { text: `Waiting on ${pipeline.apply.blockedBy.join(', ')}.`, actions: [] };
  }

  if (stage.state === 'written' && stage.review) {
    const r = stage.review;
    const noun = reviewNoun(stage);
    if (r.total === 0) {
      return {
        text: `${stage.id} is written, but has no ${noun}s in a format the review can read.`,
        actions: [],
      };
    }
    if (r.pending === 0 && r.rejected > 0) {
      return {
        text:
          `${r.rejected} ${noun}${r.rejected === 1 ? '' : 's'} rejected. ` +
          'Revise them in the review (e on each), then accept.',
        actions: ['review'],
      };
    }
    const open = r.pending + r.rejected;
    return {
      text: `Review the ${stage.id}: ${open} ${noun}${open === 1 ? '' : 's'} waiting, one at a time.`,
      actions: ['review'],
    };
  }

  if (stage.requires.length === 0 && !foundationSettled) {
    return {
      text: `Set the ground rules before writing the ${stage.id}.`,
      actions: ['foundation'],
    };
  }

  const gate = gateFor(pipeline, stage.id);
  if (!gate.allowed) return { text: `Blocked: ${gate.blockers.join('; ')}.`, actions: [] };

  const what = stage.id === 'proposal'
    ? 'Write the proposal: why this change, and what it changes.'
    : `Write the ${stage.id}.`;
  return {
    text: `${what} Let an agent draft it, or write it yourself.`,
    actions: ['draft', 'write'],
    artifact: stage.id,
  };
}

/** A change name OpenSpec will accept, or why not. */
export function validateChangeName(name: string): string | null {
  if (name === '') return 'A name is required';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return 'Use lowercase words joined by dashes, e.g. add-user-login';
  }
  return null;
}
