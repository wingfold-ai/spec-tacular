/**
 * The setup's AI wired to an agent (src/assistants.ts): warmed and primed
 * before the first question, never with SPECTACULAR_NO_ADVISOR, and gone
 * when spec-tacular is. The agent is the fake stream-json one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamJsonSession } from '../src/agent/claude.ts';
import { liveChildren } from '../src/agent/children.ts';
import { DriverRegistry, type AgentDriver, type StructuredMode } from '../src/agent/driver.ts';
import { createAssistants } from '../src/assistants.ts';
import { answerFoundation, guidedQuestions, scaffoldFoundation } from '../src/core/foundation.ts';

const FAKE_AGENT = join(import.meta.dir, 'support', 'fake-stream-agent.ts');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const project = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-ai-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  scaffoldFoundation(d, { defer: true });
  return d;
};

/** A registry whose one driver's sessions are the fake agent. */
const fakeAgent = () => {
  const started: { mode: StructuredMode; session: StreamJsonSession }[] = [];
  const driver: AgentDriver = {
    id: 'fake',
    label: 'Fake',
    build: () => ({ command: process.execPath, args: [] }),
    formatLine: (l) => l,
    structured: {
      // An absolute path, so the advisor counts it as installed.
      build: () => ({ command: process.execPath, args: [] }),
      parse: () => ({}),
      session: ({ mode }) => {
        const session = new StreamJsonSession({ command: process.execPath, args: [FAKE_AGENT, mode] }, process.cwd(), 'Fake');
        started.push({ mode, session });
        return session;
      },
    },
  };
  return { registry: new DriverRegistry().register(driver), started };
};

const waitFor = async (check: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await Bun.sleep(20);
  return check();
};

describe('warming the setup’s AI', () => {
  test('starts and primes its sessions before the first question, which is then a delta', async () => {
    const cwd = project();
    const log = join(cwd, 'debug.log');
    const before = process.env['SPECTACULAR_DEBUG_LOG'];
    process.env['SPECTACULAR_DEBUG_LOG'] = log;
    cleanups.push(() => {
      if (before === undefined) delete process.env['SPECTACULAR_DEBUG_LOG'];
      else process.env['SPECTACULAR_DEBUG_LOG'] = before;
    });

    const { registry, started } = fakeAgent();
    const ai = createAssistants({ cwd, driver: 'fake', registry, env: {} });
    cleanups.push(() => ai.close());
    ai.warm('foundation');
    ai.warm('foundation'); // the start screen, then the ground rules: once is enough
    const read = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
    expect(await waitFor(() => (read().match(/primed/g) ?? []).length === 2)).toBe(true);
    // The domain is thought about; the stack is looked up.
    expect(started.map((s) => s.mode).sort()).toEqual(['research', 'think']);

    const purpose = guidedQuestions(cwd)[0]!;
    answerFoundation(purpose.item, 'Lets clinic staff book rooms');
    await ai.advisor!.afterAnswer(purpose, 'Lets clinic staff book rooms');

    const lines = readFileSync(log, 'utf8').split('\n');
    expect(lines.some((l) => /advisor think\/followUps,upcoming,derived primed/.test(l))).toBe(true);
    expect(lines.some((l) => /advisor think\/followUps,upcoming,derived turn 2 delta/.test(l))).toBe(true);
    expect(started).toHaveLength(2);
  });

  test('the vision interview is primed too, before the vision is described', async () => {
    const { registry, started } = fakeAgent();
    const ai = createAssistants({ cwd: project(), driver: 'fake', registry, env: {} });
    cleanups.push(() => ai.close());
    ai.warm('vision');
    expect(await waitFor(() => started.length === 1)).toBe(true);
    expect(started[0]!.mode).toBe('think');
  });

  test('SPECTACULAR_NO_ADVISOR: nothing is started, whatever is warmed', async () => {
    const { registry, started } = fakeAgent();
    const ai = createAssistants({ cwd: project(), driver: 'fake', registry, env: { SPECTACULAR_NO_ADVISOR: '1' } });
    cleanups.push(() => ai.close());
    ai.warm('foundation');
    ai.warm('vision');
    ai.warm('naming');
    await Bun.sleep(100);
    expect(started).toHaveLength(0);
    expect(ai.advisor).toBeNull();
    expect(ai.advisorNote).toBe('turned off by SPECTACULAR_NO_ADVISOR');
  });

  test('quitting straight after warming leaves no agent running', async () => {
    const { registry, started } = fakeAgent();
    const before = liveChildren();
    const ai = createAssistants({ cwd: project(), driver: 'fake', registry, env: {} });
    ai.warm('foundation');
    expect(await waitFor(() => started.length === 2)).toBe(true);
    await ai.close();
    expect(started.every((s) => !s.session.alive)).toBe(true);
    expect(await waitFor(() => liveChildren() === before)).toBe(true);
  });
});
