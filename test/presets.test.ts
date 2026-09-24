import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adviceMode,
  buildAdviceParts,
  buildAdvicePrompt,
  coachMode,
  FoundationAdvisor,
  MAX_DEPTH,
  type Ask,
  type AskOptions,
} from '../src/core/advisor.ts';
import { answerFoundation, foundationDir, guidedQuestions, scaffoldFoundation } from '../src/core/foundation.ts';
import { matchPresets, mergeOptions } from '../src/core/presets.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-presets-'));
  dirs.push(d);
  scaffoldFoundation(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const find = (r: string, start: string) => guidedQuestions(r).find((q) => q.item.name.startsWith(start))!;
const stack = (r: string) => readFileSync(join(foundationDir(r), 'stack.md'), 'utf8');

describe('research or think', () => {
  test('the stack and anything about tooling may search the web', () => {
    const r = root();
    expect(adviceMode({ questions: [], answered: { question: find(r, 'Language'), answer: 'Python', depth: 0 } })).toBe('research');
    expect(adviceMode({ questions: [], upcoming: find(r, 'Framework') })).toBe('research');
    expect(coachMode(find(r, 'Datastore'))).toBe('research');
  });

  test('domain, architecture and conventions think without tools', () => {
    const r = root();
    expect(adviceMode({ questions: [], answered: { question: find(r, 'What the system is for'), answer: 'Booking rooms', depth: 0 } })).toBe('think');
    expect(adviceMode({ questions: [], upcoming: find(r, 'Architecture style') })).toBe('think');
    expect(coachMode(find(r, 'Naming'))).toBe('think');
  });

  test('outside the stack, a question that names tooling still looks things up', () => {
    const r = root();
    const q = { ...find(r, 'Naming'), item: { ...find(r, 'Naming').item, name: 'Which linter enforces naming?' } };
    expect(adviceMode({ questions: [], upcoming: q })).toBe('research');
  });

  test('a stack answer past the depth limit raises no follow-ups, so needs no search', () => {
    const r = root();
    const q = find(r, 'Language');
    expect(adviceMode({ questions: [], answered: { question: q, answer: '3.14', depth: MAX_DEPTH }, upcoming: find(r, 'What the system is for') })).toBe('think');
  });

  test('only research may name versions; thinking is told not to', () => {
    const r = root();
    const questions = guidedQuestions(r);
    const think = buildAdviceParts({ questions, upcoming: find(r, 'Architecture style') }).rules!;
    const research = buildAdviceParts({ questions, upcoming: find(r, 'Framework') }).rules!;
    expect(research).toContain('look it up with');
    expect(think).toContain('never propose a specific version number');
    expect(think).not.toContain('web search');
  });

  test('the advisor asks in the routed mode, with the prompt in parts', async () => {
    const r = root();
    const seen: AskOptions[] = [];
    const ask: Ask = async (_prompt, _schema, options) => {
      seen.push(options ?? {});
      return { followUps: [], upcoming: [], derived: [] };
    };
    const advisor = new FoundationAdvisor(r, ask);
    await advisor.suggest(find(r, 'Architecture style'));
    await advisor.suggest(find(r, 'Framework'));
    expect(seen.map((o) => o.mode)).toEqual(['think', 'research']);
    expect(seen[0]!.parts!.context.map((s) => s.heading)).toEqual(['Decided so far', 'Still open (never ask these again)']);
  });
});

describe('the preset table', () => {
  test('Python: a version question with no options — versions are looked up, not remembered', () => {
    const r = root();
    const { followUps, options } = matchPresets(find(r, 'Language'), 'Python');
    expect(followUps.map((f) => f.ask)).toEqual(['Which Python version?']);
    expect(followUps[0]!.options).toEqual([]);
    const tooling = options.find((o) => o.question.test('Package manager, test runner, linter, formatter.'))!;
    expect(tooling.options[0]!.label).toContain('uv');
    expect(tooling.options.filter((o) => o.recommended)).toHaveLength(1);
  });

  test('an answer that already has its version gets no version question', () => {
    const r = root();
    expect(matchPresets(find(r, 'Language'), 'Python 3.14').followUps).toEqual([]);
    expect(matchPresets(find(r, 'Language'), 'TypeScript on Bun').followUps).toEqual([]);
  });

  test('keyed on the question as well as the answer', () => {
    const r = root();
    expect(matchPresets(find(r, 'What the system is for'), 'A Python tutor').followUps).toEqual([]);
    expect(matchPresets(find(r, 'Datastore'), 'Postgres').followUps[0]!.ask).toContain('migrations');
    expect(matchPresets(find(r, 'Datastore'), 'Postgres, migrations via Alembic').followUps).toEqual([]);
  });

  test('nothing matches, nothing happens', () => {
    const r = root();
    expect(matchPresets(find(r, 'Language'), 'Elixir')).toEqual({ followUps: [], options: [] });
  });
});

describe('presets in the Foundation', () => {
  const quiet: Ask = async () => ({ followUps: [], upcoming: [], derived: [] });

  test('follow-ups go in at once after the answer, marked as presets and left for the advisor', () => {
    const r = root();
    const advisor = new FoundationAdvisor(r, quiet);
    const lang = find(r, 'Language');
    answerFoundation(lang.item, 'Python');
    expect(advisor.presets(lang, 'Python')).toEqual(['Which Python version?']);
    expect(stack(r)).toContain('Python\n\n## Which Python version?\n\nTBD\n\n## Framework');

    const meta = advisor.meta();
    const version = meta[find(r, 'Which Python version?').item.id]!;
    expect(version).toMatchObject({ parent: lang.item.name, depth: 1, preset: true, suggested: false });
    expect(meta[find(r, 'Package manager').item.id]).toMatchObject({ preset: true });
    expect(meta[find(r, 'Framework').item.id]!.options![0]!.label).toBe('FastAPI');
  });

  test('never over options the advisor already gave', () => {
    const r = root();
    const advisor = new FoundationAdvisor(r, async () => ({
      followUps: [],
      upcoming: [{ label: 'Litestar', detail: '', recommended: true }],
      derived: [],
    }));
    return advisor.suggest(find(r, 'Framework')).then(() => {
      const lang = find(r, 'Language');
      answerFoundation(lang.item, 'Python');
      advisor.presets(lang, 'Python');
      expect(advisor.meta()[find(r, 'Framework').item.id]!.options!.map((o) => o.label)).toEqual(['Litestar']);
    });
  });

  test('the advisor then refines the first preset question, and adds its own after the presets', async () => {
    const r = root();
    const prompts: string[] = [];
    const advisor = new FoundationAdvisor(r, async (prompt) => {
      prompts.push(prompt);
      return {
        followUps: [{ ask: 'Which Python implementation?', why: '', options: [] }],
        upcoming: [{ label: '3.14', detail: 'latest stable', recommended: true }],
        derived: [],
      };
    });
    const lang = find(r, 'Language');
    answerFoundation(lang.item, 'Rust');
    advisor.presets(lang, 'Rust');
    await advisor.afterAnswer(lang, 'Rust');

    // The presets stay where the developer expects them; the advisor's own
    // follow-up comes after them.
    const names = guidedQuestions(r).filter((q) => q.title === 'Stack').map((q) => q.item.name);
    expect(names.slice(0, 4)).toEqual([
      'Language and runtime, with versions.',
      'Which Rust edition, and the minimum supported Rust version (MSRV)?',
      'Which async runtime, if any?',
      'Which Python implementation?',
    ]);
    // The first preset question got the advisor's options; the preset mark is gone.
    expect(prompts[0]).toContain('upcoming: options for the next question — [Stack] Which Rust edition');
    const edition = advisor.meta()[find(r, 'Which Rust edition').item.id]!;
    expect(edition.options![0]!.label).toBe('3.14');
    expect(edition.preset).toBeUndefined();
    expect(edition.suggested).toBe(true);
  });

  test('preset options are shown to the advisor to improve on, and kept if it has none', async () => {
    const r = root();
    const prompts: string[] = [];
    const advisor = new FoundationAdvisor(r, async (prompt) => {
      prompts.push(prompt);
      return { followUps: [], upcoming: [], derived: [] };
    });
    const lang = find(r, 'Language');
    answerFoundation(lang.item, 'TypeScript');
    advisor.presets(lang, 'TypeScript');
    const runtime = find(r, 'Which runtime runs it');
    await advisor.suggest(runtime);
    expect(prompts[0]).toContain('Generic options are shown for it already: Node.js (LTS); Bun; Deno.');
    expect(advisor.meta()[runtime.item.id]!.options!.map((o) => o.label)).toEqual(['Node.js (LTS)', 'Bun', 'Deno']);
  });

  test('advice for a question answered while the model thought is dropped', async () => {
    const r = root();
    let release: (v: unknown) => void = () => {};
    const advisor = new FoundationAdvisor(r, () => new Promise((res) => { release = res; }));
    const lang = find(r, 'Language');
    answerFoundation(lang.item, 'TypeScript');
    advisor.presets(lang, 'TypeScript');
    const pending = advisor.afterAnswer(lang, 'TypeScript');

    // The developer picks Bun before the advisor is back.
    const runtime = find(r, 'Which runtime runs it');
    answerFoundation(runtime.item, 'Bun');
    release({
      followUps: [],
      upcoming: [{ label: 'Node.js 24', detail: '', recommended: true }],
      derived: [{ question: runtime.item.name, answer: 'Node.js', reason: 'TypeScript' }],
    });
    await pending;

    expect(stack(r)).toContain('## Which runtime runs it: Node.js, Bun or Deno?\n\nBun');
    const meta = advisor.meta()[find(r, 'Which runtime runs it').item.id]!;
    expect(meta.options!.map((o) => o.label)).toEqual(['Node.js (LTS)', 'Bun', 'Deno']);
    expect(meta.derived).toBeUndefined();
  });

  test('nothing in the table: behaves as before', () => {
    const r = root();
    const advisor = new FoundationAdvisor(r, quiet);
    const lang = find(r, 'Language');
    answerFoundation(lang.item, 'Elixir');
    expect(advisor.presets(lang, 'Elixir')).toEqual([]);
    expect(advisor.meta()).toEqual({});
    expect(buildAdvicePrompt({ questions: guidedQuestions(r) })).not.toContain('Generic options');
  });
});

describe('advice arriving for options on screen', () => {
  const o = (label: string, recommended = false) => ({ label, detail: '', recommended });

  test('nobody chose yet: the new options replace the old', () => {
    expect(mergeOptions([o('a', true), o('b')], [o('x', true)], null)).toEqual([o('x', true)]);
  });

  test('the selected option stays when the new list lacks it, without a second ★', () => {
    expect(mergeOptions([o('a', true), o('b')], [o('x', true), o('y')], 'a')).toEqual([o('a'), o('x', true), o('y')]);
  });

  test('the selected option in the new list: the new list as it came', () => {
    expect(mergeOptions([o('a'), o('B')], [o('b', true)], 'b')).toEqual([o('b', true)]);
  });
});
