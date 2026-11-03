/**
 * The questions a formal form forced, put to the developer.
 *
 * Writing a requirement as a formula makes every condition explicit, and
 * each one the brief left open has to be answered to write it: does an
 * empty participant list mean everyone? The drafting agent records those as
 * `asked:` lines. Left there, the agent has decided a product question and
 * the formula only shows that it did — an evaluation run shipped exactly
 * that, an empty list splitting among everyone. So each `asked:` line is its
 * own review item, before its requirement: the agent's answer is a
 * proposal until the developer accepts it, or gives another one.
 */

import { formalOf } from './formal/formal.ts';
import { hashBlock, isRequirement, type ReviewItem } from './requirements.ts';

export const QUESTION_CAPABILITY = 'questions';

export interface Question extends ReviewItem {
  /** The requirement whose formal form asked it. */
  parent: string;
  /** Its name, as the card shows it. */
  parentName: string;
  question: string;
  /** What the agent answered, proposed for the developer to accept. */
  answer: string;
}

export function isQuestion(item: ReviewItem): item is Question {
  return item.capability === QUESTION_CAPABILITY;
}

/** `Question? — Answer.`: the dash the instruction asks for, or a plain one. */
function split(line: string): { question: string; answer: string } {
  const m = /^(.*?\?)\s*(?:—|–|-{1,2})\s*(.*)$/.exec(line.trim()) ?? /^(.*?)\s+(?:—|–)\s+(.*)$/.exec(line.trim());
  return m ? { question: m[1]!.trim(), answer: m[2]!.trim() } : { question: line.trim(), answer: '' };
}

/** The questions a requirement's formal form records, each a review item. */
export function questionsOf(item: ReviewItem): Question[] {
  if (!isRequirement(item)) return [];
  const form = formalOf(item);
  if (!form) return [];
  const lines = item.text.split('\n');
  return form.asked.map((line, i) => {
    const { question, answer } = split(line);
    const at = lines.findIndex((l) => l.includes(line.slice(0, 40)));
    return {
      id: `${QUESTION_CAPABILITY}#${item.id.replace('#', '--')}--${i + 1}`,
      capability: QUESTION_CAPABILITY,
      name: question,
      text: [
        `Asked while formalizing "${item.name}".`,
        '',
        `Proposed answer: ${answer || '(none given)'}`,
      ].join('\n'),
      file: item.file,
      // The header, plus the lines before the asked line within its text.
      line: item.line + 1 + (at >= 0 ? at : 0),
      // Its own words: a changed answer, or question, is asked again.
      hash: hashBlock(`${question}\n${answer}`),
      parent: item.id,
      parentName: item.name,
      question,
      answer,
    };
  });
}

/** The queue with each requirement's questions right before it. */
export function withQuestions(items: ReviewItem[]): ReviewItem[] {
  return items.flatMap((item) => [...questionsOf(item), item]);
}
