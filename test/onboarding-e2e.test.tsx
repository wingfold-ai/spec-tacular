/**
 * The guided first run, by keystroke, asserted on the rendered frame: the
 * start screen → set up → ground rules (with the advisor digging deeper) →
 * first change → its next step.
 *
 * OpenSpec is stubbed at the TuiInput boundary and the model behind the
 * advisor is a fake; the Foundation is real files in a temp dir.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ask } from '../src/core/advisor.ts';
import { answerFoundation, foundationDir, guidedQuestions } from '../src/core/foundation.ts';
import { foundationGate } from '../src/core/gate.ts';
import { freshChange, mountApp } from './support/app-harness.tsx';

const mounted: { destroy: () => void }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.destroy();
});

/** An existing project by default: the vision step is for new ones. */
async function mount(ask?: Ask, extra: Parameters<typeof mountApp>[0] = {}) {
  const ui = await mountApp({ ask, baseline: true, ...extra });
  mounted.push(ui);
  return ui;
}

/**
 * A model that knows exactly one thing: Elixir needs a version before the first
 * change, and its OTP release can wait. (Elixir, because the preset table has
 * nothing for it: this is the advisor on its own.)
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
          now: true,
          options: [
            { label: '1.19', detail: 'Latest stable', recommended: true },
            { label: '1.18', detail: 'Previous stable', recommended: false },
          ],
        }, {
          ask: 'Which OTP release does it target?',
          why: 'Only matters once it is deployed.',
          now: false,
          options: [],
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
    expect(ui.frame()).toContain('OpenSpec is here; spec-tacular is not set up yet.');
    expect(ui.frame()).toContain('▶ Start');
    expect(ui.frame()).toContain('Quit');

    await ui.press('return');
    // A new project describes its vision first; the ground rules come after.
    expect(ui.frame()).toContain('What are you building?');
    expect(ui.frame()).toContain('✓ Set up');
    expect(ui.frame()).toContain('2. Vision');
    await ui.press('n', { ctrl: true }); // not a new project after all
    expect(ui.frame()).toContain('Before the first change, settle the ground rules.');
    // Only what can be answered on day one.
    expect(ui.frame()).toContain('▶ Begin — 11 questions');
  });

  test('without OpenSpec, nothing goes on until `openspec init` has run', async () => {
    const ui = await mountApp({ openspec: false });
    mounted.push(ui);
    expect(ui.frame()).toContain('OpenSpec is not initialized here. Run `openspec init` in this folder and choose');
    expect(ui.frame()).toContain('▶ Check again');
    expect(ui.frame()).not.toContain('▶ Start');

    await ui.press('return'); // still nothing
    expect(ui.frame()).toContain('Still not set up — run `openspec init` here first.');
    expect(existsSync(join(ui.root, 'openspec'))).toBe(false);

    // The developer runs it, for Claude Code, and checks again.
    mkdirSync(join(ui.root, 'openspec'));
    mkdirSync(join(ui.root, '.claude', 'skills', 'openspec-apply-change'), { recursive: true });
    await ui.press('return');
    expect(ui.frame()).toContain('▶ Start');
  });

  test('OpenSpec set up without the agent counts as not set up', async () => {
    const ui = await mountApp({ openspec: 'agent' });
    mounted.push(ui);
    expect(ui.frame()).toContain('OpenSpec is not set up for Claude Code here.');
    expect(ui.frame()).toContain('▶ Check again');
  });

  test('a new folder warms the vision AI before anything is described', async () => {
    const ui = await mountApp({});
    mounted.push(ui);
    // On the start screen already, before Start is pressed: the vision is next.
    expect(ui.warmed).toEqual(['vision']);
    await ui.press('return');
    expect(ui.warmed.every((w) => w === 'vision')).toBe(true);
  });

  test('a folder with a baseline warms the ground-rules advisor instead', async () => {
    const ui = await mountApp({ baseline: true });
    mounted.push(ui);
    expect(ui.warmed).toEqual(['foundation']);
    await ui.press('return');
    await ui.press('return');
    expect(ui.warmed.every((w) => w === 'foundation')).toBe(true);
  });

  test('once the setup is done, nothing more is warmed for it', async () => {
    const ui = await mountApp({ baseline: true });
    mounted.push(ui);
    await ui.press('return');
    ui.settleGroundRules();
    ui.changes.push(freshChange('add-login'));
    ui.warmed.splice(0);
    await ui.press('c', { ctrl: true });
    expect(ui.warmed).toEqual([]);
  });
});

describe('typing a long answer', () => {
  test('wraps to the box, every line on its own row', async () => {
    const ui = await mount(undefined, { width: 100 });
    await ui.press('return');
    await ui.press('return');
    for (let i = 0; i < 4; i++) await ui.type('lorem ipsum dolor sit amet consectetur adipiscing elit sed ');

    // Each wrap used to be drawn over the row above it, a row left empty below.
    const frame = ui.frame();
    expect(frame).toContain('│ › lorem ipsum dolor sit amet consectetur adipiscing elit sed lorem ipsum dolor sit amet      │');
    expect(frame).toContain('│   consectetur adipiscing elit sed lorem ipsum dolor sit amet consectetur adipiscing elit sed │');
    expect(frame).toContain('│   lorem ipsum dolor sit amet consectetur adipiscing elit sed ▏');
  });
});

/** From the first question (the domain's) to the first Stack question, skipping. */
const toStack = async (ui: Awaited<ReturnType<typeof mount>>) => {
  for (let i = 0; i < 4; i++) await ui.press('tab');
  expect(ui.frame()).toContain('Language and runtime, with versions.');
};

describe('the ground rules', () => {
  test('an empty folder is guided all the way to its first proposal', async () => {
    const ui = await mount();
    await ui.press('return'); // Start
    await ui.press('return'); // Begin

    // The domain comes first: what it is, before what it is built with.
    expect(ui.frame()).toContain('Domain · What the project is about');
    expect(ui.frame()).toContain('What the system is for, and who uses it.');
    expect(ui.frame()).toContain('↷ Skip — leave it for later');
    expect(ui.frame()).toContain('▸ ✎ Write my answer');
    expect(ui.frame()).toContain('type your answer — or "skip"');

    await ui.type('Lets clinic staff book rooms');
    expect(ui.frame()).toContain('› Lets clinic staff book rooms');
    await ui.press('return');
    expect(ui.frame()).toContain('The core terms');
    expect(readFileSync(join(foundationDir(ui.root), 'domain.md'), 'utf8')).toContain(
      'Lets clinic staff book rooms',
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
    await toStack(ui);

    await ui.type('Elixir');
    await ui.press('return');
    await ui.settle(100);

    // The answer was sent with everything decided so far.
    const advised = prompts.find((p) => p.includes('Answer: Elixir'))!;
    expect(advised).toContain('Just answered — [Stack] Language and runtime, with versions.');
    expect(advised).toContain('most recent stable release');

    // What the answer left open is asked straight away, not after the rest —
    // the one question the first change needs; the other is recorded for later.
    expect(ui.frame()).toContain('Which Elixir version?');
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).toContain(
      '## Which OTP release does it target?\n\nDecide later',
    );
    expect(guidedQuestions(ui.root).some((q) => q.item.name.startsWith('Which OTP'))).toBe(false);
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

  test('an option shows its whole answer, and picking it writes all of it', async () => {
    const ask: Ask = async (prompt) =>
      prompt.includes('Answer: Elixir')
        ? {
            followUps: [],
            upcoming: [
              {
                label: 'Phoenix',
                detail: 'Full-stack web',
                answer: 'Phoenix 1.8 with LiveView for the UI.\nEcto for the database.\nNo separate SPA.',
                recommended: true,
              },
              { label: 'Plug', detail: 'Minimal', answer: 'Plug', recommended: false },
            ],
            derived: [],
          }
        : { followUps: [], upcoming: [], derived: [] };
    const ui = await mount(ask);
    await ui.press('return');
    await ui.press('return');
    await toStack(ui);
    await ui.type('Elixir');
    await ui.press('return');
    await ui.settle(100);

    expect(ui.frame()).toContain('▸ Phoenix');
    expect(ui.frame()).toContain('picking writes this');
    expect(ui.frame()).toContain('Ecto for the database.');
    await ui.press('return');
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).toContain(
      '## Framework, if any, and why it over the alternatives.\n\nPhoenix 1.8 with LiveView for the UI.\nEcto for the database.\nNo separate SPA.',
    );
  });

  test('ctrl+r revises the highlighted option with AI before it is saved', async () => {
    const ask: Ask = async (prompt) =>
      prompt.includes('Answer: Elixir')
        ? {
            followUps: [],
            upcoming: [{ label: 'Phoenix', detail: 'Full-stack web', answer: 'Phoenix with LiveView.\nEcto for the database.', recommended: true }],
            derived: [],
          }
        : { followUps: [], upcoming: [], derived: [] };
    const calls: { question: string; current: string; instruction: string }[] = [];
    const ui = await mount(ask, {
      reviseAnswer: {
        unavailable: null,
        propose: async (question, current, _turns, instruction) => {
          calls.push({ question: question.item.name, current, instruction });
          return { block: 'Phoenix, JSON API only.\nEcto for the database.', summary: 'Dropped LiveView', warnings: [] };
        },
      },
    });
    await ui.press('return');
    await ui.press('return');
    await toStack(ui);
    await ui.type('Elixir');
    await ui.press('return');
    await ui.settle(100);

    expect(ui.frame()).toContain('ctrl+r');
    await ui.press('r', { ctrl: true });
    expect(ui.frame()).toContain('How should this answer change?');
    // The whole text being revised is on screen, above the input.
    expect(ui.frame()).toContain('The answer as it is now');
    expect(ui.frame()).toContain('Phoenix with LiveView.');
    expect(ui.frame()).toContain('Ecto for the database.');
    await ui.type('drop LiveView, it is an API');
    await ui.press('return');
    await ui.settle(100);
    expect(calls).toEqual([{
      question: 'Framework, if any, and why it over the alternatives.',
      current: 'Phoenix with LiveView.\nEcto for the database.',
      instruction: 'drop LiveView, it is an API',
    }]);
    expect(ui.frame()).toContain('Dropped LiveView');

    // Nothing is written until it is accepted; then it is saved as the answer.
    const stack = () => readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8');
    expect(stack()).not.toContain('JSON API only');
    await ui.press('a');
    await ui.settle(100);
    expect(stack()).toContain('## Framework, if any, and why it over the alternatives.\n\nPhoenix, JSON API only.\nEcto for the database.');
  });

  test('in the revise panel, enter with nothing typed takes the option as it is', async () => {
    const ask: Ask = async (prompt) =>
      prompt.includes('Answer: Elixir')
        ? {
            followUps: [],
            upcoming: [{ label: 'Phoenix', detail: 'Full-stack web', answer: 'Phoenix with LiveView.\nEcto for the database.', recommended: true }],
            derived: [],
          }
        : { followUps: [], upcoming: [], derived: [] };
    let asked = 0;
    const ui = await mount(ask, {
      reviseAnswer: {
        unavailable: null,
        propose: async () => {
          asked++;
          return { block: 'x', summary: '', warnings: [] };
        },
      },
    });
    await ui.press('return');
    await ui.press('return');
    await toStack(ui);
    await ui.type('Elixir');
    await ui.press('return');
    await ui.settle(100);

    await ui.press('r', { ctrl: true });
    expect(ui.frame()).toContain('take it as it is');
    await ui.press('return');
    await ui.settle(100);
    expect(asked).toBe(0);
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).toContain(
      '## Framework, if any, and why it over the alternatives.\n\nPhoenix with LiveView.\nEcto for the database.',
    );
  });

  test('Skip is the first choice on every question, but never the default', async () => {
    const { ask } = elixirAdvisor();
    const ui = await mount(ask);
    await ui.press('return');
    await ui.press('return');
    await toStack(ui);
    await ui.type('Elixir');
    await ui.press('return');
    await ui.settle(100);

    // Listed first, above the options — the recommendation is what is selected.
    const lines = ui.frame().split('\n');
    const at = (text: string) => lines.findIndex((l) => l.includes(text));
    expect(at('↷ Skip — leave it for later')).toBeGreaterThan(-1);
    expect(at('↷ Skip — leave it for later')).toBeLessThan(at('1.19'));
    expect(ui.frame()).toContain('▸ 1.19');
    expect(ui.frame()).not.toContain('▸ ↷ Skip');

    // Chosen, it does what tab does: on to the next question, nothing written.
    await ui.press('up');
    expect(ui.frame()).toContain('▸ ↷ Skip');
    expect(ui.frame()).toContain('enter  skip');
    await ui.press('return');
    expect(ui.frame()).toContain('Framework, if any');
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).toContain('## Which Elixir version?\n\nTBD');
  });

  test('while it looks at an answer, enter moves on without waiting', async () => {
    let release: (v: unknown) => void = () => {};
    const ui = await mount(() => new Promise((r) => { release = r; }));
    await ui.press('return');
    await ui.press('return');
    await toStack(ui);
    await ui.type('Elixir');
    await ui.press('return');
    expect(ui.frame()).toContain('✓ Saved: Elixir');
    expect(ui.frame()).toContain('Looking at your answer');
    expect(ui.frame()).toContain('continue without waiting');
    await ui.press('return');
    expect(ui.frame()).toContain('Framework, if any');
    release({ followUps: [], upcoming: [], derived: [] });
  });

  test('a common answer records its preset follow-up for later; the next question has instant options', async () => {
    const { ask, answerTo } = heldAdvisor();
    const ui = await mount(ask);
    await ui.press('return');
    await ui.press('return');
    await toStack(ui);
    await ui.type('Python');
    await ui.press('return');

    // The table's version question is not asked: it is in the file for later.
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).toContain(
      '## Which Python version?\n\nDecide later',
    );
    // The advisor — with web search — looks at the answer, and at the table's
    // options for the next question, to improve on them.
    expect(ui.frame()).toContain('Looking at your answer');
    const advised = answerTo('Answer: Python');
    expect(advised.prompt).toContain('upcoming: options for the next question — [Stack] Framework');
    expect(advised.prompt).toContain('Generic options are shown for it already: FastAPI');
    expect(advised.prompt).toContain('web search rather than relying on memory');

    advised.release({
      followUps: [],
      upcoming: [
        { label: 'FastAPI', detail: 'typed async APIs', recommended: true },
        { label: 'Litestar', detail: 'lighter', recommended: false },
      ],
      derived: [],
    });
    await ui.settle(100);
    expect(ui.frame()).toContain('Framework, if any');
    expect(ui.frame()).not.toContain('Which Python version?');
    expect(ui.frame()).toContain('▸ FastAPI');
  });

  test('advice that arrives late never moves what the developer selected', async () => {
    const { ask, answerTo } = heldAdvisor();
    const ui = await mount(ask);
    await ui.press('return');
    await ui.press('return');
    await toStack(ui);
    await ui.type('Python');
    await ui.press('return');
    // On without waiting for the advisor.
    await ui.press('return');

    // The framework question, with the table's options, at once.
    expect(ui.frame()).toContain('Framework, if any');
    expect(ui.frame()).toContain('▸ FastAPI');
    expect(ui.frame()).toContain('◇ instant suggestions, AI refining…');
    await ui.press('down');
    expect(ui.frame()).toContain('▸ Django');

    // Better options arrive, without Django among them: Django stays, still selected.
    answerTo('Answer: Python').release({
      followUps: [],
      upcoming: [
        { label: 'Litestar', detail: 'typed, fast', recommended: true },
        { label: 'Starlette', detail: 'minimal ASGI', recommended: false },
      ],
      derived: [],
    });
    await ui.settle(100);
    expect(ui.frame()).toContain('Litestar');
    expect(ui.frame()).toContain('▸ Django');
    await ui.press('return');
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).toContain(
      '## Framework, if any, and why it over the alternatives.\n\nDjango',
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
    await toStack(ui);
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
    // Help stays on the question when there is nothing simpler to ask; enter
    // on "write my answer", with nothing written, asks again.
    expect(ui.frame()).toContain('▸ ✎ Write my answer');
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
    expect(ui.frame()).toContain('The core terms');
    expect(readFileSync(join(foundationDir(ui.root), 'domain.md'), 'utf8')).not.toContain('skip');
  });

  test('a follow-up can be dismissed as not relevant', async () => {
    const { ask } = elixirAdvisor();
    const ui = await mount(ask);
    await ui.press('return');
    await ui.press('return');
    await toStack(ui);
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
    await toStack(ui);
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
    await toStack(ui);
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
    await ui.type('Lets clinic staff book rooms');
    await ui.press('return');
    await ui.press('c', { ctrl: true });

    expect(ui.frame()).toContain('Ground rules: 1 of 19 answered.');
    await ui.press('n');
    expect(ui.frame()).toContain('Settle the ground rules first');

    // f comes back to the next open question, not the intro.
    await ui.press('f');
    expect(ui.frame()).toContain('The core terms');
  });

  test('tab skips a question, and ← returns to it', async () => {
    const ui = await mount();
    await ui.press('return');
    await ui.press('return');
    await ui.press('tab');
    expect(ui.frame()).toContain('The core terms');
    await ui.press('left');
    expect(ui.frame()).toContain('What the system is for, and who uses it.');
    expect(ui.frame()).toContain('0/19');
  });

  test('skipping every question ends the pass, and the first change can start', async () => {
    // Skipping used to come back round to the skipped questions for ever.
    const ui = await mount();
    await ui.press('return');
    await ui.press('return');
    await ui.type('Lets clinic staff book rooms');
    await ui.press('return');
    for (let i = 1; i < 19; i++) await ui.press('tab');

    expect(ui.frame()).toContain('✓ 1 of 19 ground rules answered.');
    expect(ui.frame()).toContain('18 are left for later — open, but not blocking the first change.');
    await ui.press('return');

    expect(ui.frame()).toContain('Ground rules are set. Next: your first change.');
    expect(foundationGate(ui.root).allowed).toBe(true);
    expect(readFileSync(join(foundationDir(ui.root), 'stack.md'), 'utf8')).toContain(
      '## Language and runtime, with versions.\n\nDecide later',
    );
    await ui.press('n');
    expect(ui.frame()).toContain('What do you want to change, and why?');
  });

  test('ctrl+f finishes early, from any question, and says so in the footer', async () => {
    const ui = await mount();
    await ui.press('return');
    await ui.press('return');
    expect(ui.frame()).toContain('ctrl+f  done — rest later');
    await ui.press('f', { ctrl: true });
    expect(ui.frame()).toContain('✓ 0 of 19 ground rules answered.');
    // ← goes back to answering after all.
    await ui.press('left');
    expect(ui.frame()).toContain('Anything a new contributor reliably gets wrong.');
    await ui.type('done');
    await ui.press('return');
    await ui.press('return');
    expect(ui.frame()).toContain('Ground rules are set. Next: your first change.');
    expect(foundationGate(ui.root).allowed).toBe(true);
  });
});

describe('a new project', () => {
  /**
   * A model that, once it knows the domain, proposes the rest — and is held
   * on everything after it, so what the architecture table derives is seen
   * on its own.
   */
  const domainAdvisor = () => {
    const prompts: string[] = [];
    const ask: Ask = (prompt) => {
      prompts.push(prompt);
      if (prompt.includes('Answer: Lets clinic staff book rooms')) {
        return Promise.resolve({
          followUps: [],
          upcoming: [],
          derived: [
            { question: 'The core terms, each with a one-line meaning.', answer: 'Booking: a room held for a slot.', reason: 'room booking' },
            { question: 'Language and runtime, with versions.', answer: 'TypeScript on Node.js', reason: 'a web app for staff' },
            { question: 'Architecture style (layered, hexagonal, vertical slice, ...) and why.', answer: 'Clean Architecture', reason: 'rules outlive the UI' },
          ],
        });
      }
      return new Promise(() => {});
    };
    return { ask, prompts };
  };

  /** Past the vision without describing one: nothing to propose from but the domain. */
  const withoutVision = async (ui: Awaited<ReturnType<typeof mountApp>>) => {
    await ui.press('return'); // Start → the vision
    await ui.press('n', { ctrl: true }); // skip it → the ground rules
    await ui.press('return'); // Begin
  };

  test('with no vision to go on, is asked its domain first, and the rest is proposed from it', async () => {
    const { ask, prompts } = domainAdvisor();
    const ui = await mountApp({ ask });
    mounted.push(ui);
    await withoutVision(ui);
    expect(ui.frame()).toContain('What the system is for, and who uses it.');
    expect(ui.frame()).toContain('0/11');

    await ui.type('Lets clinic staff book rooms');
    await ui.press('return');
    await ui.settle(100);
    // The advisor was asked to propose the rest from the domain.
    const advised = prompts.find((p) => p.includes('Answer: Lets clinic staff book rooms'))!;
    expect(advised).toContain('- [Stack] Language and runtime, with versions. (propose)');
    expect(advised).toContain('derived\nalso proposes an answer for every open question marked (propose)');

    // Proposed, pre-selected: enter confirms.
    expect(ui.frame()).toContain('The core terms');
    expect(ui.frame()).toContain('▸ ⇐ Booking: a room held for a slot.');
    await ui.press('return');
    expect(ui.frame()).toContain('Language and runtime, with versions.');
    expect(ui.frame()).toContain('▸ ⇐ TypeScript on Node.js');
  });

  test('Clean Architecture decides the import direction, instantly', async () => {
    const { ask } = domainAdvisor();
    const ui = await mountApp({ ask });
    mounted.push(ui);
    await withoutVision(ui);
    await ui.type('Lets clinic staff book rooms');
    await ui.press('return');
    await ui.settle(100);
    while (!ui.frame().includes('Architecture style (layered')) await ui.press('tab');
    expect(ui.frame()).toContain('▸ ⇐ Clean Architecture');
    await ui.press('return');
    // A confirmed proposal moves on at once. The advisor is still thinking
    // about it; the table is not, so what the style decides is already there.

    expect(ui.frame()).toContain('The layers or modules, and which may depend on which.');
    expect(ui.frame()).toContain('▸ ⇐ entities ← use cases ← interface adapters ← frameworks & drivers.');
    expect(ui.frame()).toContain('from your earlier answers: Clean Architecture: the dependency rule it defines');
    await ui.press('return');
    const architecture = readFileSync(join(foundationDir(ui.root), 'architecture.md'), 'utf8');
    expect(architecture).toContain('Dependencies point inward only — frameworks/infrastructure → adapters → use cases → entities');

    expect(ui.frame()).toContain('Where business rules live');
    expect(ui.frame()).toContain('▸ ⇐ In domain/ (entities) and application/ (use cases). No I/O there');
  });

  test('ground rules answered before the vision: the vision starts from what the domain says', async () => {
    const ui = await mountApp({});
    mounted.push(ui);
    await ui.press('return'); // Start → the vision
    await ui.press('c', { ctrl: true }); // back home, and the ground rules from there
    await ui.press('right');
    await ui.press('return');
    await ui.press('return'); // Begin
    await ui.type('Lets clinic staff book rooms');
    await ui.press('return');
    await ui.press('f', { ctrl: true });
    await ui.press('return');

    expect(ui.frame()).toContain('What are you building?');
    expect(ui.frame()).toContain('› Lets clinic staff book rooms');
    expect(ui.frame()).toContain('⇐ from your ground rules (Domain)');
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
    expect(ui.frame()).toContain('the ground rules: domain, stack, architecture, conventions');
    expect(ui.frame()).toContain('ctrl+f         done: leave the open questions for later');
    expect(ui.frame()).toContain('revise it with AI');
    expect(ui.frame()).toContain('ctrl+v         paste the clipboard');
    await ui.press('x');
    expect(ui.frame()).not.toContain('Pipeline marks');
  });
});
