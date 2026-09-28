/**
 * The guided first run, by keystroke, asserted on the rendered frame: the
 * start screen → set up → ground rules (with the advisor digging deeper) →
 * first change → its next step.
 *
 * OpenSpec is stubbed at the TuiInput boundary and the model behind the
 * advisor is a fake; the Foundation is real files in a temp dir.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ask } from '../src/core/advisor.ts';
import { answerFoundation, foundationDir, guidedQuestions } from '../src/core/foundation.ts';
import { mountApp } from './support/app-harness.tsx';

const mounted: { destroy: () => void }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.destroy();
});

/** An existing project by default: the vision step is for new ones. */
async function mount(ask?: Ask) {
  const ui = await mountApp({ ask, baseline: true });
  mounted.push(ui);
  return ui;
}

/**
 * A model that knows exactly one thing: Elixir needs a version. (Elixir, because
 * the preset table has nothing for it: this is the advisor on its own.)
 */
const elixirAdvisor = (): { ask: Ask; prompts: string[] } => {
  const prompts: string[] = [];
  const ask: Ask = async (prompt) => {
    prompts.push(prompt);
    if (prompt.includes('Answer: Elixir')) {
      return {
        followUps: [{
          ask: 'Which Elixir version?',
          why: 'Pins the syntax code and CI can rely on.',
          options: [
            { label: '1.19', detail: 'Latest stable', recommended: true },
            { label: '1.18', detail: 'Previous stable', recommended: false },
          ],
        }],
        upcoming: [
          { label: 'Phoenix', detail: 'Full-stack web', recommended: true },
          { label: 'Plug', detail: 'Minimal', recommended: false },
        ],
      };
    }
    return { followUps: [], upcoming: [] };
  };
  return { ask, prompts };
};

/** A model that answers only when told to, request by request. */
const heldAdvisor = () => {
  const held: { prompt: string; release: (v: unknown) => void }[] = [];
  const ask: Ask = (prompt) => new Promise((release) => held.push({ prompt, release }));
  const answerTo = (text: string) => held.find((h) => h.prompt.includes(text))!;
  return { ask, answerTo };
};

describe('the start screen', () => {
  test('shows the logo and a Start button that sets the folder up', async () => {
    const ui = await mountApp({});
    mounted.push(ui);
    await ui.settle(1000);
    expect(ui.frame()).toContain('███████╗');
    expect(ui.frame()).toContain('This folder is not set up yet');
    expect(ui.frame()).toContain('▶ Start');
    expect(ui.frame()).toContain('Quit');

    await ui.press('return');
    expect(ui.frame()).toContain('Before the first change, settle the ground rules.');
    expect(ui.frame()).toContain('✓ Set up');
    expect(ui.frame()).toContain('▶ Begin — 19 questions');
  });
});

describe('the ground rules', () => {
  test('an empty folder is guided all the way to its first proposal', async () => {
    const ui = await mount();
    await ui.press('return'); // Start
    await ui.press('return'); // Begin

    expect(ui.frame()).toContain('Stack · What the project is built with.');
    expect(ui.frame()).toContain('Language and runtime, with versions.');
    expect(ui.frame()).toContain('e.g. "TypeScript 5.6 on Bun 1.4"');
    expect(ui.frame()).toContain('type your answer — or "skip"');

    await ui.type('TypeScript on Bun');
    expect(ui.frame()).toContain('› TypeScript on Bun');
    await ui.press('return');
    expect(ui.frame()).toContain('Framework, if any');
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).toContain(
      'TypeScript on Bun',
    );

    // Enter on an empty, unanswered question explains instead of skipping.
    await ui.press('return');
    expect(ui.frame()).toContain('press tab (or type "skip")');

    for (let i = 1; i < 19; i++) {
      await ui.type(`answer ${i}`);
      await ui.press('return');
    }
    expect(ui.frame()).toContain('All 19 ground rules are answered.');
    await ui.press('return');

    // First change: explained, then created from the overview
    expect(ui.frame()).toContain('Ground rules are set. Next: your first change.');
    expect(ui.frame()).toContain('+ New change');
    // What first, the name last — proposed from the description.
    await ui.press('n');
    expect(ui.frame()).toContain('What do you want to change, and why?');
    await ui.press('return');
    expect(ui.frame()).toContain('Describe the change first');
    await ui.type('Let users log in with email');
    await ui.press('return');
    expect(ui.frame()).toContain('A name for it — proposed from your description');
    expect(ui.frame()).toContain('› log-email▏');

    // Adjustable: clear it, try an invalid one, then a valid one.
    await ui.press('u', { ctrl: true });
    await ui.type('Add Login');
    await ui.press('return');
    expect(ui.frame()).toContain('lowercase words joined by dashes');
    await ui.press('u', { ctrl: true });
    await ui.type('add-login');
    await ui.press('return');

    expect(ui.frame()).toContain('Created add-login.');
    expect(ui.frame()).toContain('◉ proposal');
    expect(ui.frame()).toContain('Write the proposal');
    expect(ui.frame()).toContain('✦ Let an agent draft it');
    expect(ui.frame()).toContain('✎ Write it myself');

    // Enter presses the highlighted button: the next step.
    await ui.press('return');
    expect(ui.dispatched).toEqual(['add-login/proposal']);
    expect(ui.frame()).toContain('drafting add-login/proposal');
  });

  test('the advisor digs into an answer before moving on, and proposes options', async () => {
    const { ask, prompts } = elixirAdvisor();
    const ui = await mount(ask);
    await ui.press('return');
    expect(ui.frame()).toContain('Not sure? Press ?');
    await ui.press('return');

    await ui.type('Elixir');
    await ui.press('return');
    await ui.settle(100);

    // The answer was sent with everything decided so far.
    const advised = prompts.find((p) => p.includes('Answer: Elixir'))!;
    expect(advised).toContain('Just answered — [Stack] Language and runtime, with versions.');
    expect(advised).toContain('most recent stable release');

    // What the answer left open is asked straight away, not after the rest.
    expect(ui.frame()).toContain('Which Elixir version?');
    expect(ui.frame()).toContain('✦ follow-up to “Language and runtime, with versions.”');
    expect(ui.frame()).toContain('▸ 1.19');
    expect(ui.frame()).toContain('★ recommended');

    // ↓ moves off the recommendation; enter takes what is selected.
    await ui.press('down');
    expect(ui.frame()).toContain('▸ 1.18');
    await ui.press('return');
    await ui.settle(100);
    const stack = () => readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8');
    expect(stack()).toContain('## Which Elixir version?\n\n1.18');

    // Then on: the next question's options came with the first request.
    expect(ui.frame()).toContain('Framework, if any');
    expect(ui.frame()).toContain('▸ Phoenix');
    expect(ui.frame()).toContain('✎ Write my own answer');
    await ui.press('return');
    expect(stack()).toContain('## Framework, if any, and why it over the alternatives.\n\nPhoenix');
  });

  test('while it looks at an answer, enter moves on without waiting', async () => {
    let release: (v: unknown) => void = () => {};
    const ui = await mount(() => new Promise((r) => { release = r; }));
    await ui.press('return');
    await ui.press('return');
    await ui.type('Elixir');
    await ui.press('return');
    expect(ui.frame()).toContain('✓ Saved: Elixir');
    expect(ui.frame()).toContain('Looking at your answer');
    expect(ui.frame()).toContain('continue without waiting');
    await ui.press('return');
    expect(ui.frame()).toContain('Framework, if any');
    release({ followUps: [], upcoming: [], derived: [] });
  });

  test('a common answer gets its preset follow-up at once; the advisor fills in behind', async () => {
    const { ask, answerTo } = heldAdvisor();
    const ui = await mount(ask);
    await ui.press('return');
    await ui.press('return');
    await ui.type('Python');
    await ui.press('return');

    // No waiting: the version question is there, marked as a preset, while
    // the advisor — asked about it, with web search — is still thinking.
    expect(ui.frame()).not.toContain('Looking at your answer');
    expect(ui.frame()).toContain('Which Python version?');
    expect(ui.frame()).toContain('◇ follow-up to “Language and runtime, with versions.”');
    expect(ui.frame()).toContain('looking for options…');
    const advised = answerTo('Answer: Python');
    expect(advised.prompt).toContain('upcoming: options for the next question — [Stack] Which Python version?');
    expect(advised.prompt).toContain('web search rather than relying on memory');

    advised.release({
      followUps: [],
      upcoming: [
        { label: '3.14', detail: 'Latest stable', recommended: true },
        { label: '3.13', detail: 'Previous', recommended: false },
      ],
      derived: [],
    });
    await ui.settle(100);
    expect(ui.frame()).toContain('▸ 3.14');
  });

  test('advice that arrives late never moves what the developer selected', async () => {
    const { ask, answerTo } = heldAdvisor();
    const ui = await mount(ask);
    await ui.press('return');
    await ui.press('return');
    await ui.type('TypeScript');
    await ui.press('return');

    // The runtime question, with the table's options, at once.
    expect(ui.frame()).toContain('Which runtime runs it: Node.js, Bun or Deno?');
    expect(ui.frame()).toContain('▸ Node.js (LTS)');
    expect(ui.frame()).toContain('◇ instant suggestions, AI refining…');
    await ui.press('down');
    expect(ui.frame()).toContain('▸ Bun');

    // Better options arrive, without Bun among them: Bun stays, still selected.
    answerTo('Answer: TypeScript').release({
      followUps: [],
      upcoming: [
        { label: 'Node.js 24 LTS', detail: 'current LTS', recommended: true },
        { label: 'Deno 2', detail: 'built-in tooling', recommended: false },
      ],
      derived: [],
    });
    await ui.settle(100);
    expect(ui.frame()).toContain('Node.js 24 LTS');
    expect(ui.frame()).toContain('▸ Bun');
    await ui.press('return');
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).toContain(
      '## Which runtime runs it: Node.js, Bun or Deno?\n\nBun',
    );
  });

  test('not sure: an explanation, examples, and a simpler question first', async () => {
    const ask: Ask = async (prompt) => {
      if (prompt.includes('does not know how to answer')) {
        return {
          explain: 'Which language the code is written in, and the program that runs it.',
          examples: [
            { label: 'TypeScript on Node 24', detail: 'web and tooling', recommended: true },
            { label: 'Python 3.14', detail: 'data and scripting', recommended: false },
          ],
          probes: [{
            ask: 'What will people use it through?',
            why: 'A browser app and a data pipeline want different languages.',
            options: [{ label: 'A website', detail: '', recommended: true }],
          }],
        };
      }
      if (prompt.includes('Answer: A website')) {
        return {
          followUps: [],
          upcoming: [],
          derived: [{ question: 'Language and runtime, with versions.', answer: 'TypeScript on Node 24', reason: 'a website' }],
        };
      }
      return { followUps: [], upcoming: [], derived: [] };
    };
    const ui = await mount(ask);
    await ui.press('return');
    await ui.press('return');
    expect(ui.frame()).toContain("? I'm not sure");

    await ui.type('not sure');
    await ui.press('return');
    await ui.settle(100);

    // A simpler question comes first, marked as helping the harder one.
    expect(ui.frame()).toContain('What will people use it through?');
    expect(ui.frame()).toContain('✦ a simpler question, to help decide “Language and runtime, with versions.”');
    await ui.press('return'); // "A website"
    await ui.settle(100);

    // Back to the hard one: explained, with examples — and an answer derived
    // from the simpler one, selected, waiting for a yes.
    expect(ui.frame()).toContain('Language and runtime, with versions.');
    expect(ui.frame()).toContain('💡 Which language the code is written in');
    expect(ui.frame()).toContain('▸ ⇐ TypeScript on Node 24');
    expect(ui.frame()).toContain('⇐');
    expect(ui.frame()).toContain('from your earlier answers: a website');
    await ui.press('return');
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).toContain(
      '## Language and runtime, with versions.\n\nTypeScript on Node 24',
    );
  });

  test('? and an empty enter both ask for help', async () => {
    let coached = 0;
    const ui = await mount(async (prompt) => {
      if (prompt.includes('does not know how to answer')) coached++;
      return { explain: 'x', examples: [], probes: [], followUps: [], upcoming: [], derived: [] };
    });
    await ui.press('return');
    await ui.press('return');
    await ui.press('?');
    await ui.settle(50);
    // Help stays on the question when there is nothing simpler to ask.
    await ui.press('down'); // off the help row, onto "write my answer"
    await ui.press('return');
    await ui.settle(50);
    expect(coached).toBe(2);
  });

  test('typing "skip" skips', async () => {
    const ui = await mount();
    await ui.press('return');
    await ui.press('return');
    await ui.type('skip');
    await ui.press('return');
    expect(ui.frame()).toContain('Framework, if any');
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).not.toContain('skip');
  });

  test('a follow-up can be dismissed as not relevant', async () => {
    const { ask } = elixirAdvisor();
    const ui = await mount(ask);
    await ui.press('return');
    await ui.press('return');
    await ui.type('Elixir');
    await ui.press('return');
    await ui.settle(100);
    expect(ui.frame()).toContain('Which Elixir version?');
    expect(ui.frame()).toContain('ctrl+d');
    await ui.press('d', { ctrl: true });
    expect(ui.frame()).toContain('Removed “Which Elixir version?”');
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).not.toContain(
      'Which Elixir version?',
    );
  });

  test('typing replaces a proposed option with your own answer', async () => {
    const { ask } = elixirAdvisor();
    const ui = await mount(ask);
    await ui.press('return');
    await ui.press('return');
    await ui.type('Elixir');
    await ui.press('return');
    await ui.settle(100);
    await ui.type('3.12.4, pinned by our platform team');
    await ui.press('return');
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).toContain('3.12.4, pinned by our platform team');
  });

  test('a failing advisor is a line on screen, never a blocker', async () => {
    const ui = await mount(async () => {
      throw new Error('rate limited');
    });
    await ui.press('return');
    await ui.press('return');
    await ui.type('Go 1.23');
    await ui.press('return');
    await ui.settle(100);
    expect(ui.frame()).toContain('AI suggestions failed: rate limited');
    expect(ui.frame()).toContain('Framework, if any');
  });

  test('leaving half done is fine, but blocks a change', async () => {
    const ui = await mount();
    await ui.press('return');
    await ui.press('return');
    await ui.type('Go 1.23');
    await ui.press('return');
    await ui.press('c', { ctrl: true });

    expect(ui.frame()).toContain('Ground rules: 1 of 19 answered.');
    await ui.press('n');
    expect(ui.frame()).toContain('Settle the ground rules first');

    // f comes back to the next open question, not the intro.
    await ui.press('f');
    expect(ui.frame()).toContain('Framework, if any');
  });

  test('tab skips a question, and ← returns to it', async () => {
    const ui = await mount();
    await ui.press('return');
    await ui.press('return');
    await ui.press('tab');
    expect(ui.frame()).toContain('Framework, if any');
    await ui.press('left');
    expect(ui.frame()).toContain('Language and runtime, with versions.');
    expect(ui.frame()).toContain('0/19');
  });
});

describe('a new change', () => {
  test('its name is proposed from the description, and the AI improves it', async () => {
    const ui = await mountApp({
      nameChange: async () => ['add-email-login', 'email-sign-in'],
      baseline: true,
    });
    mounted.push(ui);
    await ui.press('return');
    for (const q of guidedQuestions(ui.root)) answerFoundation(q.item, 'Decided.');
    await ui.press('c', { ctrl: true });

    await ui.press('n');
    await ui.type('Let users log in with email');
    await ui.press('return');
    await ui.settle(50);
    expect(ui.frame()).toContain('› add-email-login▏');
    expect(ui.frame()).toContain('suggestions: add-email-login · email-sign-in · log-email');
    await ui.press('tab');
    expect(ui.frame()).toContain('› email-sign-in▏');
    await ui.press('return');
    expect(ui.changes.map((c) => c.name)).toEqual(['email-sign-in']);
  });

  test('a name being adjusted is never overwritten by a late proposal', async () => {
    let release: (v: string[]) => void = () => {};
    const ui = await mountApp({ nameChange: () => new Promise((r) => { release = r; }), baseline: true });
    mounted.push(ui);
    await ui.press('return');
    for (const q of guidedQuestions(ui.root)) answerFoundation(q.item, 'Decided.');
    await ui.press('c', { ctrl: true });
    await ui.press('n');
    await ui.type('Let users log in with email');
    await ui.press('return');
    expect(ui.frame()).toContain('proposing a better name');
    await ui.type('-v2');
    release(['add-email-login']);
    await ui.settle(50);
    expect(ui.frame()).toContain('› log-email-v2▏');
  });
});

describe('the overview', () => {
  test('? explains every key', async () => {
    const ui = await mount();
    await ui.press('return');
    for (const q of guidedQuestions(ui.root)) answerFoundation(q.item, 'Decided.');
    await ui.press('c', { ctrl: true });
    await ui.press('?');
    expect(ui.frame()).toContain('let an agent draft the next artifact');
    expect(ui.frame()).toContain('the ground rules: stack, domain, architecture, conventions');
    await ui.press('x');
    expect(ui.frame()).not.toContain('Pipeline marks');
  });
});
