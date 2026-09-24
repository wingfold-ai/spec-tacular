/**
 * The vision interview: how a greenfield project gets from an idea to its
 * first change.
 *
 * OpenSpec's unit of work is a *change* against an existing baseline. On day
 * one there is no baseline, and "what do you want to change?" is the wrong
 * question — there is nothing to change yet (docs/problem-analysis.md §4). So
 * a greenfield project starts from its vision instead: described freely, then
 * sharpened by an interview that asks one question at a time until the
 * developer stops it or the model has enough, then split into an ordered
 * roadmap of slices. Each slice becomes a change when its turn comes.
 *
 * Like the Foundation advisor, the model proposes and the developer decides:
 * the slices are reviewed before anything is written to the roadmap.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AdviceOption, Ask } from './advisor.ts';
import { guidedQuestions } from './foundation.ts';
import { validateChangeName } from './guide.ts';
import { unique } from './naming.ts';
import { promoteSlice, saveRoadmap, type Roadmap, type Slice } from './roadmap.ts';

export interface InterviewQuestion {
  ask: string;
  why: string;
  options: AdviceOption[];
}

export interface VisionTurn {
  ask: string;
  /** What the developer said, or null when they skipped the question. */
  answer: string | null;
}

export interface ProposedSlice {
  id: string;
  title: string;
  /** What a user can do once it lands. */
  summary: string;
  why: string;
  dependsOn: string[];
}

export interface VisionSession {
  /** The developer's own description, as typed. */
  vision: string;
  turns: VisionTurn[];
  /** The model's restatement of the vision, refined after every answer. */
  understood: string;
  /** The question on screen, if any. */
  pending: InterviewQuestion | null;
  /** The model has enough, or the developer ended the interview. */
  finished: boolean;
  slices: ProposedSlice[];
  /** The model's one-paragraph vision, from splitting it into slices. */
  refined?: string;
  /** Not a new project after all — start from a single change instead. */
  skipped?: boolean;
}

/** Past this many answers the interview ends, whatever the model thinks. */
export const MAX_TURNS = 12;

// ---------------------------------------------------------------------------
// Greenfield

/**
 * Whether the project starts from nothing: no accepted specs in the baseline
 * and nothing archived. Existing code without specs also reads as greenfield,
 * which is why the vision screen offers a way out.
 */
export function isGreenfield(projectRoot: string): boolean {
  const hasMarkdown = (dir: string): boolean => {
    if (!existsSync(dir)) return false;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (hasMarkdown(path)) return true;
      } else if (entry.endsWith('.md')) return true;
    }
    return false;
  };
  const archive = join(projectRoot, 'openspec', 'changes', 'archive');
  const archived = existsSync(archive) && readdirSync(archive).some((e) => !e.startsWith('.'));
  return !hasMarkdown(join(projectRoot, 'openspec', 'specs')) && !archived;
}

// ---------------------------------------------------------------------------
// Persistence: an interview can be left and resumed

export function sessionPath(projectRoot: string): string {
  return join(projectRoot, '.spec-tacular', 'vision-session.json');
}

export function loadSession(projectRoot: string): VisionSession | null {
  try {
    return JSON.parse(readFileSync(sessionPath(projectRoot), 'utf8')) as VisionSession;
  } catch {
    return null;
  }
}

function saveSession(projectRoot: string, session: VisionSession): void {
  const path = sessionPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

export function clearSession(projectRoot: string): void {
  rmSync(sessionPath(projectRoot), { force: true });
}

// ---------------------------------------------------------------------------
// Prompts

const OPTION_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    detail: { type: 'string' },
    recommended: { type: 'boolean' },
  },
  required: ['label', 'detail', 'recommended'],
} as const;

export const INTERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    understood: { type: 'string' },
    enough: { type: 'boolean' },
    question: {
      type: 'object',
      properties: {
        ask: { type: 'string' },
        why: { type: 'string' },
        options: { type: 'array', items: OPTION_SCHEMA },
      },
      required: ['ask', 'why', 'options'],
    },
  },
  required: ['understood', 'enough', 'question'],
} as const;

export const SLICES_SCHEMA = {
  type: 'object',
  properties: {
    vision: { type: 'string' },
    slices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          why: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'summary', 'why', 'dependsOn'],
      },
    },
  },
  required: ['vision', 'slices'],
} as const;

/** The ground rules answered so far, so the interview does not re-ask them. */
function groundRules(projectRoot: string): string[] {
  const answered = guidedQuestions(projectRoot).filter((q) => q.answered);
  return answered.length > 0
    ? answered.map((q) => `- [${q.title}] ${q.item.name} ${q.item.text.replace(/\n+/g, ' ')}`)
    : ['(none yet)'];
}

function transcript(session: VisionSession): string[] {
  return session.turns.length > 0
    ? session.turns.flatMap((t) => [`Q: ${t.ask}`, `A: ${t.answer ?? '(skipped — the developer does not know yet)'}`])
    : ['(no questions asked yet)'];
}

export function buildInterviewPrompt(projectRoot: string, session: VisionSession): string {
  return [
    'A developer is starting a new software project from nothing. Interview them',
    'about their vision until you understand it well enough to split it into a',
    'sequence of small slices, each one a change that is proposed, specified,',
    'designed and built on its own.',
    '',
    'Their vision, in their words:',
    session.vision,
    '',
    'Ground rules already settled (never ask about these):',
    ...groundRules(projectRoot),
    '',
    'The interview so far:',
    ...transcript(session),
    '',
    'understood: restate the vision as you now understand it, in 2 to 4 plain',
    'sentences, so the developer can see whether you got it right.',
    '',
    'enough: true once you could split the vision into slices with confidence —',
    'who uses it, the core things they do, what the first usable version must',
    'do, and what is out of scope are clear. Prefer ending early to asking',
    'about details a later change can settle.',
    '',
    'question: when not enough, the single most important unknown, as one',
    'concrete question a developer can answer from what they want — about',
    'users, what they do, what comes first, what is out of scope, constraints',
    'such as data, integrations or platforms. Never technology already settled.',
    'Offer 2 to 5 options where natural (short label, one-line detail, exactly',
    'one recommended); none for questions only they can answer. "why" says in',
    'one line what the answer decides. When enough, return an empty ask.',
  ].join('\n');
}

export function buildSlicesPrompt(projectRoot: string, session: VisionSession): string {
  return [
    'Split a new project into slices: an ordered roadmap where each slice becomes',
    'one change (proposal, specs, design, tasks) built and reviewed on its own.',
    '',
    'The vision, in the developer\'s words:',
    session.vision,
    '',
    'As understood after interviewing them:',
    session.understood || '(no interview)',
    '',
    'The interview:',
    ...transcript(session),
    '',
    'Ground rules:',
    ...groundRules(projectRoot),
    '',
    'vision: one paragraph, in plain words, of what is being built and for whom.',
    '',
    'slices: 3 to 8, in build order. The first is the smallest thing a user can',
    'actually do end to end; each later one adds one capability a user would',
    'notice. Each small enough to review in one sitting. No slice that is only',
    'setup or infrastructure — fold that into the first slice that needs it.',
    '  id: kebab-case, 2 to 4 words, verb first (add-user-login); it becomes the',
    '      change name.',
    '  title: a few words.',
    '  summary: one sentence — what a user can do once it lands.',
    '  why: one line — why it comes at this point in the order.',
    '  dependsOn: ids of earlier slices it needs.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Parsing

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseOptions(raw: unknown): AdviceOption[] {
  if (!Array.isArray(raw)) return [];
  const options = raw
    .filter(isRecord)
    .map((o) => ({
      label: String(o['label'] ?? '').trim(),
      detail: String(o['detail'] ?? '').trim(),
      recommended: o['recommended'] === true,
    }))
    .filter((o) => o.label !== '')
    .slice(0, 5);
  const first = options.findIndex((o) => o.recommended);
  return options.map((o, i) => ({ ...o, recommended: i === (first < 0 ? 0 : first) }));
}

export function parseInterview(raw: unknown): {
  understood: string;
  enough: boolean;
  question: InterviewQuestion | null;
} {
  if (!isRecord(raw)) return { understood: '', enough: true, question: null };
  const q = isRecord(raw['question']) ? raw['question'] : {};
  const ask = String(q['ask'] ?? '').trim();
  const enough = raw['enough'] === true || ask === '';
  return {
    understood: String(raw['understood'] ?? '').trim(),
    enough,
    question: enough
      ? null
      : { ask, why: String(q['why'] ?? '').trim(), options: parseOptions(q['options']) },
  };
}

/** Slices OpenSpec can name, unique, depending only on slices before them. */
export function parseSlices(raw: unknown, taken: string[] = []): { vision: string; slices: ProposedSlice[] } {
  if (!isRecord(raw)) return { vision: '', slices: [] };
  const seen: string[] = [...taken];
  const slices: ProposedSlice[] = [];
  for (const s of Array.isArray(raw['slices']) ? raw['slices'] : []) {
    if (!isRecord(s)) continue;
    let id = String(s['id'] ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (validateChangeName(id) !== null) continue;
    id = unique(id, seen);
    const earlier = slices.map((x) => x.id);
    slices.push({
      id,
      title: String(s['title'] ?? '').trim() || id,
      summary: String(s['summary'] ?? '').trim(),
      why: String(s['why'] ?? '').trim(),
      dependsOn: (Array.isArray(s['dependsOn']) ? s['dependsOn'] : [])
        .map((d) => String(d))
        .filter((d) => earlier.includes(d)),
    });
    seen.push(id);
  }
  return { vision: String(raw['vision'] ?? '').trim(), slices };
}

// ---------------------------------------------------------------------------
// Writing the result

/** The vision as agents read it: the refined paragraph, then the interview. */
export function renderVision(vision: string, session: VisionSession): string {
  const lines = ['# Vision', '', vision || session.vision, ''];
  if (session.understood && vision !== session.vision) {
    lines.push('## In the developer\'s words', '', session.vision, '');
  }
  const answered = session.turns.filter((t) => t.answer !== null);
  if (answered.length > 0) {
    lines.push('## Interview', '');
    for (const t of answered) lines.push(`**${t.ask}**`, '', t.answer!, '');
  }
  return lines.join('\n');
}

/**
 * Writes the vision and the roadmap, and makes the first slice active.
 * Returns that slice, whose change the caller then creates.
 */
export function finalizeVision(
  projectRoot: string,
  session: VisionSession,
  vision: string,
  kept: ProposedSlice[],
): Slice | null {
  const path = join(projectRoot, 'spec-tacular', 'vision.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderVision(vision, session), 'utf8');

  // A dropped slice cannot be depended on.
  const ids = new Set(kept.map((s) => s.id));
  const roadmap: Roadmap = {
    vision: vision || session.vision,
    slices: kept.map((s) => ({
      id: s.id,
      summary: `${s.title}: ${s.summary}`,
      status: 'planned' as const,
      dependsOn: s.dependsOn.filter((d) => ids.has(d)),
    })),
  };
  const first = roadmap.slices.find((s) => s.dependsOn.length === 0);
  if (!first) {
    saveRoadmap(projectRoot, roadmap);
    return null;
  }
  const promoted = promoteSlice(roadmap, first.id);
  saveRoadmap(projectRoot, promoted.ok ? promoted.roadmap : roadmap);
  return promoted.ok ? promoted.slice : null;
}

/** A change's description, from its slice: what, then why it comes now. */
export function sliceDescription(slice: ProposedSlice): string {
  return [`${slice.title}: ${slice.summary}`, slice.why ? `Why now: ${slice.why}` : '']
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// The interviewer

export class VisionInterviewer {
  constructor(
    private readonly projectRoot: string,
    private readonly ask: Ask,
  ) {}

  session(): VisionSession | null {
    return loadSession(this.projectRoot);
  }

  /** Not a new project: never offer the vision interview here again. */
  skip(): void {
    saveSession(this.projectRoot, {
      vision: '', turns: [], understood: '', pending: null, finished: true, slices: [], skipped: true,
    });
  }

  /** Starts from the developer's own description, and asks the first question. */
  async start(vision: string): Promise<VisionSession> {
    const session: VisionSession = {
      vision: vision.trim(), turns: [], understood: '', pending: null, finished: false, slices: [],
    };
    saveSession(this.projectRoot, session);
    return this.next(session);
  }

  /** Records an answer (null: skipped) and asks the next question. */
  async answer(text: string | null): Promise<VisionSession> {
    const session = this.session();
    if (!session?.pending) throw new Error('No question is waiting for an answer');
    session.turns.push({ ask: session.pending.ask, answer: text });
    session.pending = null;
    saveSession(this.projectRoot, session);
    return this.next(session);
  }

  /** Asks again after a failure, or after quitting while it was thinking. */
  async resume(): Promise<VisionSession> {
    const session = this.session();
    if (!session?.vision) throw new Error('No vision yet');
    if (session.pending || session.finished) return session;
    return this.next(session);
  }

  /** The developer has said enough. */
  finish(): VisionSession {
    const session = this.session();
    if (!session) throw new Error('No vision yet');
    session.pending = null;
    session.finished = true;
    saveSession(this.projectRoot, session);
    return session;
  }

  private async next(session: VisionSession): Promise<VisionSession> {
    if (session.turns.length >= MAX_TURNS) return this.finish();
    const step = parseInterview(
      await this.ask(buildInterviewPrompt(this.projectRoot, session), INTERVIEW_SCHEMA),
    );
    session.understood = step.understood || session.understood;
    session.pending = step.question;
    session.finished = step.enough;
    saveSession(this.projectRoot, session);
    return session;
  }

  /** Splits the vision into slices, for the developer to review. */
  async extract(taken: string[] = []): Promise<{ vision: string; slices: ProposedSlice[] }> {
    const session = this.session();
    if (!session) throw new Error('No vision yet');
    const result = parseSlices(
      await this.ask(buildSlicesPrompt(this.projectRoot, session), SLICES_SCHEMA),
      taken,
    );
    session.slices = result.slices;
    session.refined = result.vision;
    saveSession(this.projectRoot, session);
    return result;
  }
}
