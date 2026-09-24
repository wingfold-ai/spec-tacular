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

async function atVision(ask: Ask) {
  const ui = await mountApp({ visionAsk: ask });
  mounted.push(ui);
  await ui.press('return'); // Start: sets the folder up
  ui.settleGroundRules();
  await ui.press('c', { ctrl: true }); // leave the ground rules: all answered
  return ui;
}

describe('a new project starts from its vision', () => {
  test('describe → interview → slices → the first slice is the first change', async () => {
    const { ask, prompts } = interviewer();
    const ui = await atVision(ask);

    expect(ui.frame()).toContain('What are you building?');
    expect(ui.frame()).toContain('3. Vision');
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

    // On the overview: the change, its next step, and the roadmap.
    expect(ui.frame()).toContain('Roadmap saved: 2 slices. First up: Book a room.');
    expect(ui.frame()).toContain('◉ book-a-room');
    expect(ui.frame()).toContain('○ see-the-week');
    expect(ui.frame()).toContain('Write the proposal');
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

  test('not a new project: straight to describing a single change', async () => {
    const ui = await atVision(interviewer().ask);
    await ui.press('n', { ctrl: true });
    expect(ui.frame()).toContain('What do you want to change, and why?');
    // And it is not offered again.
    expect(existsSync(join(ui.root, '.spec-tacular', 'vision-session.json'))).toBe(true);
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
    expect(ui.frame()).toContain('✓ Looks good — draft the specs');
    expect(ui.frame()).toContain('↻ Redraft with feedback');

    // Feedback goes back to the agent.
    await ui.press('f');
    await ui.type('mention cancellations');
    await ui.press('return');
    await ui.settle(50);
    expect(ui.dispatched.at(-1)).toBe('book-rooms/proposal (mention cancellations)');
  });

  test('"looks good" drafts the next artifact, and v reads it again', async () => {
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

    await ui.press('return'); // ✓ Looks good — draft the specs
    await ui.settle(50);
    expect(ui.dispatched.at(-1)).toBe('book-rooms/specs');
    expect(ui.frame()).toContain('Claude Code is drafting the specs');

    await ui.press('v');
    await ui.settle(50);
    expect(ui.frame()).toContain('book-rooms › proposal');
  });
});
