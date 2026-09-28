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
  DEFERRED,
  guidedQuestions,
  type GuidedQuestion,
} from './foundation.ts';
import { deriveFromArchitecture } from './derivations.ts';
import { buildCodeFenceMask, normalizeContent, SECTION_HEADER } from './markdown.ts';
import { matchPresets } from './presets.ts';
import { slugify } from './requirements.ts';
import type { StructuredMode } from '../agent/driver.ts';
import { renderPrompt, type ContextSection, type PromptParts } from '../agent/prompt.ts';

export interface AdviceOption {
  /** What the option is, short enough for one row of a list: `uv`, `Hexagonal`. */
  label: string;
  /** One line: why, or the trade-off. */
  detail: string;
  recommended: boolean;
  /**
   * The answer as it is written into the Foundation when picked — for a broad
   * question several lines, covering all of it. Absent (the preset table's
   * one-word options) means the label is the whole answer.
   */
  answer?: string;
}

/** What picking an option writes. */
export function optionAnswer(option: AdviceOption): string {
  return option.answer?.trim() || option.label;
}

export interface FollowUp {
  ask: string;
  /** Why this matters, shown as the question's hint. */
  why: string;
  options: AdviceOption[];
  /**
   * Needed before the first change can be built, so asked during setup. At
   * most one per answer; every other follow-up is written into the Foundation
   * as left for later, and a change that depends on it raises it then.
   */
  now?: boolean;
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
  /**
   * Proposed from earlier answers; shown first, confirmed by the developer.
   * `table`: from core/derivations.ts, instantly, not yet refined by the advisor.
   */
  derived?: { answer: string; reason: string; table?: boolean };
  /** Plain-words explanation, from asking for help. */
  explain?: string;
  /**
   * The question or its options came from the preset table, instantly, and
   * the advisor has not refined them yet.
   */
  preset?: boolean;
}

/**
 * How far follow-ups may nest. The setup is meant to be short: an answer may
 * raise one question that cannot wait, and that one's answer raises none.
 */
export const MAX_DEPTH = 1;
const MAX_FOLLOW_UPS = 3;
const MAX_OPTIONS = 5;

const OPTION_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    detail: { type: 'string' },
    answer: { type: 'string' },
    recommended: { type: 'boolean' },
  },
  required: ['label', 'detail', 'answer', 'recommended'],
} as const;

const FOLLOW_UP_SCHEMA = {
  type: 'object',
  properties: {
    ask: { type: 'string' },
    why: { type: 'string' },
    now: { type: 'boolean' },
    options: { type: 'array', items: OPTION_SCHEMA },
  },
  required: ['ask', 'why', 'now', 'options'],
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
  /** Options already shown for `upcoming` from the preset table, to improve on. */
  upcomingOptions?: AdviceOption[];
  /** Answers already proposed for open questions, to refine rather than repeat. */
  derivedAlready?: Derived[];
  /** The vision and its interview (spec-tacular/vision.md), on a new project. */
  vision?: string;
  /** Propose every open question from the vision, before any is asked. */
  fromVision?: boolean;
}

/** What a new project said about itself before its ground rules, if it did. */
export function readVision(projectRoot: string): string | undefined {
  try {
    const text = readFileSync(join(projectRoot, 'spec-tacular', 'vision.md'), 'utf8').trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Research or think

/**
 * Questions where current facts matter: which release is latest, which tool
 * the ecosystem has moved to. Everything in the Stack document, and anything
 * elsewhere that names tooling.
 */
const LOOKUP = /\b(versions?|runtimes?|frameworks?|librar(y|ies)|packages?|dependenc(y|ies)|tool(s|ing)?|sdks?|test runner|linter|formatter|datastore|database|orm|migrations?|build)\b/i;

export function needsLookup(question: GuidedQuestion): boolean {
  return question.title === 'Stack' || LOOKUP.test(question.item.name);
}

/**
 * Web search only when a request touches such a question. It is what makes a
 * research request slow — a search round-trip per lookup — and most ground
 * rules (domain terms, layering, review rules) have nothing to look up.
 */
export function adviceMode(request: AdviceRequest): StructuredMode {
  const { answered, upcoming } = request;
  if (answered && answered.depth < MAX_DEPTH && needsLookup(answered.question)) return 'research';
  if (upcoming && needsLookup(upcoming)) return 'research';
  return 'think';
}

// ---------------------------------------------------------------------------
// Prompts

const INTRO = [
  'You are helping a developer settle the ground rules of a software project',
  'before any code is written: its stack, domain, architecture and conventions.',
  'Every coding agent that works on the project later reads these answers.',
].join('\n');

/** The project as decided so far: what a session is sent only changes of. */
function projectContext(questions: GuidedQuestion[], vision?: string): ContextSection[] {
  return [
    ...(vision
      ? [{ heading: "The project's vision (the developer's own description, and their interview)", lines: vision.split('\n') }]
      : []),
    {
      heading: 'Decided so far',
      lines: questions
        .filter((q) => q.answered)
        .map((q) => `- [${q.title}] ${q.item.name}\n  ${q.item.text.replace(/\n+/g, ' ')}`),
      empty: '(nothing yet)',
    },
    {
      heading: 'Still open (never ask these again)',
      lines: questions
        .filter((q) => !q.answered)
        .map((q) => `- [${q.title}] ${q.item.name}${q.derive ? ' (propose)' : ''}`),
      empty: '(none)',
    },
  ];
}

/** How options are written. Only research may name versions: it looks them up. */
function optionRules(mode: StructuredMode): string {
  return [
    `Options: 2 to ${MAX_OPTIONS}, best first, exactly one with recommended: true. Each has`,
    'a label naming it, short enough for one row of a list (for example "uv",',
    '"Hexagonal, ports and adapters"); a detail, one line on why or the trade-off; and',
    'an answer: the complete answer as it would be written into the ground rules if',
    'picked. For a narrow question the answer can be as short as the label ("pytest");',
    'for a broad one it covers the whole question, in as many lines as it takes — for',
    'example every layer and which may depend on which, or each tool with its role —',
    'concrete to this project. Prefer what is current state of the art.',
    ...(mode === 'research'
      ? [
          'For versions, recommend the most recent stable release — look it up with',
          'web search rather than relying on memory, and never propose a pre-release.',
        ]
      : [
          'You cannot look anything up here, so never propose a specific version number;',
          'a question that needs one is asked where it can be looked up.',
        ]),
    'A question\'s "ask" is the question text alone, with no [Section] prefix; its',
    '"why" says in one line what depends on the decision. Keep every label under 40',
    'and every detail under 70 characters; an answer has no limit.',
  ].join('\n');
}

export function buildAdviceParts(request: AdviceRequest, mode = adviceMode(request)): PromptParts {
  const task: string[] = [];

  if (request.answered) {
    const { question, answer, depth } = request.answered;
    task.push(
      `Just answered — [${question.title}] ${question.item.name}`,
      `Answer: ${answer}`,
      '',
      depth >= MAX_DEPTH
        ? 'followUps: return an empty list — this answer is already a follow-up of a follow-up.'
        : [
            'followUps: questions that dig deeper into THIS answer, where it leaves a',
            'concrete decision open that later work depends on. The setup is kept short:',
            'only these ground rules are asked now, and a detail is decided when a change',
            'needs it. So mark now: true on at most ONE follow-up, and only when the first',
            'change could not sensibly be designed without it and no question still open',
            'will settle it. Everything else gets now: false and is recorded for later.',
            'Return an empty list when the answer is specific enough for a start.',
            `At most ${MAX_FOLLOW_UPS}. Never repeat a question listed as open.`,
          ].join('\n'),
      '',
    );
  } else {
    task.push('followUps: return an empty list.', '');
  }

  if (request.upcoming) {
    task.push(
      `upcoming: options for the next question — [${request.upcoming.title}] ${request.upcoming.item.name}`,
      'consistent with everything decided so far. Return an empty list when only the',
      'developer can answer it: the project\'s purpose, its domain terms, its rules,',
      'what is out of scope, or anything about their team.',
    );
    if (request.upcomingOptions && request.upcomingOptions.length > 0) {
      task.push(
        `Generic options are shown for it already: ${request.upcomingOptions.map((o) => o.label).join('; ')}.`,
        'Return better ones for this project where you can, or these same ones.',
      );
    }
    task.push('');
  } else {
    task.push('upcoming: return an empty list.', '');
  }

  task.push(
    'derived: for questions listed under "Still open" whose answer already follows',
    'from what is decided — stated outright or clearly implied — propose that answer.',
    'Examples: "uv" decided for packages implies nothing about tests, but "pytest via',
    'uv" does; "Clean architecture" implies business rules live in the domain layer.',
    'Copy the question text exactly, give the answer as it would be written, and a',
    'one-line reason naming the earlier answer it comes from. Only when confident;',
    'the developer confirms each one. Return an empty list otherwise.',
  );

  if (request.fromVision) {
    // The vision came first so that the ground rules need not be asked cold.
    task.push(
      '',
      'The developer described the project in the vision above, and was interviewed',
      'about it, before any ground rule was asked. So derived proposes an answer for',
      'every question under "Still open": what the vision states or clearly implies —',
      'what the system is for and who uses it, its core terms, anything it names about',
      'the stack or the architecture — and, for each marked (propose) that the vision',
      'does not settle, the choice you would recommend for a project like this one:',
      'conventional, current, consistent with the vision. The reason names what in the',
      'vision it follows from. Leave out only a question the vision gives nothing to go',
      'on for and that only the developer can answer. Write each answer in full, as it',
      'would stand in the ground rules — as many lines as the question needs.',
    );
  } else if (request.answered?.question.title === 'Domain' && !request.vision) {
    // The domain comes first so that the rest need not be asked cold.
    task.push(
      '',
      'The domain was asked first so that the rest can follow from it. So derived',
      'also proposes an answer for every open question marked (propose): the choice',
      'you would recommend for a project like this one — conventional, current,',
      'consistent with everything decided — with a reason naming what about the',
      'domain it follows from. A proposal is better than none: the developer confirms',
      'or replaces each. Write each answer in full, as it would stand in the ground',
      'rules — as many lines as the question needs, concrete to this project.',
    );
  }

  if (request.derivedAlready && request.derivedAlready.length > 0) {
    task.push(
      '',
      'Already proposed for open questions (refine each for this project — its',
      'language, its folder names — and return it under derived, or leave it out to',
      'keep it as it is):',
      ...request.derivedAlready.map((d) => `- ${d.question}: ${d.answer}`),
    );
  }

  return { preamble: INTRO, context: projectContext(request.questions, request.vision), task: task.join('\n'), rules: optionRules(mode) };
}

/**
 * A first message that only sets the scene: the standing instructions and
 * the project so far, answered with nothing. Sent to a session before the
 * first question is, so that question pays for a small delta and one model
 * turn instead of an agent starting up and reading everything.
 */
export function buildPrimeParts(questions: GuidedQuestion[], mode: StructuredMode, vision?: string): PromptParts {
  return {
    preamble: INTRO,
    context: projectContext(questions, vision),
    task: [
      'Nothing is asked yet: the developer is about to answer the first question, and',
      'requests follow as they do. For now return followUps, upcoming and derived as',
      'empty lists.',
    ].join('\n'),
    rules: optionRules(mode),
  };
}

export function buildAdvicePrompt(request: AdviceRequest): string {
  return renderPrompt(buildAdviceParts(request));
}

export function coachMode(question: GuidedQuestion): StructuredMode {
  return needsLookup(question) ? 'research' : 'think';
}

/** For a question the developer does not know how to answer. */
export function buildCoachParts(
  questions: GuidedQuestion[],
  question: GuidedQuestion,
  mode = coachMode(question),
  vision?: string,
): PromptParts {
  return {
    preamble: INTRO,
    context: projectContext(questions, vision),
    task: [
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
    ].join('\n'),
    rules: optionRules(mode),
  };
}

export function buildCoachPrompt(questions: GuidedQuestion[], question: GuidedQuestion): string {
  return renderPrompt(buildCoachParts(questions, question));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseOptions(raw: unknown): AdviceOption[] {
  if (!Array.isArray(raw)) return [];
  const options = raw
    .filter(isRecord)
    .map((o) => {
      const label = String(o['label'] ?? '').trim();
      const answer = String(o['answer'] ?? '').trim();
      return {
        label,
        detail: String(o['detail'] ?? '').trim(),
        recommended: o['recommended'] === true,
        ...(answer !== '' && answer !== label ? { answer } : {}),
      };
    })
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
  const followUps = (Array.isArray(raw) ? raw : [])
    .filter(isRecord)
    .map((f) => ({
      // The prompt lists questions as `[Section] question`; models copy that
      // prefix into their own questions often enough to strip it.
      ask: String(f['ask'] ?? '').trim().replace(/^\[[^\]]*\]\s*/, ''),
      why: String(f['why'] ?? '').trim(),
      options: parseOptions(f['options']),
      now: f['now'] === true,
    }))
    .filter((f) => f.ask !== '')
    .slice(0, MAX_FOLLOW_UPS);
  // One asked now at most, whatever the model sent: the first it marked.
  const first = followUps.findIndex((f) => f.now);
  return followUps.map((f, i) => ({ ...f, now: i === first }));
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
 * Inserts follow-ups as new sections straight after their parent: `TBD`, to
 * be asked, when it is needed now (or is a simpler question asked for help);
 * otherwise left for later, like the scaffold's own later questions.
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
  // Questions left for later are not in `existing` (they are not asked), but
  // are in the file: never add one twice.
  if (existsSync(parent.item.file)) {
    for (const line of normalizeContent(readFileSync(parent.item.file, 'utf8')).split('\n')) {
      if (SECTION_HEADER.test(line)) taken.add(slugify(line.replace(/^##\s+/, '').trim()));
    }
  }
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

  const added = fresh.flatMap((f) => ['', `## ${f.ask}`, '', f.now ? 'TBD' : DEFERRED]);
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

export interface AskOptions {
  /** Whether it may search the web; see `adviceMode`. */
  mode?: StructuredMode;
  /** The prompt in parts, for a session that has seen most of it already. */
  parts?: PromptParts;
  /**
   * Only primes a session ahead of the first real request (`buildPrimeParts`):
   * nobody waits for the answer, and without a session it is not worth
   * sending at all.
   */
  prime?: boolean;
}

/**
 * Sends a prompt, returns the model's structured output. `prompt` is always
 * complete on its own; `options.parts` only lets a session send less.
 */
export type Ask = (prompt: string, schema: object, options?: AskOptions) => Promise<unknown>;

export class FoundationAdvisor {
  constructor(
    private readonly projectRoot: string,
    private readonly ask: Ask,
  ) {}

  meta(): Record<string, QuestionMeta> {
    return loadMeta(this.projectRoot);
  }

  private vision(): string | undefined {
    return readVision(this.projectRoot);
  }

  /**
   * Primes the sessions the first questions will use, before any is
   * answered: the domain is thought about, the stack looked up. Fire and
   * forget — a prime that fails costs the first question nothing it would
   * not have paid anyway.
   */
  prime(): void {
    const questions = guidedQuestions(this.projectRoot);
    for (const mode of ['think', 'research'] as const) {
      const parts = buildPrimeParts(questions, mode, this.vision());
      void Promise.resolve()
        .then(() => this.ask(renderPrompt(parts), ADVICE_SCHEMA, { mode, parts, prime: true }))
        .catch(() => {});
    }
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
   * Writes the model's options for a question — unless it was answered while
   * the model was thinking, which settles it. Options that came back empty
   * never replace the preset table's: something to pick beats nothing.
   */
  private offer(id: string, options: AdviceOption[]): void {
    const now = guidedQuestions(this.projectRoot).find((q) => q.item.id === id);
    if (!now || now.answered) return;
    if (options.length === 0 && this.meta()[id]?.preset) {
      updateMeta(this.projectRoot, id, { suggested: true });
      return;
    }
    updateMeta(this.projectRoot, id, { options, suggested: true, preset: undefined });
  }

  /**
   * Called the moment an answer is saved, before any model is asked: the
   * preset table's follow-ups for it (core/presets.ts), and its options for
   * questions already in the Foundation that nobody has advised on yet; and
   * the answers an architecture style decides (core/derivations.ts), as
   * derived proposals. Returns the follow-ups added, by name, in order.
   */
  presets(question: GuidedQuestion, answer: string): string[] {
    const match = matchPresets(question, answer);
    const meta = this.meta();
    const questions = guidedQuestions(this.projectRoot);

    // Over whatever was proposed before: the style was just chosen, and what
    // it decides is no longer a guess.
    for (const d of deriveFromArchitecture(question, answer)) {
      for (const q of questions) {
        if (q.answered || !d.question.test(q.item.name)) continue;
        updateMeta(this.projectRoot, q.item.id, { derived: { answer: d.answer, reason: d.reason, table: true } });
      }
    }

    for (const { question: pattern, options } of match.options) {
      for (const q of questions) {
        if (q.answered || !pattern.test(q.item.name)) continue;
        const m = meta[q.item.id];
        if (m?.suggested || (m?.options?.length ?? 0) > 0) continue;
        updateMeta(this.projectRoot, q.item.id, { options, preset: true });
      }
    }

    const depth = meta[question.item.id]?.depth ?? 0;
    if (depth >= MAX_DEPTH || match.followUps.length === 0) return [];
    // The table cannot tell a detail from what the first change needs, so
    // its follow-ups are recorded for later, never asked during setup.
    insertFollowUps(question, match.followUps.map((f) => ({ ...f, now: false })), questions);
    return [];
  }

  /**
   * Called after an answer is saved: asks for follow-ups on it, options for
   * the next question, and answers later questions now follow from — all in
   * one request. Returns what was added and derived.
   */
  async afterAnswer(
    question: GuidedQuestion,
    answer: string,
  ): Promise<{ added: FollowUp[]; recorded: FollowUp[]; derived: string[] }> {
    const questions = guidedQuestions(this.projectRoot);
    const meta = this.meta();
    const depth = meta[question.item.id]?.depth ?? 0;
    const upcoming = this.nextUnadvised(question, questions);
    const request: AdviceRequest = {
      questions,
      answered: { question, answer, depth },
      upcoming,
      upcomingOptions: upcoming && meta[upcoming.item.id]?.preset ? meta[upcoming.item.id]?.options : undefined,
      // The table's derivations, for the advisor to fit to this project.
      derivedAlready: questions
        .filter((q) => !q.answered && meta[q.item.id]?.derived?.table)
        .map((q) => ({ question: q.item.name, ...meta[q.item.id]!.derived! })),
      vision: this.vision(),
    };
    const mode = adviceMode(request);
    const parts = buildAdviceParts(request, mode);

    const advice = parseAdvice(await this.ask(renderPrompt(parts), ADVICE_SCHEMA, { mode, parts }));

    if (upcoming) this.offer(upcoming.item.id, advice.upcoming);

    // Read again: the developer kept answering while the model thought.
    const now = guidedQuestions(this.projectRoot);

    const derived = this.applyDerived(now, advice.derived, question.item.id);

    // After the follow-ups already there — the preset table's, typically —
    // so the one the developer is looking at does not move down the list.
    const after = this.meta();
    const from = now.findIndex((q) => q.item.id === question.item.id);
    let anchor = now[from] ?? question;
    for (let i = from + 1; from >= 0 && i < now.length; i++) {
      const q = now[i]!;
      if (q.item.file !== question.item.file || after[q.item.id]?.parent !== question.item.name) break;
      anchor = q;
    }
    const inserted = depth >= MAX_DEPTH ? [] : insertFollowUps(anchor, advice.followUps, now);
    const added = inserted.filter((f) => f.now);
    this.recordAdded(question.item.file, added, () => ({ parent: question.item.name, depth: depth + 1 }));
    return { added, recorded: inserted.filter((f) => !f.now), derived };
  }

  /**
   * Only for questions still open and asked exactly — a derived answer
   * attached to the wrong question would be worse than none. Returns the
   * questions it proposed an answer for.
   */
  private applyDerived(now: GuidedQuestion[], proposals: Derived[], except?: string): string[] {
    const derived: string[] = [];
    for (const d of proposals) {
      const target = now.find(
        (q) => !q.answered && q.item.id !== except &&
          (q.item.name === d.question || slugify(q.item.name) === slugify(d.question)),
      );
      if (!target) continue;
      updateMeta(this.projectRoot, target.item.id, { derived: { answer: d.answer, reason: d.reason } });
      derived.push(target.item.name);
    }
    return derived;
  }

  /**
   * On a new project, once its vision is described: proposes an answer for
   * every open ground rule from it — the domain as much as the stack — in one
   * request, so the setup is mostly confirming. Returns the questions
   * proposed for. Nothing without a vision.
   *
   * `text` is the vision as it will be written: passed while the roadmap is
   * still being reviewed, before `vision.md` exists, so the proposals are
   * ready by the time the ground rules open.
   */
  async proposeFromVision(text?: string): Promise<string[]> {
    const vision = text?.trim() || this.vision();
    if (!vision) return [];
    const questions = guidedQuestions(this.projectRoot);
    const meta = this.meta();
    const upcoming = questions.find((q) => !q.answered);
    const request: AdviceRequest = {
      questions,
      upcoming,
      upcomingOptions: upcoming && meta[upcoming.item.id]?.preset ? meta[upcoming.item.id]?.options : undefined,
      vision,
      fromVision: true,
    };
    const mode = adviceMode(request);
    const parts = buildAdviceParts(request, mode);
    const advice = parseAdvice(await this.ask(renderPrompt(parts), ADVICE_SCHEMA, { mode, parts }));
    if (upcoming) this.offer(upcoming.item.id, advice.upcoming);
    return this.applyDerived(guidedQuestions(this.projectRoot), advice.derived);
  }

  /** Options for one question, when it is shown and nobody has asked yet. */
  async suggest(question: GuidedQuestion): Promise<void> {
    const meta = this.meta()[question.item.id];
    if (meta?.suggested) return;
    const questions = guidedQuestions(this.projectRoot);
    const request: AdviceRequest = {
      questions,
      upcoming: question,
      upcomingOptions: meta?.preset ? meta.options : undefined,
      vision: this.vision(),
    };
    const mode = adviceMode(request);
    const parts = buildAdviceParts(request, mode);
    const advice = parseAdvice(await this.ask(renderPrompt(parts), ADVICE_SCHEMA, { mode, parts }));
    this.offer(question.item.id, advice.upcoming);
  }

  /**
   * Help for a question the developer does not know how to answer: what it
   * means, examples for this project, and simpler questions to answer first.
   * The simpler questions go before it, and their answers can derive it.
   */
  async coach(question: GuidedQuestion): Promise<{ explain: string; probes: FollowUp[] }> {
    const questions = guidedQuestions(this.projectRoot);
    const depth = this.meta()[question.item.id]?.depth ?? 0;
    const mode = coachMode(question);
    const parts = buildCoachParts(questions, question, mode, this.vision());
    const coaching = parseCoaching(await this.ask(renderPrompt(parts), COACH_SCHEMA, { mode, parts }));
    updateMeta(this.projectRoot, question.item.id, {
      explain: coaching.explain,
      ...(coaching.examples.length > 0 ? { options: coaching.examples, preset: undefined } : {}),
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
