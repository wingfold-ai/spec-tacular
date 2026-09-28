import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAdvicePrompt,
  FoundationAdvisor,
  insertFollowUps,
  MAX_DEPTH,
  optionAnswer,
  parseAdvice,
  removeQuestion,
  type Ask,
} from '../src/core/advisor.ts';
import {
  answerFoundation,
  DEFERRED,
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
/** The Stack questions, in order: most of these tests are about them. */
const stackOf = (r: string) => guidedQuestions(r).filter((q) => q.title === 'Stack');

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

  test('keeps one follow-up to ask now at most, whatever the model marked', () => {
    const followUps = parseAdvice({
      followUps: [
        { ask: 'A?', why: '', now: false, options: [] },
        { ask: 'B?', why: '', now: true, options: [] },
        { ask: 'C?', why: '', now: true, options: [] },
      ],
      upcoming: [],
      derived: [],
    }).followUps;
    expect(followUps.map((f) => f.now)).toEqual([false, true, false]);
  });

  test('an option carries its full answer; picking writes it, or the label when there is none', () => {
    const [full, short] = parseAdvice({
      followUps: [],
      upcoming: [
        { label: 'Hexagonal', detail: 'ports and adapters', answer: 'Hexagonal.\n- domain: pure\n- adapters: I/O', recommended: true },
        { label: 'pytest', detail: '', answer: 'pytest', recommended: false },
      ],
      derived: [],
    }).upcoming;
    expect(optionAnswer(full!)).toBe('Hexagonal.\n- domain: pure\n- adapters: I/O');
    expect(short!.answer).toBeUndefined();
    expect(optionAnswer(short!)).toBe('pytest');
  });

  test('caps how much a model can add at once', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ask: `Q${i}?`, why: '', options: [] }));
    expect(parseAdvice({ followUps: many, upcoming: [], derived: [] }).followUps).toHaveLength(3);
  });
});

describe('the prompt', () => {
  test('carries what is decided, what is open, and asks for current versions', () => {
    const r = root();
    const [first] = stackOf(r);
    answerFoundation(first!.item, 'Python');
    const qs = guidedQuestions(r);
    const [lang, framework] = stackOf(r);
    const prompt = buildAdvicePrompt({
      questions: qs,
      answered: { question: lang!, answer: 'Python', depth: 0 },
      upcoming: framework,
    });
    expect(prompt).toContain('- [Stack] Language and runtime, with versions.\n  Python');
    expect(prompt).toContain('Still open (never ask these again):');
    expect(prompt).toContain('- [Stack] Framework, if any');
    expect(prompt).toContain('upcoming: options for the next question — [Stack] Framework');
    expect(prompt).toContain('most recent stable release');
    expect(prompt).toContain('web search');
  });

  test('asks for one follow-up now at most, and full answers in options', () => {
    const r = root();
    const qs = guidedQuestions(r);
    const prompt = buildAdvicePrompt({ questions: qs, answered: { question: qs[0]!, answer: 'A shop', depth: 0 } });
    expect(prompt).toContain('mark now: true on at most ONE follow-up');
    expect(prompt).toContain('recorded for later');
    expect(prompt).toContain('the complete answer as it would be written');
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
  test('one needed now is inserted straight after its parent, left TBD to be asked', () => {
    const r = root();
    const [lang] = stackOf(r);
    answerFoundation(lang!.item, 'Python');
    const added = insertFollowUps(
      stackOf(r)[0]!,
      [{ ask: 'Which Python version?', why: '', options: [], now: true }],
      guidedQuestions(r),
    );
    expect(added).toHaveLength(1);
    expect(stack(r)).toContain(
      '## Language and runtime, with versions.\n\nPython\n\n## Which Python version?\n\nTBD\n\n## Framework',
    );
    expect(stackOf(r)[1]!.item.name).toBe('Which Python version?');
  });

  test('the rest are recorded for later: in the file, not asked', () => {
    const r = root();
    const before = guidedQuestions(r).map((q) => q.item.name);
    insertFollowUps(stackOf(r)[0]!, [{ ask: 'Which linter rules?', why: '', options: [] }], guidedQuestions(r));
    expect(stack(r)).toContain(`## Which linter rules?\n\n${DEFERRED}`);
    expect(guidedQuestions(r).map((q) => q.item.name)).toEqual(before);
    // Recorded once: the same question later is not added twice.
    expect(insertFollowUps(stackOf(r)[0]!, [{ ask: 'Which linter rules?', why: '', options: [], now: true }], guidedQuestions(r))).toEqual([]);
  });

  test('never duplicate a question that already exists', () => {
    const r = root();
    const qs = guidedQuestions(r);
    const added = insertFollowUps(stackOf(r)[0]!, [
      { ask: 'Package manager, test runner, linter, formatter.', why: '', options: [] },
      { ask: 'Which version?', why: '', options: [] },
      { ask: 'Which version?', why: '', options: [] },
    ], qs);
    expect(added.map((f) => f.ask)).toEqual(['Which version?']);
  });

  test('can be removed again, leaving the rest intact', () => {
    const r = root();
    const qs = guidedQuestions(r);
    insertFollowUps(stackOf(r)[0]!, [{ ask: 'Which version?', why: '', options: [], now: true }], qs);
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

  test('after an answer: asks the one follow-up needed now, records the rest, and advises the next question', async () => {
    const r = root();
    const { ask } = scripted([{
      followUps: [
        { ask: 'Which Python version?', why: 'CI pins it.', now: true, options: [{ label: '3.14', detail: '', recommended: true }] },
        { ask: 'Which docstring style?', why: '', now: false, options: [] },
      ],
      upcoming: [{ label: 'FastAPI', detail: '', recommended: true }],
    }]);
    const advisor = new FoundationAdvisor(r, ask);
    const [lang] = stackOf(r);
    answerFoundation(lang!.item, 'Python');

    const { added, recorded } = await advisor.afterAnswer(lang!, 'Python');
    expect(added.map((f) => f.ask)).toEqual(['Which Python version?']);
    expect(recorded.map((f) => f.ask)).toEqual(['Which docstring style?']);
    expect(guidedQuestions(r).some((q) => q.item.name === 'Which docstring style?')).toBe(false);
    expect(stack(r)).toContain(`## Which docstring style?\n\n${DEFERRED}`);

    const meta = advisor.meta();
    const follow = Object.entries(meta).find(([id]) => id.endsWith('#which-python-version'))![1];
    expect(follow).toMatchObject({ parent: lang!.item.name, why: 'CI pins it.', depth: 1 });
    expect(follow.options![0]!.label).toBe('3.14');
    // The next question — Framework — was advised in the same request.
    const framework = guidedQuestions(r).find((q) => q.item.name.startsWith('Framework'))!;
    expect(meta[framework.item.id]!.options![0]!.label).toBe('FastAPI');
  });

  test('a follow-up asked now raises no follow-ups of its own', async () => {
    const r = root();
    const { ask } = scripted([
      { followUps: [{ ask: 'L1?', why: '', now: true, options: [] }], upcoming: [] },
      { followUps: [{ ask: 'L2?', why: '', now: true, options: [] }], upcoming: [] },
    ]);
    const advisor = new FoundationAdvisor(r, ask);
    const find = (name: string) => guidedQuestions(r).find((q) => q.item.name === name)!;

    expect((await advisor.afterAnswer(stackOf(r)[0]!, 'Python')).added.map((f) => f.ask)).toEqual(['L1?']);
    expect((await advisor.afterAnswer(find('L1?'), 'x')).added).toEqual([]);
    expect(stack(r)).not.toContain('L2?');
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
  const withEnv = (vars: Record<string, string | undefined>, run: () => void) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    try {
      for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      run();
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  };

  test('claude is asked for schema-shaped JSON, with web search, MCP and nothing else', () => {
    withEnv({ SPECTACULAR_NO_MCP: undefined }, () => {
      const { command, args } = claudeDriver.structured!.build({ prompt: 'P', cwd: '/', schema: { type: 'object' } });
      expect(command).toBe('claude');
      expect(args).toContain('--json-schema');
      // Built-in tools: web search for the advisor, and ToolSearch to load the deferred MCP tools.
      expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch,ToolSearch');
      const quick = claudeDriver.structured!.build({ prompt: 'P', cwd: '/', schema: {}, mode: 'quick' }).args;
      expect(quick[quick.indexOf('--tools') + 1]).toBe('ToolSearch');
      // The developer's servers load, and a hook approves their tools.
      expect(args).not.toContain('--strict-mcp-config');
      const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
      expect(settings.hooks.PreToolUse[0].matcher).toBe('mcp__.*');
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('allow-mcp.mjs');
    });
  });

  test('SPECTACULAR_NO_MCP starts no MCP servers, as before', () => {
    withEnv({ SPECTACULAR_NO_MCP: '1' }, () => {
      const args = claudeDriver.structured!.build({ prompt: 'P', cwd: '/', schema: {} }).args;
      expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch');
      expect(args).toContain('--strict-mcp-config');
      expect(args).not.toContain('--settings');
      const quick = claudeDriver.structured!.build({ prompt: 'P', cwd: '/', schema: {}, mode: 'quick' }).args;
      expect(quick[quick.indexOf('--tools') + 1]).toBe('');
    });
  });

  test('artifact jobs load MCP too', () => {
    withEnv({ SPECTACULAR_NO_MCP: undefined }, () => {
      const { args } = claudeDriver.build({ prompt: 'P', cwd: '/' } as Parameters<typeof claudeDriver.build>[0]);
      expect(args).toContain('--settings');
      expect(args).not.toContain('--strict-mcp-config');
    });
  });

  describe('the MCP allow hook', () => {
    const hook = join(import.meta.dir, '..', 'src', 'agent', 'allow-mcp.mjs');
    const decide = (tool: string, deny = '') => {
      const out = Bun.spawnSync([process.execPath, hook], {
        stdin: Buffer.from(JSON.stringify({ tool_name: tool })),
        env: { ...process.env, SPECTACULAR_MCP_DENY: deny },
      }).stdout.toString();
      return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : null;
    };

    test('allows MCP tools', () => {
      expect(decide('mcp__claude_ai_my_second_brain__list_projects')).toBe('allow');
    });
    test('leaves built-in tools to the normal rules', () => {
      expect(decide('Bash')).toBeNull();
      expect(decide('WebSearch')).toBeNull();
    });
    test('leaves out the servers SPECTACULAR_MCP_DENY names', () => {
      expect(decide('mcp__claude_ai_GoDaddy__buy_domain', 'godaddy, google_drive')).toBeNull();
      expect(decide('mcp__claude_ai_Google_Drive__delete', 'godaddy, google_drive')).toBeNull();
      expect(decide('mcp__claude_ai_Context7__query', 'godaddy, google_drive')).toBe('allow');
    });
  });

  test("claude runs on Claude Code's own model unless one is set", () => {
    const keys = ['SPECTACULAR_ADVISOR_MODEL', 'SPECTACULAR_QUICK_MODEL'] as const;
    const saved = keys.map((k) => process.env[k]);
    const build = (mode?: 'quick') => claudeDriver.structured!.build({ prompt: 'P', cwd: '/', schema: {}, mode }).args;
    try {
      for (const k of keys) delete process.env[k];
      expect(build()).not.toContain('--model');
      expect(build('quick')).not.toContain('--model');
      expect(claudeDriver.model?.('research')).toBeUndefined();

      process.env['SPECTACULAR_ADVISOR_MODEL'] = 'sonnet';
      process.env['SPECTACULAR_QUICK_MODEL'] = 'haiku';
      const args = build();
      const quick = build('quick');
      expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
      expect(quick[quick.indexOf('--model') + 1]).toBe('haiku');
      expect(claudeDriver.model?.('quick')).toBe('haiku');
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });

  test('claude answers without extended thinking unless asked to', () => {
    const saved = process.env['SPECTACULAR_ADVISOR_THINKING'];
    try {
      delete process.env['SPECTACULAR_ADVISOR_THINKING'];
      expect(claudeDriver.structured!.build({ prompt: 'P', cwd: '/', schema: {} }).env).toEqual({ MAX_THINKING_TOKENS: '0' });
      process.env['SPECTACULAR_ADVISOR_THINKING'] = '1';
      expect(claudeDriver.structured!.build({ prompt: 'P', cwd: '/', schema: {} }).env).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env['SPECTACULAR_ADVISOR_THINKING'];
      else process.env['SPECTACULAR_ADVISOR_THINKING'] = saved;
    }
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
