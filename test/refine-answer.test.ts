import { describe, expect, test } from 'bun:test';
import { buildAnswerRefineParts, parseAnswerRefinement } from '../src/core/refine-answer.ts';
import { renderPrompt } from '../src/agent/prompt.ts';
import type { GuidedQuestion } from '../src/core/foundation.ts';

const q = (name: string, text: string, answered: boolean, title = 'Stack'): GuidedQuestion => ({
  item: { id: `x#${name}`, name, text, file: '/f.md', line: 1 } as GuidedQuestion['item'],
  title,
  purpose: '',
  hint: 'e.g. a web framework',
  answered,
  derive: true,
});

describe('revising a ground-rule answer', () => {
  test('the prompt carries the other rules, the answer, the conversation and the instruction', () => {
    const framework = q('Framework, if any.', 'TBD', false);
    const lang = q('Language and runtime.', 'Elixir 1.19', true);
    const prompt = renderPrompt(buildAnswerRefineParts(
      { question: framework, questions: [lang, framework] },
      'Phoenix with LiveView.',
      [{ instruction: 'no UI', revised: 'Phoenix, API only.' }],
      'and name the JSON library',
    ));
    expect(prompt).toContain('- [Stack] Language and runtime.\n  Elixir 1.19');
    expect(prompt).toContain('Phoenix with LiveView.');
    expect(prompt).toContain('[1] the developer asked: no UI');
    expect(prompt).toContain('Start from your latest proposal, [1]');
    expect(prompt).toContain('and name the JSON library');
  });

  test('takes the answer as written, without a fence around it', () => {
    const r = parseAnswerRefinement({ answer: '```\nPhoenix, API only.\n- Jason for JSON\n```', summary: 'Named Jason' }, 'Phoenix.');
    expect(r).toEqual({ block: 'Phoenix, API only.\n- Jason for JSON', summary: 'Named Jason', warnings: [] });
  });

  test('refuses a heading, which would split the ground-rules file, and an empty answer', () => {
    expect(() => parseAnswerRefinement({ answer: 'Phoenix\n## Also', summary: '' }, 'x')).toThrow('heading');
    expect(() => parseAnswerRefinement({ answer: '  ', summary: '' }, 'x')).toThrow('without an answer');
  });

  test('says so when nothing changed', () => {
    expect(parseAnswerRefinement({ answer: 'Phoenix.', summary: '' }, 'Phoenix.').warnings).toEqual(['Nothing changed']);
  });
});
