/**
 * Revising an answer with the agent, in conversation — a ground rule's, or
 * one given in the vision interview. The counterpart of revising a
 * requirement (core/refine.ts).
 *
 * A proposed option is a starting point: on the ground-rules screen you pick
 * one, say what should change ("we deploy to Fly, not AWS"), and the agent
 * answers with the revised answer. Nothing is written until you accept it,
 * and then only into that question's section (answerFoundation).
 *
 * Every request carries the whole conversation, like a requirement's
 * revision, so a restarted session answers it as well as the one that heard
 * it all.
 */

import type { Ask } from './advisor.ts';
import type { GuidedQuestion } from './foundation.ts';
import type { VisionSession } from './vision.ts';
import { normalizeContent, SECTION_HEADER } from './markdown.ts';
import type { RefineTurn, Refinement } from './refine.ts';
import { renderPrompt, type ContextSection, type PromptParts } from '../agent/prompt.ts';

export const ANSWER_REFINE_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['answer', 'summary'],
} as const;

/** What the agent is shown besides the answer being revised. */
export type AnswerContext =
  | {
      /** A ground rule. */
      question: GuidedQuestion;
      /** Every ground rule, answered or not, for consistency with the rest. */
      questions: GuidedQuestion[];
    }
  | {
      /** A question of the vision interview, as asked. */
      ask: string;
      why?: string;
      /** The vision and the interview so far. */
      interview: VisionSession;
    };

const GROUND_RULES_PREAMBLE = [
  'You are helping a developer settle the ground rules of a software project:',
  'its domain, stack, architecture and conventions. Every coding agent that works',
  'on the project reads them. You revise one answer, as the developer asks.',
].join('\n');

const INTERVIEW_PREAMBLE = [
  'You are helping a developer describe a new software project: they are being',
  'interviewed about their vision, one question at a time, and their answers',
  'shape the roadmap every later change follows. You revise one answer, as the',
  'developer asks.',
].join('\n');

/** What the agent needs to know about where the answer goes. */
function background(context: AnswerContext): { sections: ContextSection[]; name: string; heading: string; hint: string } {
  if ('interview' in context) {
    const { interview, ask, why } = context;
    return {
      name: ask,
      heading: `The interview question — ${ask}`,
      hint: why ? `What it decides: ${why}` : '(nothing said about what it decides)',
      sections: [
        { heading: 'Their vision, in their words', lines: interview.vision.split('\n'), empty: '(not described)' },
        { heading: 'As understood so far', lines: interview.understood ? interview.understood.split('\n') : [], empty: '(nothing yet)' },
        {
          heading: 'The interview so far',
          lines: interview.turns.map((t) => `Q: ${t.ask}\nA: ${t.answer ?? '(skipped)'}`),
          empty: '(no questions answered yet)',
        },
      ],
    };
  }
  const { question, questions } = context;
  return {
    name: question.item.name,
    heading: `The question — [${question.title}] ${question.item.name}`,
    hint: question.hint ? `Hint shown to the developer: ${question.hint}` : '(no hint)',
    sections: [{
      heading: 'The other ground rules decided so far',
      lines: questions
        .filter((q) => q.answered && q.item.id !== question.item.id)
        .map((q) => `- [${q.title}] ${q.item.name}\n  ${q.item.text.replace(/\n+/g, ' ')}`),
      empty: '(none yet)',
    }],
  };
}

function conversationLines(turns: RefineTurn[]): string[] {
  return turns.flatMap((turn, i) => [
    `[${i + 1}] the developer asked: ${turn.instruction.replace(/\s*\n\s*/g, ' / ')}`,
    `[${i + 1}] you proposed:`,
    ...turn.revised.split('\n').map((l) => `[${i + 1}] | ${l}`),
  ]);
}

export function buildAnswerRefineParts(
  context: AnswerContext,
  current: string,
  turns: RefineTurn[],
  instruction: string,
): PromptParts {
  const where = background(context);
  const sections: ContextSection[] = [
    ...where.sections,
    {
      heading: where.heading,
      lines: [where.hint],
    },
    {
      heading: 'The answer to revise',
      lines: current.split('\n'),
    },
    {
      heading: 'This conversation so far',
      lines: conversationLines(turns),
      empty: '(nothing yet: this is the first request)',
    },
  ];

  const from = turns.length > 0 ? `your latest proposal, [${turns.length}]` : 'the answer to revise';
  const task = [
    `The developer asks you to change the answer to "${where.name}":`,
    '',
    instruction.trim(),
    '',
    `Start from ${from}. Return the whole revised answer in \`answer\`, and in`,
    '`summary` one short sentence saying what you changed.',
  ].join('\n');

  const interview = 'interview' in context;
  const rules = [
    interview
      ? 'The answer is given in the interview exactly as you return it:'
      : 'The answer is written into the ground rules exactly as you return it:',
    '- It answers this one question, completely and concretely for this project,',
    '  in as many lines as it takes. Plain text or Markdown lists.',
    '- No `#` headings (they would split the ground-rules file), no code fence',
    '  around it, and no commentary about what you did — that goes in `summary`.',
    interview
      ? '- It is the developer speaking: first person where natural, their intent.'
      : '- Stay consistent with the other ground rules unless asked to change course.',
    '- Change what the developer asked for and keep the rest.',
  ].join('\n');

  return { preamble: interview ? INTERVIEW_PREAMBLE : GROUND_RULES_PREAMBLE, context: sections, task, rules };
}

/** Strips a code fence the agent put around the whole answer anyway. */
function unfence(text: string): string {
  const fenced = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return fenced ? fenced[1]! : text;
}

/** The agent's answer as text that can go into the section, or an error saying why not. */
export function parseAnswerRefinement(raw: unknown, current: string): Refinement {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const text = typeof record['answer'] === 'string' ? record['answer'] : '';
  const block = normalizeContent(unfence(text))
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
  if (block === '') throw new Error('The agent answered without an answer');
  if (block.split('\n').some((l) => SECTION_HEADER.test(l) || /^#\s/.test(l))) {
    throw new Error('The revision has a heading in it, which would split the ground-rules file');
  }
  const warnings = block === current.trim() ? ['Nothing changed'] : [];
  const summary = typeof record['summary'] === 'string' ? record['summary'].trim() : '';
  return { block, summary, warnings };
}

export class AnswerRefiner {
  constructor(private readonly ask: Ask) {}

  async propose(context: AnswerContext, current: string, turns: RefineTurn[], instruction: string): Promise<Refinement> {
    const parts = buildAnswerRefineParts(context, current, turns, instruction);
    const raw = await this.ask(renderPrompt(parts), ANSWER_REFINE_SCHEMA, { mode: 'think', parts });
    return parseAnswerRefinement(raw, current);
  }
}
