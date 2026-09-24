import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAdvicePrompt,
  FoundationAdvisor,
  insertFollowUps,
  MAX_DEPTH,
  parseAdvice,
  removeQuestion,
  type Ask,
} from '../src/core/advisor.ts';
import {
  answerFoundation,
  foundationDir,
  guidedQuestions,
  scaffoldFoundation,
} from '../src/core/foundation.ts';
import { claudeDriver } from '../src/agent/claude.ts';
import { opencodeDriver } from '../src/agent/opencode.ts';
import { advisorUnavailable, runStructured } from '../src/agent/structured.ts';
import type { AgentDriver } from '../src/agent/driver.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-adv-'));
  dirs.push(d);
  scaffoldFoundation(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const stack = (r: string) => readFileSync(join(foundationDir(r), 'stack.md'), 'utf8');

describe('parsing what the model sent', () => {
  test('keeps exactly one recommendation, whatever arrived', () => {
    const none = parseAdvice({ followUps: [], upcoming: [{ label: 'a', detail: '' }, { label: 'b', detail: '' }] });
    expect(none.upcoming.map((o) => o.recommended)).toEqual([true, false]);

    const many = parseAdvice({
      followUps: [],
      upcoming: [
        { label: 'a', detail: '', recommended: false },
        { label: 'b', detail: '', recommended: true },
        { label: 'c', detail: '', recommended: true },
      ],
    });
    expect(many.upcoming.map((o) => o.recommended)).toEqual([false, true, false]);
  });

  test('anything malformed is no advice, not an error', () => {
    const empty = { followUps: [], upcoming: [], derived: [] };
    expect(parseAdvice(null)).toEqual(empty);
    expect(parseAdvice('nope')).toEqual(empty);
    expect(parseAdvice({ followUps: [{ ask: '' }, 7], upcoming: [{ label: '' }], derived: [{ question: 'x' }] })).toEqual(empty);
  });

  test('caps how much a model can add at once', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ask: `Q${i}?`, why: '', options: [] }));
    expect(parseAdvice({ followUps: many, upcoming: [], derived: [] }).followUps).toHaveLength(3);
  });
});

describe('the prompt', () => {
  test('carries what is decided, what is open, and asks for current versions', () => {
    const r = root();
    const [first] = guidedQuestions(r);
    answerFoundation(first!.item, 'Python');
    const qs = guidedQuestions(r);
    const prompt = buildAdvicePrompt({
      questions: qs,
      answered: { question: qs[0]!, answer: 'Python', depth: 0 },
      upcoming: qs[1],
    });
    expect(prompt).toContain('- [Stack] Language and runtime, with versions.\n  Python');
    expect(prompt).toContain('Still open (never ask these again):');
    expect(prompt).toContain('- [Stack] Framework, if any');
    expect(prompt).toContain('upcoming: options for the next question — [Stack] Framework');
    expect(prompt).toContain('most recent stable release');
    expect(prompt).toContain('web search');
  });

  test('stops asking for follow-ups at the depth limit', () => {
    const r = root();
    const qs = guidedQuestions(r);
    const prompt = buildAdvicePrompt({
      questions: qs,
      answered: { question: qs[0]!, answer: '3.14', depth: MAX_DEPTH },
    });
    expect(prompt).toContain('followUps: return an empty list');
  });
});

describe('follow-ups in the files', () => {
  test('are inserted straight after their parent, left TBD', () => {
    const r = root();
    const [lang] = guidedQuestions(r);
    answerFoundation(lang!.item, 'Python');
    const added = insertFollowUps(
      guidedQuestions(r)[0]!,
      [{ ask: 'Which Python version?', why: '', options: [] }],
      guidedQuestions(r),
    );
    expect(added).toHaveLength(1);
    expect(stack(r)).toContain(
      '## Language and runtime, with versions.\n\nPython\n\n## Which Python version?\n\nTBD\n\n## Framework',
    );
    expect(guidedQuestions(r)[1]!.item.name).toBe('Which Python version?');
  });

  test('never duplicate a question that already exists', () => {
    const r = root();
    const qs = guidedQuestions(r);
    const added = insertFollowUps(qs[0]!, [
      { ask: 'Package manager, test runner, linter, formatter.', why: '', options: [] },
      { ask: 'Which version?', why: '', options: [] },
      { ask: 'Which version?', why: '', options: [] },
    ], qs);
    expect(added.map((f) => f.ask)).toEqual(['Which version?']);
  });

  test('can be removed again, leaving the rest intact', () => {
    const r = root();
    const qs = guidedQuestions(r);
    insertFollowUps(qs[0]!, [{ ask: 'Which version?', why: '', options: [] }], qs);
    const follow = guidedQuestions(r).find((q) => q.item.name === 'Which version?')!;
    expect(removeQuestion(follow)).toBe(true);
    expect(stack(r)).not.toContain('Which version?');
    expect(guidedQuestions(r).map((q) => q.item.name)).toEqual(qs.map((q) => q.item.name));
  });
});

describe('the advisor', () => {
  const scripted = (answers: unknown[]): { ask: Ask; prompts: string[] } => {
    const prompts: string[] = [];
    return {
      prompts,
      ask: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? { followUps: [], upcoming: [] };
      },
    };
  };

  test('after an answer: adds follow-ups with their options, and advises the next question', async () => {
    const r = root();
    const { ask } = scripted([{
      followUps: [{ ask: 'Which Python version?', why: 'CI pins it.', options: [{ label: '3.14', detail: '', recommended: true }] }],
      upcoming: [{ label: 'FastAPI', detail: '', recommended: true }],
    }]);
    const advisor = new FoundationAdvisor(r, ask);
    const [lang] = guidedQuestions(r);
    answerFoundation(lang!.item, 'Python');

    const { added } = await advisor.afterAnswer(lang!, 'Python');
    expect(added.map((f) => f.ask)).toEqual(['Which Python version?']);

    const meta = advisor.meta();
    const follow = Object.entries(meta).find(([id]) => id.endsWith('#which-python-version'))![1];
    expect(follow).toMatchObject({ parent: lang!.item.name, why: 'CI pins it.', depth: 1 });
    expect(follow.options![0]!.label).toBe('3.14');
    // The next question — Framework — was advised in the same request.
    const framework = guidedQuestions(r).find((q) => q.item.name.startsWith('Framework'))!;
    expect(meta[framework.item.id]!.options![0]!.label).toBe('FastAPI');
  });

  test('a follow-up of a follow-up of a follow-up is never added', async () => {
    const r = root();
    const { ask } = scripted([
      { followUps: [{ ask: 'L1?', why: '', options: [] }], upcoming: [] },
      { followUps: [{ ask: 'L2?', why: '', options: [] }], upcoming: [] },
      { followUps: [{ ask: 'L3?', why: '', options: [] }], upcoming: [] },
    ]);
    const advisor = new FoundationAdvisor(r, ask);
    const find = (name: string) => guidedQuestions(r).find((q) => q.item.name === name)!;

    await advisor.afterAnswer(guidedQuestions(r)[0]!, 'Python');
    await advisor.afterAnswer(find('L1?'), 'x');
    expect((await advisor.afterAnswer(find('L2?'), 'y')).added).toEqual([]);
    expect(stack(r)).not.toContain('L3?');
  });

  test('suggest asks once per question, even when nothing came back', async () => {
    const r = root();
    const { ask, prompts } = scripted([]);
    const advisor = new FoundationAdvisor(r, ask);
    const q = guidedQuestions(r)[0]!;
    await advisor.suggest(q);
    await advisor.suggest(q);
    expect(prompts).toHaveLength(1);
  });
});

describe('deriving later answers', () => {
  test('an answer that follows from earlier ones is proposed, never written', async () => {
    const r = root();
    const advisor = new FoundationAdvisor(r, async () => ({
      followUps: [],
      upcoming: [],
      derived: [
        { question: '[Architecture] Where business rules live, and what must never leak into them.', answer: 'In domain/', reason: 'Clean architecture' },
        { question: 'A question nobody asked', answer: 'x', reason: 'y' },
      ],
    }));
    const arch = guidedQuestions(r).find((q) => q.item.name.startsWith('Architecture style'))!;
    answerFoundation(arch.item, 'Clean architecture');
    const { derived } = await advisor.afterAnswer(arch, 'Clean architecture');

    expect(derived).toEqual(['Where business rules live, and what must never leak into them.']);
    const target = guidedQuestions(r).find((q) => q.item.name.startsWith('Where business rules'))!;
    expect(advisor.meta()[target.item.id]!.derived).toEqual({ answer: 'In domain/', reason: 'Clean architecture' });
    // Proposed only: the file still holds the open question.
    expect(target.answered).toBe(false);
  });
});

describe('help when the developer is not sure', () => {
  test('explains, gives examples, and puts simpler questions before it', async () => {
    const r = root();
    const prompts: string[] = [];
    const advisor = new FoundationAdvisor(r, async (prompt) => {
      prompts.push(prompt);
      return {
        explain: 'Where your data lives between runs.',
        examples: [{ label: 'SQLite', detail: 'one file', recommended: true }],
        probes: [{ ask: 'Will several people use it at the same time?', why: '', options: [] }],
      };
    });
    const store = guidedQuestions(r).find((q) => q.item.name.startsWith('Datastore'))!;
    const { probes } = await advisor.coach(store);

    expect(prompts[0]).toContain('does not know how to answer — [Stack] Datastore');
    expect(probes.map((p) => p.ask)).toEqual(['Will several people use it at the same time?']);
    const names = guidedQuestions(r).map((q) => q.item.name);
    expect(names.indexOf('Will several people use it at the same time?')).toBe(names.indexOf(store.item.name) - 1);

    const meta = advisor.meta();
    expect(meta[store.item.id]).toMatchObject({ explain: 'Where your data lives between runs.' });
    expect(meta[store.item.id]!.options![0]!.label).toBe('SQLite');
    const probe = guidedQuestions(r).find((q) => q.item.name.startsWith('Will several'))!;
    expect(meta[probe.item.id]!.helps).toBe(store.item.name);
  });
});

describe('reaching the model', () => {
  test('claude is asked for schema-shaped JSON, with web search and nothing else', () => {
    const { command, args } = claudeDriver.structured!.build({ prompt: 'P', cwd: '/', schema: { type: 'object' } });
    expect(command).toBe('claude');
    const quick = claudeDriver.structured!.build({ prompt: 'P', cwd: '/', schema: {}, mode: 'quick' }).args;
    expect(quick[quick.indexOf('--model') + 1]).toBe('haiku');
    expect(quick[quick.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--json-schema');
    expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch');
    expect(args).toContain('--strict-mcp-config');
  });

  test('claude’s structured output is unwrapped, and its errors surface', () => {
    const parse = claudeDriver.structured!.parse;
    expect(parse(JSON.stringify({ structured_output: { a: 1 } }))).toEqual({ a: 1 });
    expect(() => parse(JSON.stringify({ is_error: true, result: 'no credit' }))).toThrow('no credit');
  });

  test('a driver without structured output cannot advise', () => {
    const plain: AgentDriver = { ...opencodeDriver, structured: undefined };
    expect(advisorUnavailable(plain)).toContain('cannot answer structured requests');
  });

  test('runs the command and parses its stdout', async () => {
    const d = mkdtempSync(join(tmpdir(), 'spectacular-run-'));
    dirs.push(d);
    const script = join(d, 'fake-agent');
    writeFileSync(script, '#!/bin/sh\necho \'{"structured_output":{"followUps":[],"upcoming":[]}}\'\n');
    chmodSync(script, 0o755);
    const fake: AgentDriver = {
      id: 'fake', label: 'Fake', build: () => ({ command: script, args: [] }), formatLine: (l) => l,
      structured: {
        build: () => ({ command: script, args: [] }),
        parse: (out) => (JSON.parse(out) as { structured_output: unknown }).structured_output,
      },
    };
    expect(advisorUnavailable(fake)).toBeNull();
    expect(await runStructured(fake, d, 'p', {})).toEqual({ followUps: [], upcoming: [] });
  });
});
