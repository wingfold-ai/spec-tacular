/**
 * What an architecture style decides, from the table in core/derivations.ts:
 * instant, without a model, and refined by the advisor afterwards.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAdvicePrompt, FoundationAdvisor } from '../src/core/advisor.ts';
import { deriveFromArchitecture, STYLE_DERIVATIONS } from '../src/core/derivations.ts';
import { answerFoundation, guidedQuestions, scaffoldFoundation } from '../src/core/foundation.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-drv-'));
  dirs.push(d);
  scaffoldFoundation(d, { defer: true });
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const find = (r: string, start: string) => guidedQuestions(r).find((q) => q.item.name.startsWith(start))!;

describe('the derivation table', () => {
  test('Clean Architecture: dependencies point inward, and I/O stays outside', () => {
    const r = root();
    const [layers, rules] = deriveFromArchitecture(find(r, 'Architecture style'), 'Clean Architecture');
    expect(layers!.question.test('The layers or modules, and which may depend on which.')).toBe(true);
    expect(layers!.answer).toContain('entities ← use cases ← interface adapters ← frameworks & drivers');
    expect(layers!.answer).toContain('frameworks/infrastructure → adapters → use cases → entities');
    expect(layers!.answer).toContain('an inner layer never imports an outer one');
    expect(layers!.answer).toContain('domain/');
    expect(rules!.question.test('Where business rules live, and what must never leak into them.')).toBe(true);
    expect(rules!.answer).toContain('No I/O there');
    expect(rules!.answer).toContain('dependency inversion');
    expect(layers!.reason).toContain('Clean Architecture');
  });

  test('each common style is recognised by its usual names', () => {
    const r = root();
    const style = find(r, 'Architecture style');
    const named = (answer: string) => deriveFromArchitecture(style, answer)[0]?.reason.split(':')[0];
    expect(named('Hexagonal, so adapters are swappable')).toBe('hexagonal (ports & adapters)');
    expect(named('ports and adapters')).toBe('hexagonal (ports & adapters)');
    expect(named('Clean architecture')).toBe('Clean Architecture');
    expect(named('onion')).toBe('Clean Architecture');
    expect(named('A modular monolith')).toBe('modular monolith');
    expect(named('vertical slices')).toBe('vertical slices');
    expect(named('MVC')).toBe('MVC');
    expect(named('classic three-tier layered')).toBe('layered');
    // The more specific name wins.
    expect(named('clean hexagonal')).toBe('hexagonal (ports & adapters)');
    expect(named('layered MVC')).toBe('MVC');
    expect(STYLE_DERIVATIONS.every((s) => s.layers && s.rules)).toBe(true);
  });

  test('an unknown style, or another question, derives nothing', () => {
    const r = root();
    expect(deriveFromArchitecture(find(r, 'Architecture style'), 'Whatever works')).toEqual([]);
    expect(deriveFromArchitecture(find(r, 'Language'), 'Clean Architecture')).toEqual([]);
  });
});

describe('in the Foundation', () => {
  test('choosing a style proposes the answers it decides, at once and without a model', () => {
    const r = root();
    let asked = 0;
    const advisor = new FoundationAdvisor(r, async () => {
      asked++;
      return {};
    });
    const style = find(r, 'Architecture style');
    answerFoundation(style.item, 'Clean Architecture');
    advisor.presets(style, 'Clean Architecture');

    const meta = advisor.meta();
    const layers = meta[find(r, 'The layers or modules').item.id]!.derived!;
    expect(layers.answer).toContain('Dependencies point inward only');
    expect(layers.table).toBe(true);
    expect(meta[find(r, 'Where business rules live').item.id]!.derived!.answer).toContain('No I/O there');
    expect(asked).toBe(0);
    // Proposed, never written.
    expect(find(r, 'The layers or modules').answered).toBe(false);
  });

  test('the advisor is shown them to refine, and its refinement replaces them', async () => {
    const r = root();
    const prompts: string[] = [];
    const advisor = new FoundationAdvisor(r, async (prompt) => {
      prompts.push(prompt);
      return {
        followUps: [],
        upcoming: [],
        derived: [{
          question: 'The layers or modules, and which may depend on which.',
          answer: 'src/domain ← src/application ← src/adapters ← src/main.ts; inward only.',
          reason: 'Clean Architecture, in this TypeScript project',
        }],
      };
    });
    const style = find(r, 'Architecture style');
    answerFoundation(style.item, 'Clean Architecture');
    advisor.presets(style, 'Clean Architecture');
    await advisor.afterAnswer(find(r, 'Architecture style'), 'Clean Architecture');

    expect(prompts[0]).toContain('Already proposed for open questions (refine each for this project');
    expect(prompts[0]).toContain('- The layers or modules, and which may depend on which.: entities ← use cases');
    const meta = advisor.meta();
    const layers = meta[find(r, 'The layers or modules').item.id]!.derived!;
    expect(layers.answer).toBe('src/domain ← src/application ← src/adapters ← src/main.ts; inward only.');
    expect(layers.table).toBeUndefined();
    // The one it did not refine is kept as the table had it.
    expect(meta[find(r, 'Where business rules live').item.id]!.derived!.table).toBe(true);
  });
});

describe('the domain first', () => {
  test('its answer asks the advisor to propose every question marked for it', () => {
    const r = root();
    const purpose = find(r, 'What the system is for');
    answerFoundation(purpose.item, 'Lets clinic staff book rooms');
    const questions = guidedQuestions(r);
    const prompt = buildAdvicePrompt({
      questions,
      answered: { question: find(r, 'What the system is for'), answer: 'Lets clinic staff book rooms', depth: 0 },
    });
    expect(prompt).toContain('- [Stack] Language and runtime, with versions. (propose)');
    expect(prompt).toContain('- [Architecture] The layers or modules, and which may depend on which. (propose)');
    expect(prompt).toContain('also proposes an answer for every open question marked (propose)');

    // Any other answer asks only for what follows for certain.
    const lang = find(r, 'Language');
    const other = buildAdvicePrompt({ questions, answered: { question: lang, answer: 'Go', depth: 0 } });
    expect(other).not.toContain('marked (propose)');
  });
});
