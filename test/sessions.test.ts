/**
 * Long-running agent sessions: the stream-json protocol against a fake agent,
 * the pool's restarts, fallback and one-at-a-time rule, and opencode's HTTP
 * API against a fake server. No real agent is started.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { StreamJsonSession } from '../src/agent/claude.ts';
import { liveChildren } from '../src/agent/children.ts';
import {
  SessionError,
  SessionTimeoutError,
  type AgentDriver,
  type StructuredMode,
  type StructuredSession,
} from '../src/agent/driver.ts';
import { extractJson, MalformedOutputError, shapeError } from '../src/agent/json.ts';
import { OpencodeServer, OpencodeSession, opencodeDriver, opencodeModel, readReply } from '../src/agent/opencode.ts';
import { renderDelta, renderPrompt, type PromptParts } from '../src/agent/prompt.ts';
import { runStructured, StructuredPool } from '../src/agent/structured.ts';

const FAKE_AGENT = join(import.meta.dir, 'support', 'fake-stream-agent.ts');
const FAKE_OPENCODE = join(import.meta.dir, 'support', 'fake-opencode.ts');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type Echo = { text: string; turn: number; pid: number; args: string[] };

const fakeSession = (extra: string[] = []) => {
  const session = new StreamJsonSession({ command: process.execPath, args: [FAKE_AGENT, ...extra] }, process.cwd(), 'Fake');
  cleanups.push(() => session.close());
  return session;
};

describe('a stream-json session', () => {
  test('answers message after message from one process', async () => {
    const session = fakeSession();
    const first = (await session.send('hello', { timeoutMs: 5000 })) as Echo;
    const second = (await session.send('again', { timeoutMs: 5000 })) as Echo;
    expect(first).toMatchObject({ text: 'hello', turn: 1 });
    expect(second).toMatchObject({ text: 'again', turn: 2 });
    expect(second.pid).toBe(first.pid);
    expect(session.alive).toBe(true);
  });

  test('a model error fails that request, and the session lives on', async () => {
    const session = fakeSession();
    await expect(session.send('FAIL', { timeoutMs: 5000 })).rejects.toThrow('model said no');
    expect(session.alive).toBe(true);
    expect(((await session.send('ok', { timeoutMs: 5000 })) as Echo).turn).toBe(2);
  });

  test('a process that dies fails the request as a session error, with its last words', async () => {
    const session = fakeSession();
    const err = await session.send('DIE', { timeoutMs: 5000 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as Error).message).toContain('told to die');
    expect(session.alive).toBe(false);
  });

  test('a request that takes too long ends the session', async () => {
    const session = fakeSession();
    const err = await session.send('HANG', { timeoutMs: 300 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SessionTimeoutError);
    expect(session.alive).toBe(false);
  });

  test('closing it stops the process', async () => {
    const session = fakeSession();
    const { pid } = (await session.send('hi', { timeoutMs: 5000 })) as Echo;
    expect(liveChildren()).toBeGreaterThan(0);
    session.close();
    await Bun.sleep(300);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe('when spec-tacular is stopped', () => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    test(`${signal} takes its agent sessions with it`, async () => {
      const holder = Bun.spawn([process.execPath, join(import.meta.dir, 'support', 'session-holder.ts')], { stdout: 'pipe' });
      const reader = holder.stdout.getReader();
      const { value } = await reader.read();
      const pid = Number(new TextDecoder().decode(value).trim());
      expect(() => process.kill(pid, 0)).not.toThrow();
      holder.kill(signal);
      await holder.exited;
      await Bun.sleep(300);
      expect(() => process.kill(pid, 0)).toThrow();
    });
  }
});

// ---------------------------------------------------------------------------

/** A driver whose sessions are the fake agent, counting what it starts. */
const fakeDriver = (options: { sessions?: boolean; args?: string[] } = {}) => {
  const started: { mode: StructuredMode; session: StreamJsonSession }[] = [];
  const driver: AgentDriver = {
    id: 'fake',
    label: 'Fake',
    build: () => ({ command: 'true', args: [] }),
    formatLine: (l) => l,
    structured: {
      build: () => ({ command: 'true', args: [] }),
      parse: () => ({}),
      ...(options.sessions === false
        ? {}
        : {
            session: ({ mode }: { mode: StructuredMode }): StructuredSession => {
              const session = new StreamJsonSession({ command: process.execPath, args: [FAKE_AGENT, mode, ...(options.args ?? [])] }, process.cwd(), 'Fake');
              started.push({ mode, session });
              return session;
            },
          }),
    },
  };
  return { driver, started };
};

const parts = (decided: string[], task: string): PromptParts => ({
  preamble: 'You help.',
  context: [{ heading: 'Decided', lines: decided, empty: '(nothing)' }],
  task,
});

describe('the session pool', () => {
  const pool = (driver: AgentDriver, oneShot?: (prompt: string) => Promise<unknown>) => {
    const p = new StructuredPool(driver, process.cwd(), {
      oneShot: oneShot ? (prompt) => oneShot(prompt) : undefined,
    });
    cleanups.push(() => p.close());
    return p;
  };

  test('sends the whole context once, then only what changed', async () => {
    const { driver, started } = fakeDriver();
    const p = pool(driver);
    const first = parts(['- language: Python'], 'Advise on the language.');
    const one = (await p.ask(renderPrompt(first), {}, { mode: 'think', parts: first })) as Echo;
    expect(one.text).toContain('You help.');
    expect(one.text).toContain('- language: Python');

    const second = parts(['- language: Python', '- version: 3.14'], 'Advise on the version.');
    const two = (await p.ask(renderPrompt(second), {}, { mode: 'think', parts: second })) as Echo;
    expect(two.pid).toBe(one.pid);
    expect(two.text).not.toContain('You help.');
    expect(two.text).not.toContain('- language: Python');
    expect(two.text).toContain('Decided — now also:\n- version: 3.14');
    expect(two.text).toContain('Advise on the version.');
    expect(started).toHaveLength(1);
  });

  test('one session per mode, since tools and model are fixed when it starts', async () => {
    const { driver, started } = fakeDriver();
    const p = pool(driver);
    const research = (await p.ask('a', {}, { mode: 'research' })) as Echo;
    const think = (await p.ask('b', {}, { mode: 'think' })) as Echo;
    expect(research.args).toEqual(['research']);
    expect(think.args).toEqual(['think']);
    expect(research.pid).not.toBe(think.pid);
    expect(started.map((s) => s.mode)).toEqual(['research', 'think']);
  });

  test('warming starts the process before the first question', async () => {
    const { driver, started } = fakeDriver();
    const p = pool(driver);
    p.warm({}, 'think');
    expect(started).toHaveLength(1);
    await p.ask('x', {}, { mode: 'think' });
    expect(started).toHaveLength(1);
  });

  test('requests to one session go one at a time, in order', async () => {
    const { driver } = fakeDriver();
    const p = pool(driver);
    const answers = (await Promise.all(['one', 'two', 'three'].map((t) => p.ask(t, {}, { mode: 'think' })))) as Echo[];
    expect(answers.map((a) => [a.text, a.turn])).toEqual([['one', 1], ['two', 2], ['three', 3]]);
  });

  test('a session that dies is restarted and sent the whole context again', async () => {
    const { driver, started } = fakeDriver();
    const p = pool(driver);
    const first = parts(['- a'], 'first');
    await p.ask(renderPrompt(first), {}, { mode: 'think', parts: first });
    started[0]!.session.close(); // dies between questions

    const next = parts(['- a', '- b'], 'second');
    const answer = (await p.ask(renderPrompt(next), {}, { mode: 'think', parts: next })) as Echo;
    expect(started).toHaveLength(2);
    expect(answer.text).toContain('You help.');
    expect(answer.text).toContain('- a\n- b');
  });

  test('a request that fails mid-conversation is retried once on a fresh session, whole', async () => {
    // Each fake process dies on its second message.
    const { driver, started } = fakeDriver({ args: ['--die-on-turn-2'] });
    let oneShots = 0;
    const p = pool(driver, async () => {
      oneShots++;
      return {};
    });
    const first = parts(['- a'], 'first');
    await p.ask(renderPrompt(first), {}, { mode: 'think', parts: first });
    const next = parts(['- a', '- b'], 'second');
    const answer = (await p.ask(renderPrompt(next), {}, { mode: 'think', parts: next })) as Echo;
    expect(started).toHaveLength(2);
    expect(answer.turn).toBe(1);
    expect(answer.text).toContain('You help.');
    expect(answer.text).toContain('- a\n- b');
    expect(oneShots).toBe(0);
  });

  test('when no session can be had, the one-shot path answers', async () => {
    const { driver } = fakeDriver();
    const oneShots: string[] = [];
    const p = pool(driver, async (prompt) => {
      oneShots.push(prompt);
      return { from: 'one-shot' };
    });
    expect(await p.ask('DIE please', {}, { mode: 'think' })).toEqual({ from: 'one-shot' });
    expect(oneShots).toEqual(['DIE please']);
  });

  test('a model error is not papered over with a one-shot request', async () => {
    const { driver } = fakeDriver();
    let oneShots = 0;
    const p = pool(driver, async () => {
      oneShots++;
      return {};
    });
    await expect(p.ask('FAIL', {}, { mode: 'think' })).rejects.toThrow('model said no');
    expect(oneShots).toBe(0);
  });

  test('a timeout is final: no retry, and the next request gets a fresh session', async () => {
    const { driver, started } = fakeDriver();
    let oneShots = 0;
    const p = pool(driver, async () => {
      oneShots++;
      return {};
    });
    await expect(p.ask('HANG', {}, { mode: 'think', timeoutMs: 300 })).rejects.toBeInstanceOf(SessionTimeoutError);
    expect(started).toHaveLength(1);
    expect(oneShots).toBe(0);
    expect(((await p.ask('ok', {}, { mode: 'think' })) as Echo).turn).toBe(1);
    expect(started).toHaveLength(2);
  });

  test('a driver without sessions goes one-shot', async () => {
    const { driver } = fakeDriver({ sessions: false });
    const p = pool(driver, async (prompt) => ({ prompt }));
    expect(await p.ask('hi', {}, { mode: 'quick' })).toEqual({ prompt: 'hi' });
  });

  test('closing ends every session', async () => {
    const { driver, started } = fakeDriver();
    const p = new StructuredPool(driver, process.cwd());
    await p.ask('a', {}, { mode: 'think' });
    await p.ask('b', {}, { mode: 'research' });
    await p.close();
    expect(started.every((s) => !s.session.alive)).toBe(true);
  });
});

describe('prompts in parts', () => {
  test('the whole prompt reads like one written by hand', () => {
    expect(renderPrompt({ ...parts([], 'Do it.'), rules: 'Be brief.' })).toBe(
      'You help.\n\nDecided:\n(nothing)\n\nDo it.\n\nBe brief.',
    );
  });

  test('a delta lists what was added and what went away', () => {
    const delta = renderDelta(
      [{ heading: 'Decided', lines: ['- a', '- b'] }],
      parts(['- a', '- c'], 'Next.'),
    );
    expect(delta).toContain('Decided — now also:\n- c');
    expect(delta).toContain('Decided — no longer:\n- b');
    expect(delta).toContain('Next.');
    expect(delta).not.toContain('You help.');
  });

  test('a delta with nothing new says so', () => {
    expect(renderDelta([{ heading: 'Decided', lines: ['- a'] }], parts(['- a'], 'Next.'))).toContain(
      'Nothing else changed',
    );
  });
});

// ---------------------------------------------------------------------------

const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, items: { type: 'array', items: { type: 'number' } } },
  required: ['answer'],
} as const;

describe('JSON from an agent that cannot be held to a schema', () => {
  test('found alone, fenced, or buried in prose', () => {
    expect(extractJson('{"answer": "x"}', SCHEMA)).toEqual({ answer: 'x' });
    expect(extractJson('Here:\n```json\n{"answer": "y"}\n```\nDone.', SCHEMA)).toEqual({ answer: 'y' });
    expect(extractJson('Well {not json} and then {"answer": "z", "note": "a } in a string"} ok', SCHEMA)).toEqual({
      answer: 'z',
      note: 'a } in a string',
    });
  });

  test('the first object that fits wins over one that does not', () => {
    expect(extractJson('{"other": 1} then {"answer": "fits"}', SCHEMA)).toEqual({ answer: 'fits' });
  });

  test('says what was wrong, for the retry', () => {
    expect(() => extractJson('no json here', SCHEMA)).toThrow(MalformedOutputError);
    expect(() => extractJson('{"answer": 3}', SCHEMA)).toThrow('$.answer should be a string');
    expect(shapeError({ answer: 'a', items: [1, 'two'] }, SCHEMA)).toBe('$.items[1] should be a number');
    expect(shapeError({}, SCHEMA)).toBe('$.answer is missing');
  });

  test('opencode replies: structured, text, or an error', () => {
    expect(readReply({ info: { structured: { answer: 'a' } } }, SCHEMA)).toEqual({ answer: 'a' });
    expect(readReply({ info: {}, parts: [{ type: 'text', text: 'ok: {"answer": "b"}' }] }, SCHEMA)).toEqual({ answer: 'b' });
    expect(() => readReply({ info: { error: { name: 'APIError', data: { message: 'no credit' } } } }, SCHEMA)).toThrow('no credit');
    expect(() => readReply({ info: { structured: { answer: 1 } } }, SCHEMA)).toThrow(MalformedOutputError);
  });

  test('the one-shot path parses opencode run --format json and asks for JSON in words', () => {
    const built = opencodeDriver.structured!.build({ prompt: 'P', cwd: '/', schema: SCHEMA, mode: 'think' });
    expect(built.command).toBe('opencode');
    expect(built.args.slice(0, 5)).toEqual(['run', '--format', 'json', '--agent', 'plan']);
    expect(built.args.at(-1)).toContain('It must match this JSON Schema');
    const stdout = [
      JSON.stringify({ type: 'step_start' }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'Result: {"answer": "c"}' } }),
    ].join('\n');
    expect(opencodeDriver.structured!.parse(stdout, SCHEMA)).toEqual({ answer: 'c' });
  });

  test('the model comes from the environment, quick mode its own', () => {
    const saved = { ...process.env };
    try {
      process.env['SPECTACULAR_OPENCODE_MODEL'] = 'openrouter/anthropic/claude-sonnet-4';
      delete process.env['SPECTACULAR_OPENCODE_QUICK_MODEL'];
      expect(opencodeModel('research')).toBe('openrouter/anthropic/claude-sonnet-4');
      expect(opencodeModel('quick')).toBe('openrouter/anthropic/claude-sonnet-4');
      process.env['SPECTACULAR_OPENCODE_QUICK_MODEL'] = 'openrouter/anthropic/claude-haiku-4.5';
      expect(opencodeModel('quick')).toBe('openrouter/anthropic/claude-haiku-4.5');
      const args = opencodeDriver.structured!.build({ prompt: 'P', cwd: '/', schema: {}, mode: 'quick' }).args;
      expect(args[args.indexOf('--model') + 1]).toBe('openrouter/anthropic/claude-haiku-4.5');
    } finally {
      process.env = saved;
    }
  });
});

describe('a one-shot request that came back malformed', () => {
  test('is asked again once, told what was wrong', async () => {
    const prompts: string[] = [];
    const driver: AgentDriver = {
      id: 'echo',
      label: 'Echo',
      build: () => ({ command: 'echo', args: [] }),
      formatLine: (l) => l,
      structured: {
        // `echo` prints the prompt back, which is all this needs to see.
        build: ({ prompt }) => ({ command: 'echo', args: [prompt] }),
        parse: (stdout) => {
          prompts.push(stdout.trim());
          if (!stdout.includes('could not be used')) throw new MalformedOutputError('$.answer is missing');
          return { answer: 'second time' };
        },
      },
    };
    expect(await runStructured(driver, process.cwd(), 'P', SCHEMA)).toEqual({ answer: 'second time' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Your last reply could not be used: $.answer is missing.');
  });
});

describe('an opencode session, against a fake server', () => {
  const setUp = () => {
    const server = new OpencodeServer(process.cwd(), { command: process.execPath, args: [FAKE_OPENCODE] }, 10_000);
    cleanups.push(() => server.stop());
    const session = new OpencodeSession(server, SCHEMA, 'think');
    const log = () => server.request<{ method: string; path: string; body?: { agent?: string; format?: { type: string }; parts: { text: string }[] }; auth: boolean }[]>('GET', '/log');
    return { server, session, log };
  };

  test('keeps one conversation, schema and read-only agent on every message', async () => {
    const { session, log } = setUp();
    expect(await session.send('one', { timeoutMs: 5000 })).toEqual({ answer: 'one', session: 'ses_1' });
    expect(await session.send('two', { timeoutMs: 5000 })).toEqual({ answer: 'two', session: 'ses_1' });
    const messages = (await log()).filter((e) => e.path.endsWith('/message'));
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.auth && m.body?.agent === 'plan' && m.body.format?.type === 'json_schema')).toBe(true);
  });

  test('JSON in prose is found; a reply without any is retried once, with the reason', async () => {
    const { session, log } = setUp();
    expect(await session.send('PROSE', { timeoutMs: 5000 })).toEqual({ answer: 'from prose', session: 'ses_1' });
    expect(await session.send('BAD', { timeoutMs: 5000 })).toEqual({ answer: 'fixed', session: 'ses_1' });
    const retry = (await log()).filter((e) => e.path.endsWith('/message')).at(-1)!;
    expect(retry.body!.parts[0]!.text).toContain('could not be used: the reply held no JSON object');
    expect(retry.body!.parts[0]!.text).toContain('It must match this JSON Schema');
  });

  test('a provider error is the request failing, not the session', async () => {
    const { session } = setUp();
    await expect(session.send('ERROR', { timeoutMs: 5000 })).rejects.toThrow('no credit');
    expect(session.alive).toBe(true);
  });

  test('closing deletes the conversation from opencode', async () => {
    const { server, session, log } = setUp();
    await session.send('one', { timeoutMs: 5000 });
    session.close();
    await Bun.sleep(100);
    expect((await log()).some((e) => e.method === 'DELETE' && e.path === '/session/ses_1')).toBe(true);
    expect(server.running).toBe(true);
  });

  test('stopping the server right after closing still deletes the conversation first', async () => {
    const { server, session } = setUp();
    await session.send('one', { timeoutMs: 5000 });
    const deleted: string[] = [];
    const request = server.request.bind(server);
    server.request = (async (method: string, path: string, body?: unknown, signal?: AbortSignal) => {
      if (method === 'DELETE') deleted.push(path);
      return request(method, path, body, signal);
    }) as typeof server.request;
    session.close();
    await server.stop();
    expect(deleted).toEqual(['/session/ses_1']);
    expect(server.running).toBe(false);
  });

  test('a server that cannot start is a session error', async () => {
    const server = new OpencodeServer(process.cwd(), { command: '/nonexistent/opencode', args: [] }, 2000);
    const session = new OpencodeSession(server, SCHEMA, 'think');
    await expect(session.send('x', { timeoutMs: 2000 })).rejects.toBeInstanceOf(SessionError);
  });
});
