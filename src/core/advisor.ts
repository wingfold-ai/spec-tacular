/**
 * The Foundation advisor: an AI that digs deeper where an answer leaves a
 * decision open, and proposes options for the questions still ahead.
 *
 * "Python" is not a stack — it leaves the version, the package manager and the
 * test runner undecided, and whatever the first change's agent picks for them
 * becomes an accident every later change inherits. The static questions cannot
 * know which follow-ups an answer needs; a model that sees the answer can.
 *
 * Two rules keep it honest:
 *   - It proposes, it never decides. Options are shown with one marked
 *     recommended, but nothing is written until a human picks one or types
 *     their own. The Foundation still holds only decisions somebody made.
 *   - It runs in the background. Setup never waits on it; a follow-up that
 *     arrives late is simply the next question.
 *
 * The model is reached through an injected `ask`, so this module knows nothing
 * about which agent answers — and is tested without one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  guidedQuestions,
  type GuidedQuestion,
} from './foundation.ts';
import { buildCodeFenceMask, normalizeContent, SECTION_HEADER } from './markdown.ts';
import { slugify } from './requirements.ts';

export interface AdviceOption {
  /** The answer itself, as it would be written: `uv`, `3.14`. */
  label: string;
  /** One line: why, or the trade-off. */
  detail: string;
  recommended: boolean;
}

export interface FollowUp {
  ask: string;
  /** Why this matters, shown as the question's hint. */
  why: string;
  options: AdviceOption[];
}

/** An answer to a later question that already follows from earlier ones. */
export interface Derived {
  /** The open question, exactly as asked. */
  question: string;
  answer: string;
  /** Which earlier answer it follows from, in one line. */
  reason: string;
}

export interface Advice {
  followUps: FollowUp[];
  /** Options for the next question, when it is one a model can help with. */
  upcoming: AdviceOption[];
  derived: Derived[];
}

/** Help for a question the developer does not know how to answer. */
export interface Coaching {
  /** What the question means and why it matters, in plain words. */
  explain: string;
  /** Concrete answers for this project, to pick from or adapt. */
  examples: AdviceOption[];
  /** Simpler questions whose answers would settle this one. */
  probes: FollowUp[];
}

/** What spec-tacular remembers about a question beyond its Markdown section. */
export interface QuestionMeta {
  options?: AdviceOption[];
  /** The question was asked about, even if it came back with no options. */
  suggested?: boolean;
  /** Set on a follow-up: the question whose answer raised it. */
  parent?: string;
  why?: string;
  /** 0 for the scaffold's questions; follow-ups are one deeper than their parent. */
  depth?: number;
  /** Set on a simpler question added to help decide another: that question. */
  helps?: string;
  /** Proposed from earlier answers; shown first, confirmed by the developer. */
  derived?: { answer: string; reason: string };
  /** Plain-words explanation, from asking for help. */
  explain?: string;
}

/** How far follow-ups may nest. Past this, an answer is detailed enough. */
export const MAX_DEPTH = 2;
const MAX_FOLLOW_UPS = 3;
const MAX_OPTIONS = 5;

const OPTION_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    detail: { type: 'string' },
    recommended: { type: 'boolean' },
  },
  required: ['label', 'detail', 'recommended'],
} as const;

const FOLLOW_UP_SCHEMA = {
  type: 'object',
  properties: {
    ask: { type: 'string' },
    why: { type: 'string' },
    options: { type: 'array', items: OPTION_SCHEMA },
  },
  required: ['ask', 'why', 'options'],
} as const;

/** The JSON Schema the model must answer in. */
export const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    followUps: { type: 'array', items: FOLLOW_UP_SCHEMA },
    upcoming: { type: 'array', items: OPTION_SCHEMA },
    derived: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['question', 'answer', 'reason'],
      },
    },
  },
  required: ['followUps', 'upcoming', 'derived'],
} as const;

export const COACH_SCHEMA = {
  type: 'object',
  properties: {
    explain: { type: 'string' },
    examples: { type: 'array', items: OPTION_SCHEMA },
    probes: { type: 'array', items: FOLLOW_UP_SCHEMA },
  },
  required: ['explain', 'examples', 'probes'],
} as const;

export interface AdviceRequest {
  /** Every question so far, answered or not, so nothing is asked twice. */
  questions: GuidedQuestion[];
  /** The answer that was just given, if any. */
  answered?: { question: GuidedQuestion; answer: string; depth: number };
  /** The question to propose options for, if any. */
  upcoming?: GuidedQuestion;
}

/** What every advisor prompt starts with: the project as decided so far. */
function preamble(questions: GuidedQuestion[]): string[] {
  const decided = questions
    .filter((q) => q.answered)
    .map((q) => `- [${q.title}] ${q.item.name}\n  ${q.item.text.replace(/\n+/g, ' ')}`);
  const open = questions
    .filter((q) => !q.answered)
    .map((q) => `- [${q.title}] ${q.item.name}`);
  return [
    'You are helping a developer settle the ground rules of a software project',
    'before any code is written: its stack, domain, architecture and conventions.',
    'Every coding agent that works on the project later reads these answers.',
    '',
    'Decided so far:',
    ...(decided.length > 0 ? decided : ['(nothing yet)']),
    '',
    'Still open (never ask these again):',
    ...(open.length > 0 ? open : ['(none)']),
    '',
  ];
}

const OPTION_RULES = [
  `Options: 2 to ${MAX_OPTIONS}, best first, exactly one with recommended: true. A label is`,
  'the literal answer, short (for example "uv", "3.14", "pytest"); the detail is one',
  'line on why or the trade-off. Prefer what is current state of the art. For',
  'versions, recommend the most recent stable release — look it up with web search',
  'rather than relying on memory, and never propose a pre-release. A question\'s',
  '"ask" is the question text alone, with no [Section] prefix; its "why" says in',
  'one line what depends on the decision. Keep every detail under 70 characters.',
];

export function buildAdvicePrompt(request: AdviceRequest): string {
  const lines = preamble(request.questions);

  if (request.answered) {
    const { question, answer, depth } = request.answered;
    lines.push(
      `Just answered — [${question.title}] ${question.item.name}`,
      `Answer: ${answer}`,
      '',
      depth >= MAX_DEPTH
        ? 'followUps: return an empty list — this answer is already a follow-up of a follow-up.'
        : [
            'followUps: questions that dig deeper into THIS answer, only where it leaves a',
            'concrete decision open that later work depends on. Examples: a language',
            'without a version; a language without its package manager, test runner or',
            'linter; a datastore without its migration tool; an architecture style without',
            'where its boundaries sit. Return an empty list when the answer is already',
            `specific enough. At most ${MAX_FOLLOW_UPS}. Never repeat a question listed above.`,
          ].join('\n'),
      '',
    );
  } else {
    lines.push('followUps: return an empty list.', '');
  }

  if (request.upcoming) {
    lines.push(
      `upcoming: options for the next question — [${request.upcoming.title}] ${request.upcoming.item.name}`,
      'consistent with everything decided so far. Return an empty list when only the',
      'developer can answer it: the project\'s purpose, its domain terms, its rules,',
      'what is out of scope, or anything about their team.',
      '',
    );
  } else {
    lines.push('upcoming: return an empty list.', '');
  }

  lines.push(
    'derived: for questions listed under "Still open" whose answer already follows',
    'from what is decided — stated outright or clearly implied — propose that answer.',
    'Examples: "uv" decided for packages implies nothing about tests, but "pytest via',
    'uv" does; "Clean architecture" implies business rules live in the domain layer.',
    'Copy the question text exactly, give the answer as it would be written, and a',
    'one-line reason naming the earlier answer it comes from. Only when confident;',
    'the developer confirms each one. Return an empty list otherwise.',
    '',
  );

  lines.push(...OPTION_RULES);
  return lines.join('\n');
}

/** For a question the developer does not know how to answer. */
export function buildCoachPrompt(questions: GuidedQuestion[], question: GuidedQuestion): string {
  return [
    ...preamble(questions),
    `The developer does not know how to answer — [${question.title}] ${question.item.name}`,
    '',
    'explain: in two or three short sentences of plain words, what this question is',
    'asking and what later depends on it. No jargon without saying what it means.',
    '',
    'examples: concrete answers that would fit THIS project given what is decided,',
    'as options to pick from or adapt.',
    '',
    'probes: up to 3 simpler questions — ones a developer can answer from what they',
    'want the project to do, without knowing the technical term — whose answers',
    'would let you settle this question for them. Each with options. Return an',
    'empty list when the examples alone are enough to choose from.',
    '',
    ...OPTION_RULES,
  ].join('\n');
}

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
    .slice(0, MAX_OPTIONS);
  // Exactly one recommendation, whatever the model sent: none reads as "no
  // opinion", several as no recommendation at all.
  const first = options.findIndex((o) => o.recommended);
  return options.map((o, i) => ({ ...o, recommended: i === (first < 0 ? 0 : first) }));
}

/**
 * Validates a model's answer. Anything malformed becomes "no advice" rather
 * than an error: the advisor is an aid, and setup must work without it.
 */
function parseFollowUps(raw: unknown): FollowUp[] {
  return (Array.isArray(raw) ? raw : [])
    .filter(isRecord)
    .map((f) => ({
      // The prompt lists questions as `[Section] question`; models copy that
      // prefix into their own questions often enough to strip it.
      ask: String(f['ask'] ?? '').trim().replace(/^\[[^\]]*\]\s*/, ''),
      why: String(f['why'] ?? '').trim(),
      options: parseOptions(f['options']),
    }))
    .filter((f) => f.ask !== '')
    .slice(0, MAX_FOLLOW_UPS);
}

export function parseAdvice(raw: unknown): Advice {
  if (!isRecord(raw)) return { followUps: [], upcoming: [], derived: [] };
  const derived = (Array.isArray(raw['derived']) ? raw['derived'] : [])
    .filter(isRecord)
    .map((d) => ({
      question: String(d['question'] ?? '').trim().replace(/^\[[^\]]*\]\s*/, ''),
      answer: String(d['answer'] ?? '').trim(),
      reason: String(d['reason'] ?? '').trim(),
    }))
    .filter((d) => d.question !== '' && d.answer !== '');
  return {
    followUps: parseFollowUps(raw['followUps']),
    upcoming: parseOptions(raw['upcoming']),
    derived,
  };
}

export function parseCoaching(raw: unknown): Coaching {
  if (!isRecord(raw)) return { explain: '', examples: [], probes: [] };
  return {
    explain: String(raw['explain'] ?? '').trim(),
    examples: parseOptions(raw['examples']),
    probes: parseFollowUps(raw['probes']),
  };
}

// ---------------------------------------------------------------------------
// What is remembered between runs

export function metaPath(projectRoot: string): string {
  return join(projectRoot, '.spec-tacular', 'foundation-advice.json');
}

export function loadMeta(projectRoot: string): Record<string, QuestionMeta> {
  try {
    const raw = JSON.parse(readFileSync(metaPath(projectRoot), 'utf8')) as unknown;
    return isRecord(raw) ? (raw as Record<string, QuestionMeta>) : {};
  } catch {
    return {};
  }
}

function saveMeta(projectRoot: string, meta: Record<string, QuestionMeta>): void {
  const path = metaPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

function updateMeta(projectRoot: string, id: string, patch: QuestionMeta): void {
  const meta = loadMeta(projectRoot);
  meta[id] = { ...meta[id], ...patch };
  saveMeta(projectRoot, meta);
}

// ---------------------------------------------------------------------------
// Writing follow-ups into the Foundation

/**
 * Inserts follow-ups as new sections straight after their parent, each left
 * `TBD` like any scaffolded question.
 *
 * They go into the Markdown, not only the sidecar: the Foundation files are
 * the source of truth, a follow-up is as much a ground rule as the scaffold's
 * own questions, and it must survive this tool not being installed.
 */
export function insertFollowUps(
  parent: GuidedQuestion,
  followUps: FollowUp[],
  existing: GuidedQuestion[],
  where: 'after' | 'before' = 'after',
): FollowUp[] {
  const taken = new Set(existing.map((q) => slugify(q.item.name)));
  const fresh = followUps.filter((f) => {
    const slug = slugify(f.ask);
    if (taken.has(slug)) return false;
    taken.add(slug);
    return true;
  });
  if (fresh.length === 0 || !existsSync(parent.item.file)) return [];

  const lines = normalizeContent(readFileSync(parent.item.file, 'utf8')).split('\n');
  const mask = buildCodeFenceMask(lines);
  const start = lines.findIndex(
    (l, i) => !mask[i] && SECTION_HEADER.test(l) && l.replace(/^##\s+/, '').trim() === parent.item.name,
  );
  if (start < 0) return [];
  if (where === 'before') {
    // Simpler questions that help decide this one go first, so they are
    // answered before it comes round again.
    const added = fresh.flatMap((f) => [`## ${f.ask}`, '', 'TBD', '']);
    const next = [...lines.slice(0, start), ...added, ...lines.slice(start)];
    writeFileSync(parent.item.file, next.join('\n'), 'utf8');
    return fresh;
  }
  let end = start + 1;
  while (end < lines.length && (mask[end] || !SECTION_HEADER.test(lines[end] ?? ''))) end++;
  // The parent's body ends at its last non-blank line; the blank lines after it
  // are replaced, so the file keeps exactly one blank line between sections.
  let last = end - 1;
  while (last > start && (lines[last] ?? '').trim() === '') last--;

  const added = fresh.flatMap((f) => ['', `## ${f.ask}`, '', 'TBD']);
  const next = [...lines.slice(0, last + 1), ...added, '', ...lines.slice(end)];
  writeFileSync(parent.item.file, next.join('\n'), 'utf8');
  return fresh;
}

/** Removes a question the advisor added and the developer finds irrelevant. */
export function removeQuestion(question: GuidedQuestion): boolean {
  if (!existsSync(question.item.file)) return false;
  const lines = normalizeContent(readFileSync(question.item.file, 'utf8')).split('\n');
  const mask = buildCodeFenceMask(lines);
  const start = lines.findIndex(
    (l, i) => !mask[i] && SECTION_HEADER.test(l) && l.replace(/^##\s+/, '').trim() === question.item.name,
  );
  if (start < 0) return false;
  let end = start + 1;
  while (end < lines.length && (mask[end] || !SECTION_HEADER.test(lines[end] ?? ''))) end++;
  writeFileSync(question.item.file, [...lines.slice(0, start), ...lines.slice(end)].join('\n'), 'utf8');
  return true;
}

// ---------------------------------------------------------------------------
// The advisor

/** Sends a prompt, returns the model's structured output. */
export type Ask = (prompt: string, schema: object) => Promise<unknown>;

export class FoundationAdvisor {
  constructor(
    private readonly projectRoot: string,
    private readonly ask: Ask,
  ) {}

  meta(): Record<string, QuestionMeta> {
    return loadMeta(this.projectRoot);
  }

  /** The next open question with no advice yet — what to prefetch. */
  private nextUnadvised(after: GuidedQuestion | undefined, questions: GuidedQuestion[]) {
    const meta = this.meta();
    const from = after ? questions.findIndex((q) => q.item.id === after.item.id) + 1 : 0;
    return questions
      .slice(from)
      .find((q) => !q.answered && !meta[q.item.id]?.suggested);
  }

  /** Records meta for questions just written into the files, found by name. */
  private recordAdded(
    file: string,
    added: FollowUp[],
    patch: (f: FollowUp) => QuestionMeta,
  ): void {
    // Ids are only known once the sections exist, so read the files back.
    const after = guidedQuestions(this.projectRoot);
    for (const f of added) {
      const q = after.find((x) => x.item.name === f.ask && x.item.file === file);
      if (q) updateMeta(this.projectRoot, q.item.id, { options: f.options, suggested: true, why: f.why, ...patch(f) });
    }
  }

  /**
   * Called after an answer is saved: asks for follow-ups on it, options for
   * the next question, and answers later questions now follow from — all in
   * one request. Returns what was added and derived.
   */
  async afterAnswer(
    question: GuidedQuestion,
    answer: string,
  ): Promise<{ added: FollowUp[]; derived: string[] }> {
    const questions = guidedQuestions(this.projectRoot);
    const meta = this.meta();
    const depth = meta[question.item.id]?.depth ?? 0;
    const upcoming = this.nextUnadvised(question, questions);

    const advice = parseAdvice(
      await this.ask(
        buildAdvicePrompt({ questions, answered: { question, answer, depth }, upcoming }),
        ADVICE_SCHEMA,
      ),
    );

    if (upcoming) {
      updateMeta(this.projectRoot, upcoming.item.id, { options: advice.upcoming, suggested: true });
    }

    // Only for questions still open and asked exactly — a derived answer
    // attached to the wrong question would be worse than none.
    const derived: string[] = [];
    for (const d of advice.derived) {
      const target = questions.find(
        (q) => !q.answered && q.item.id !== question.item.id &&
          (q.item.name === d.question || slugify(q.item.name) === slugify(d.question)),
      );
      if (!target) continue;
      updateMeta(this.projectRoot, target.item.id, { derived: { answer: d.answer, reason: d.reason } });
      derived.push(target.item.name);
    }

    const added = depth >= MAX_DEPTH ? [] : insertFollowUps(question, advice.followUps, questions);
    this.recordAdded(question.item.file, added, () => ({ parent: question.item.name, depth: depth + 1 }));
    return { added, derived };
  }

  /** Options for one question, when it is shown and nobody has asked yet. */
  async suggest(question: GuidedQuestion): Promise<void> {
    if (this.meta()[question.item.id]?.suggested) return;
    const questions = guidedQuestions(this.projectRoot);
    const advice = parseAdvice(
      await this.ask(buildAdvicePrompt({ questions, upcoming: question }), ADVICE_SCHEMA),
    );
    updateMeta(this.projectRoot, question.item.id, { options: advice.upcoming, suggested: true });
  }

  /**
   * Help for a question the developer does not know how to answer: what it
   * means, examples for this project, and simpler questions to answer first.
   * The simpler questions go before it, and their answers can derive it.
   */
  async coach(question: GuidedQuestion): Promise<{ explain: string; probes: FollowUp[] }> {
    const questions = guidedQuestions(this.projectRoot);
    const depth = this.meta()[question.item.id]?.depth ?? 0;
    const coaching = parseCoaching(
      await this.ask(buildCoachPrompt(questions, question), COACH_SCHEMA),
    );
    updateMeta(this.projectRoot, question.item.id, {
      explain: coaching.explain,
      ...(coaching.examples.length > 0 ? { options: coaching.examples } : {}),
      suggested: true,
    });
    const probes = insertFollowUps(question, coaching.probes, questions, 'before');
    this.recordAdded(question.item.file, probes, () => ({ helps: question.item.name, depth: depth + 1 }));
    return { explain: coaching.explain, probes };
  }

  dismiss(question: GuidedQuestion): boolean {
    const removed = removeQuestion(question);
    if (removed) {
      const meta = this.meta();
      delete meta[question.item.id];
      saveMeta(this.projectRoot, meta);
    }
    return removed;
  }
}
