import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext, renderContext } from '../src/core/context.ts';
import { loadRoadmap } from '../src/core/roadmap.ts';
import {
  buildInterviewPrompt,
  finalizeVision,
  MAX_TURNS,
  parseInterview,
  parseSlices,
  VisionInterviewer,
  type ProposedSlice,
} from '../src/core/vision.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-vision-'));
  dirs.push(d);
  mkdirSync(join(d, 'openspec', 'changes'), { recursive: true });
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const slice = (id: string, dependsOn: string[] = []): ProposedSlice => ({
  id, title: id, summary: `do ${id}`, why: '', dependsOn,
});

describe('the interview', () => {
  test('an empty question means enough, whatever the flag says', () => {
    expect(parseInterview({ understood: 'u', enough: false, question: { ask: '', why: '', options: [] } }))
      .toEqual({ understood: 'u', enough: true, question: null });
    expect(parseInterview(null).enough).toBe(true);
  });

  test('records answers and skips, and carries them into the next prompt', async () => {
    const r = root();
    const prompts: string[] = [];
    const interviewer = new VisionInterviewer(r, async (prompt) => {
      prompts.push(prompt);
      return { understood: 'u', enough: false, question: { ask: `Q${prompts.length}?`, why: '', options: [] } };
    });
    await interviewer.start('A clinic booking tool');
    await interviewer.answer('Receptionists');
    const session = await interviewer.answer(null);

    expect(session.turns).toEqual([
      { ask: 'Q1?', answer: 'Receptionists' },
      { ask: 'Q2?', answer: null },
    ]);
    expect(prompts[2]).toContain('Q: Q1?\nA: Receptionists');
    expect(prompts[2]).toContain('Q: Q2?\nA: (skipped');
    expect(session.pending?.ask).toBe('Q3?');
  });

  test('stops asking after the cap, however unsure the model is', async () => {
    const r = root();
    const interviewer = new VisionInterviewer(r, async () => ({
      understood: 'u', enough: false, question: { ask: 'More?', why: '', options: [] },
    }));
    await interviewer.start('x'.repeat(20));
    let session = interviewer.session()!;
    for (let i = 0; i < MAX_TURNS; i++) session = await interviewer.answer('yes');
    expect(session.finished).toBe(true);
    expect(session.pending).toBeNull();
  });

  test('the prompt never asks about settled ground rules', () => {
    const prompt = buildInterviewPrompt(root(), {
      vision: 'V', turns: [], understood: '', pending: null, finished: false, slices: [],
    });
    expect(prompt).toContain('Ground rules already settled (never ask about these)');
    expect(prompt).toContain('Prefer ending early');
  });
});

describe('slices', () => {
  test('only valid, unique names, depending only on earlier slices', () => {
    const { slices } = parseSlices({
      vision: 'v',
      slices: [
        { id: 'Book A Room', title: 'Book', summary: 's', why: 'w', dependsOn: ['see-week'] },
        { id: 'see-week', title: 'See', summary: 's', why: 'w', dependsOn: ['book-a-room', 'nope'] },
        { id: 'see-week', title: 'Again', summary: 's', why: 'w', dependsOn: [] },
        { id: '!!!', title: 'Bad', summary: 's', why: 'w', dependsOn: [] },
      ],
    }, ['taken']);
    expect(slices.map((s) => [s.id, s.dependsOn])).toEqual([
      ['book-a-room', []],
      ['see-week', ['book-a-room']],
      ['see-week-2', []],
    ]);
  });

  test('finalizing writes the vision and roadmap, and activates the first slice', () => {
    const r = root();
    const session = {
      vision: 'my words', turns: [{ ask: 'Who?', answer: 'Staff' }, { ask: 'Skipped?', answer: null }],
      understood: 'u', pending: null, finished: true, slices: [],
    };
    const first = finalizeVision(r, session, 'The refined vision.', [
      slice('book-room'),
      slice('see-week', ['book-room', 'dropped-one']),
    ]);
    expect(first?.id).toBe('book-room');
    const roadmap = loadRoadmap(r)!;
    expect(roadmap.vision).toBe('The refined vision.');
    expect(roadmap.slices.map((s) => [s.id, s.status, s.dependsOn])).toEqual([
      ['book-room', 'active', []],
      ['see-week', 'planned', ['book-room']],
    ]);

    const vision = readFileSync(join(r, 'spec-tacular', 'vision.md'), 'utf8');
    expect(vision).toContain('The refined vision.');
    expect(vision).toContain("## In the developer's words\n\nmy words");
    expect(vision).toContain('**Who?**\n\nStaff');
    expect(vision).not.toContain('Skipped?');

    // And every agent now reads it.
    expect(renderContext(buildContext(r, []))).toContain('# Product vision');
    expect(renderContext(buildContext(r, []))).toContain('The refined vision.');
  });
});
