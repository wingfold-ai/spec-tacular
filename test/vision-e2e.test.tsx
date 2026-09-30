/**
 * A new project, by keystroke: describe the vision, be interviewed, review
 * the slices, and land on the first slice's change — then watch its proposal
 * being drafted and read it when it lands.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ask } from '../src/core/advisor.ts';
import { loadRoadmap } from '../src/core/roadmap.ts';
import { mountApp } from './support/app-harness.tsx';

const mounted: { destroy: () => void }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.destroy();
});

const SLICES = {
  vision: 'A booking tool for small clinics, used by receptionists.',
  slices: [
    { id: 'book-a-room', title: 'Book a room', summary: 'A receptionist books a free room.', why: 'The core of it', dependsOn: [] },
    { id: 'see-the-week', title: 'See the week', summary: 'See every booking for the week.', why: 'Needs bookings', dependsOn: ['book-a-room'] },
    { id: 'cancel-bookings', title: 'Cancel bookings', summary: 'Cancel and free the room.', why: 'Needs bookings', dependsOn: ['book-a-room'] },
  ],
};

/** Asks one question, then has enough, then slices. */
const interviewer = (): { ask: Ask; prompts: string[] } => {
  const prompts: string[] = [];
  return {
    prompts,
    ask: async (prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith('Split a new project into slices')) return SLICES;
      const answered = prompt.includes('A: ');
      return {
        understood: answered
          ? 'Receptionists book rooms; patients never touch it.'
          : 'A clinic booking tool.',
        enough: answered,
        question: answered
          ? { ask: '', why: '', options: [] }
          : {
              ask: 'Who books the rooms?',
              why: 'Decides whose screens the first slice needs.',
              options: [
                { label: 'Receptionists', detail: 'staff on the front desk', recommended: true },
                { label: 'Patients', detail: 'self-service', recommended: false },
              ],
            },
      };
    },
  };
};

/** A new project goes from Start straight to its vision: before the ground rules. */
async function atVision(ask: Ask, advisorAsk?: Ask, extra: Parameters<typeof mountApp>[0] = {}) {
  const ui = await mountApp({ visionAsk: ask, ask: advisorAsk, ...extra });
  mounted.push(ui);
  await ui.press('return'); // Start: sets the folder up
  return ui;
}

describe('a new project starts from its vision', () => {
  test('describe → interview → slices → the first slice is the first change', async () => {
    const { ask, prompts } = interviewer();
    const ui = await atVision(ask);

    expect(ui.frame()).toContain('What are you building?');
    expect(ui.frame()).toContain('2. Vision');
    expect(ui.frame()).toContain('3. Ground rules');
    expect(ui.frame()).toContain('Not a new project');

    await ui.type('A booking tool for clinics so rooms are never double-booked');
    await ui.press('return');
    await ui.settle(100);

    // The interview: what it understood, and one question with options.
    expect(prompts[0]).toContain('A booking tool for clinics so rooms are never double-booked');
    expect(prompts[0]).toContain('Ground rules already settled (never ask about these)');
    expect(ui.frame()).toContain('What I understood so far');
    expect(ui.frame()).toContain('A clinic booking tool.');
    expect(ui.frame()).toContain('Who books the rooms?');
    expect(ui.frame()).toContain('▸ Receptionists');

    // Answering — and the model has enough, so it slices straight away.
    await ui.press('return');
    await ui.settle(150);
    expect(prompts.some((p) => p.includes('Q: Who books the rooms?\nA: Receptionists'))).toBe(true);
    expect(ui.frame()).toContain('Your roadmap — review the slices');
    expect(ui.frame()).toContain('1. Book a room');
    expect(ui.frame()).toContain('3. Cancel bookings');

    // Drop one, then create the roadmap.
    await ui.press('down');
    await ui.press('down');
    await ui.press('space');
    expect(ui.frame()).toContain('[ ]');
    await ui.press('return');
    await ui.settle(100);

    expect(ui.created).toEqual([{
      name: 'book-a-room',
      description: 'Book a room: A receptionist books a free room.\n\nWhy now: The core of it',
    }]);
    const roadmap = loadRoadmap(ui.root)!;
    expect(roadmap.slices.map((s) => [s.id, s.status])).toEqual([
      ['book-a-room', 'active'],
      ['see-the-week', 'planned'],
    ]);
    const vision = readFileSync(join(ui.root, 'spec-tacular', 'vision.md'), 'utf8');
    expect(vision).toContain('A booking tool for small clinics, used by receptionists.');
    expect(vision).toContain('**Who books the rooms?**\n\nReceptionists');

    // Then the ground rules — the vision came first so they build on it.
    expect(ui.frame()).toContain('Roadmap saved: 2 slices, first up: Book a room. Now the ground rules');
    expect(ui.frame()).toContain('Ground rules');
    ui.settleGroundRules();
    await ui.press('c', { ctrl: true });

    // On the overview: the change, its next step, and the roadmap.
    expect(ui.frame()).toContain('◉ book-a-room');
    expect(ui.frame()).toContain('○ see-the-week');
    expect(ui.frame()).toContain('Write the proposal');
  });

  test('an option shows its whole answer, and ctrl+r revises it with AI before it is given', async () => {
    const prompts: string[] = [];
    const ask: Ask = async (prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith('Split a new project into slices')) return SLICES;
      const answered = prompt.includes('A: ');
      return answered
        ? { understood: 'Receptionists book rooms.', enough: true, question: { ask: '', why: '', options: [] } }
        : {
            understood: 'A clinic booking tool.',
            enough: false,
            question: {
              ask: 'Who books the rooms?',
              why: 'Decides whose screens the first slice needs.',
              options: [{
                label: 'Receptionists',
                detail: 'staff on the front desk',
                answer: 'Receptionists book rooms for patients at the front desk.\nPatients never log in.',
                recommended: true,
              }],
            },
          };
    };
    const calls: { current: string; instruction: string; ask: string }[] = [];
    const ui = await atVision(ask, undefined, {
      reviseVisionAnswer: {
        unavailable: null,
        propose: async (session, current, _turns, instruction) => {
          calls.push({ current, instruction, ask: session.pending!.ask });
          return { block: 'Receptionists and nurses book rooms.\nPatients never log in.', summary: 'Added nurses', warnings: [] };
        },
      },
    });
    await ui.type('A booking tool for clinics so rooms are never double-booked');
    await ui.press('return');
    await ui.settle(100);

    // The highlighted option in full, under the list.
    expect(ui.frame()).toContain('▸ Receptionists');
    expect(ui.frame()).toContain('picking answers this');
    expect(ui.frame()).toContain('Patients never log in.');

    await ui.press('r', { ctrl: true });
    expect(ui.frame()).toContain('Revise with AI: Who books the rooms?');
    expect(ui.frame()).toContain('The answer as it is now');
    expect(ui.frame()).toContain('Receptionists book rooms for patients at the front desk.');
    await ui.type('nurses book too');
    await ui.press('return');
    await ui.settle(100);
    expect(calls).toEqual([{
      current: 'Receptionists book rooms for patients at the front desk.\nPatients never log in.',
      instruction: 'nurses book too',
      ask: 'Who books the rooms?',
    }]);
    expect(ui.frame()).toContain('Added nurses');

    // Accepted is answered: the interview goes on with the revised answer.
    await ui.press('a');
    await ui.settle(150);
    expect(prompts.some((p) => p.includes('Q: Who books the rooms?\nA: Receptionists and nurses book rooms.\nPatients never log in.'))).toBe(true);
    expect(ui.frame()).toContain('Your roadmap — review the slices');
  });

  test('many slices on a small terminal scroll instead of being drawn over each other', async () => {
    const many = {
      vision: 'A booking tool for small clinics.',
      slices: Array.from({ length: 8 }, (_, i) => ({
        id: `slice-number-${i + 1}`,
        title: `Slice ${i + 1} title`,
        summary: `Summary ${i + 1}: a receptionist can do something end to end.`,
        why: `Why ${i + 1}: it builds on the one before.`,
        dependsOn: i === 0 ? [] : [`slice-number-${i}`],
      })),
    };
    const ask: Ask = async (p) =>
      p.startsWith('Split a new project') ? many : { understood: 'x', enough: true, question: { ask: '', why: '', options: [] } };
    const ui = await mountApp({ visionAsk: ask, width: 100, height: 30 });
    mounted.push(ui);
    await ui.press('return');
    await ui.type('A booking tool for clinics so rooms are never double-booked');
    await ui.press('return');
    await ui.settle(200);

    // Each line whole: squeezed rows used to share a line, their characters mixed.
    const lines = ui.frame().split('\n');
    expect(lines.some((l) => l.includes('✓ Set up  ──  2. Vision'))).toBe(true);
    expect(lines.some((l) => l.includes('[✓] 1. Slice 1 title   slice-number-1'))).toBe(true);
    expect(lines.some((l) => l.includes('Summary 1: a receptionist can do something end to end.'))).toBe(true);
    expect(ui.frame()).toContain('▶ Create the roadmap');

    // The selection is followed into the part that was scrolled away.
    for (let i = 0; i < 7; i++) await ui.press('down');
    expect(ui.frame()).toContain('8. Slice 8 title');
  });

  test('questions can be skipped, and "done" ends the interview', async () => {
    let asked = 0;
    const ui = await atVision(async (prompt) => {
      if (prompt.startsWith('Split a new project')) return SLICES;
      asked++;
      return { understood: 'x', enough: false, question: { ask: `Question ${asked}?`, why: '', options: [] } };
    });
    await ui.type('A booking tool for clinics so rooms are never double-booked');
    await ui.press('return');
    await ui.settle(50);
    expect(ui.frame()).toContain('Question 1?');
    await ui.press('tab');
    await ui.settle(50);
    expect(ui.frame()).toContain('Question 2?');
    await ui.type('done');
    await ui.press('return');
    await ui.settle(100);
    expect(ui.frame()).toContain('Your roadmap — review the slices');
    expect(asked).toBe(2);
  });

  test('Skip is the first choice on every question, never the default', async () => {
    const prompts: string[] = [];
    const ui = await atVision(async (prompt) => {
      prompts.push(prompt);
      return {
        understood: 'x',
        enough: false,
        question: {
          ask: `Question ${prompts.length}?`,
          why: '',
          options: [{ label: 'Receptionists', detail: 'front desk', recommended: true }],
        },
      };
    });
    await ui.type('A booking tool for clinics so rooms are never double-booked');
    await ui.press('return');
    await ui.settle(50);
    const lines = ui.frame().split('\n');
    const at = (text: string) => lines.findIndex((l) => l.includes(text));
    expect(at('↷ Skip this question')).toBeGreaterThan(-1);
    expect(at('↷ Skip this question')).toBeLessThan(at('Receptionists'));
    expect(ui.frame()).toContain('▸ Receptionists');

    await ui.press('up');
    expect(ui.frame()).toContain('▸ ↷ Skip this question');
    await ui.press('return');
    await ui.settle(50);
    expect(ui.frame()).toContain('Question 2?');
    expect(prompts[1]).toContain('Q: Question 1?\nA: (skipped');
  });

  test('not a new project: the ground rules, then straight to describing a single change', async () => {
    const ui = await atVision(interviewer().ask);
    await ui.press('n', { ctrl: true });
    // No vision to propose from: the ground rules are asked, domain first.
    expect(ui.frame()).toContain('Before the first change, settle the ground rules.');
    // And the vision is not offered again.
    expect(existsSync(join(ui.root, '.spec-tacular', 'vision-session.json'))).toBe(true);
    ui.settleGroundRules();
    await ui.press('c', { ctrl: true });
    await ui.press('n');
    expect(ui.frame()).toContain('What do you want to change, and why?');
  });

  test('the ground rules are proposed from the vision, the domain as much as the stack', async () => {
    const advisorPrompts: string[] = [];
    const ui = await atVision(interviewer().ask, async (prompt) => {
      advisorPrompts.push(prompt);
      if (!prompt.includes('The developer described the project in the vision above')) {
        return { followUps: [], upcoming: [], derived: [] };
      }
      return {
        followUps: [],
        upcoming: [],
        derived: [
          { question: 'What the system is for, and who uses it.', answer: 'Room booking for small clinics, used by receptionists.', reason: 'the vision' },
          { question: 'Language and runtime, with versions.', answer: 'TypeScript on Node.js LTS.', reason: 'a web tool' },
        ],
      };
    });
    await ui.type('A booking tool for clinics so rooms are never double-booked');
    await ui.press('return');
    await ui.settle(100);
    await ui.press('return'); // answer the interview's question
    await ui.settle(150);

    // Proposed as soon as the interview ended: while the roadmap is still
    // being reviewed, before the ground rules open.
    expect(ui.frame()).toContain('Your roadmap — review the slices');
    const fromVision = advisorPrompts.find((p) => p.includes('The developer described the project in the vision above'))!;
    expect(fromVision).toContain("The project's vision");
    expect(fromVision).toContain('Receptionists book rooms; patients never touch it.');
    expect(fromVision).toContain('**Who books the rooms?**\n\nReceptionists');

    await ui.press('return'); // create the roadmap
    await ui.settle(150);
    // Not asked twice: the ground rules open on what is already proposed.
    expect(advisorPrompts.filter((p) => p.includes('The developer described the project in the vision above'))).toHaveLength(1);
    expect(ui.frame()).toContain('2 ground rules proposed from your vision');

    // The first question — the domain — already has its answer proposed.
    await ui.press('return'); // Begin
    expect(ui.frame()).toContain('What the system is for, and who uses it.');
    expect(ui.frame()).toContain('⇐ Room booking for small clinics, used by receptionists.');
  });
});

describe('an agent’s draft', () => {
  test('is watched while it is written, then opens to be read', async () => {
    const ui = await mountApp({ baseline: true });
    mounted.push(ui);
    await ui.press('return');
    ui.settleGroundRules();
    await ui.press('c', { ctrl: true });
    await ui.press('n');
    await ui.type('Let users book rooms');
    await ui.press('return');
    await ui.press('return'); // accept the proposed name

    await ui.press('return'); // ✦ Let an agent draft it
    expect(ui.dispatched).toEqual(['book-rooms/proposal']);
    await ui.settle(50);
    expect(ui.frame()).toContain('Claude Code is drafting the proposal');
    expect(ui.frame()).toContain('reading the ground rules');
    expect(ui.frame()).toContain('It opens here for you to read when it is done');

    ui.finishJob('book-rooms', 'proposal', '# book-rooms\n\n## Why\n\nClinics double-book rooms.\n\n## What Changes\n\n- Add booking\n');
    await ui.settle(2300); // the job poll

    expect(ui.frame()).toContain('book-rooms › proposal');
    expect(ui.frame()).toContain('Clinics double-book rooms.');
    expect(ui.frame()).toContain('• Add booking');
    // The same keys as everywhere: a accepts, r revises, ctrl+e edits.
    expect(ui.frame()).toContain('✓ Accept — draft the specs  a');
    expect(ui.frame()).toContain('↻ Redraft with feedback  r');
    expect(ui.frame()).toContain('✎ Edit it  ctrl+e');

    // Feedback goes back to the agent.
    await ui.press('r');
    await ui.type('mention cancellations');
    await ui.press('return');
    await ui.settle(50);
    expect(ui.dispatched.at(-1)).toBe('book-rooms/proposal (mention cancellations)');
  });

  test('accepting it ticks it off and drafts the next artifact, and v reads it again', async () => {
    const ui = await mountApp({ baseline: true });
    mounted.push(ui);
    await ui.press('return');
    ui.settleGroundRules();
    await ui.press('c', { ctrl: true });
    await ui.press('n');
    await ui.type('Let users book rooms');
    await ui.press('return');
    await ui.press('return');
    await ui.press('return');
    ui.finishJob('book-rooms', 'proposal', '# Proposal\n\nBody.\n');
    await ui.settle(2300);

    await ui.press('a'); // ✓ Accept — draft the specs
    await ui.settle(50);
    expect(ui.dispatched.at(-1)).toBe('book-rooms/specs');
    expect(ui.frame()).toContain('Claude Code is drafting the specs');
    expect(ui.frame()).toContain('✓ proposal');

    // Read again once accepted, there is nothing left to accept.
    await ui.press('v');
    await ui.settle(50);
    expect(ui.frame()).toContain('book-rooms › proposal');
    expect(ui.frame()).not.toContain('✓ Accept');
    expect(ui.frame()).toContain('✓ Looks good');
  });

  test('a proposal left unread is the next step, and blocks the specs', async () => {
    const ui = await mountApp({ baseline: true });
    mounted.push(ui);
    await ui.press('return');
    ui.settleGroundRules();
    await ui.press('c', { ctrl: true });
    await ui.press('n');
    await ui.type('Let users book rooms');
    await ui.press('return');
    await ui.press('return');
    await ui.press('return');
    ui.finishJob('book-rooms', 'proposal', '# Proposal\n\nBody.\n');
    await ui.settle(2300);

    await ui.press('q'); // not now
    await ui.settle(50);
    expect(ui.frame()).toContain('● proposal');
    expect(ui.frame()).toContain('Read the proposal, then accept it or ask for changes.');
    expect(ui.frame()).toContain('▶ Read the proposal');
    await ui.press('w'); // drafting the specs is not open yet
    expect(ui.dispatched).toEqual(['book-rooms/proposal']);

    await ui.press('return'); // ▶ Read the proposal
    expect(ui.frame()).toContain('✓ Accept — draft the specs');
  });
});
