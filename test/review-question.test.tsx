/**
 * A question a formal form forced, on the review screen: the agent's answer
 * shown as a proposal, `a` accepts it, and `r` revises the requirement that
 * asked it, with the developer's answer started for them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { withQuestions } from '../src/core/questions.ts';
import { parseSpecFile, type Requirement } from '../src/core/requirements.ts';
import { emptyReview } from '../src/core/review.ts';
import { decide, move, openSession, skip, type ReviewSession } from '../src/core/session.ts';
import { ReviewScreen } from '../src/tui/review.tsx';

const SPEC = `## ADDED Requirements

### Requirement: Participants default to every member
The system SHALL make every member a participant when none are given.

\`\`\`formal
decision: participants_all_members = NOT participants_given
asked: Does an empty participants list mean "everyone" or is it invalid? — It means everyone.
\`\`\`

#### Scenario: none given
- **WHEN** an expense is recorded without participants
- **THEN** every member shares it
`;

const open: { destroy: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.destroy();
});

async function mount() {
  const items = withQuestions(parseSpecFile(SPEC, 'expenses', '/p/spec.md').requirements);
  const [session, setSession] = createSignal<ReviewSession>(openSession('c', items, emptyReview('c')));
  const revised: Requirement[] = [];
  const setup = await testRender(
    () => (
      <ReviewScreen
        session={session()}
        onAccept={() => setSession((s) => decide(s, 'accepted'))}
        onReject={(note) => setSession((s) => decide(s, 'rejected', { note }))}
        onDefer={(reason) => setSession((s) => decide(s, 'deferred', { deferReason: reason }))}
        onSkip={() => setSession((s) => skip(s))}
        onEdit={() => {}}
        onMove={(d) => setSession((s) => move(s, d))}
        onBack={() => {}}
        refine={{
          unavailable: null,
          current: (item) => {
            revised.push(item as Requirement);
            return { ok: true, block: `### Requirement: ${item.name}` };
          },
          propose: async () => ({ block: '', summary: '', warnings: [] }),
          accept: () => ({ ok: true }),
        }}
      />
    ),
    { width: 120, height: 40 },
  );
  open.push({ destroy: () => setup.renderer.destroy() });
  await setup.flush();
  const press = async (...keys: string[]) => {
    for (const k of keys) await setup.mockInput.pressKey(k);
    await setup.flush();
  };
  return { frame: () => setup.captureCharFrame(), press, session, revised };
}

describe('a question on the review screen', () => {
  test('comes first, with the agent\'s answer as a proposal', async () => {
    const ui = await mount();
    const frame = ui.frame();
    expect(frame).toContain('question 1 of 2');
    expect(frame).toContain('Does an empty participants list mean "everyone" or is it invalid?');
    expect(frame).toContain('Proposed answer: It means everyone.');
    expect(frame).toContain('a — that is the answer');
  });

  test('r revises the requirement that asked it, with the answer started', async () => {
    const ui = await mount();
    await ui.press('r');
    expect(ui.revised.map((r) => r.name)).toEqual(['Participants default to every member']);
    expect(ui.frame()).toContain('The answer to “Does an empty participants list mean "everyone" or is it invalid?” is:');
  });

  test('a accepts the proposed answer and moves on to the requirement', async () => {
    const ui = await mount();
    await ui.press('a');
    expect(ui.frame()).toContain('Requirement: Participants default to every member');
  });
});
