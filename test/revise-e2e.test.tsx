/**
 * `e` on the review screen: revising a requirement with the agent, driven by
 * keystroke against a real spec file on disk and a fake agent. Also copy and
 * paste there, through a fake clipboard: ctrl+v, the terminal's bracketed
 * paste, and `y`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptRefinement,
  parseRefinement,
  readRequirementBlock,
  refineContext,
  type RefineTurn,
  type Refinement,
} from '../src/core/refine.ts';
import { capabilityFromPath, parseSpecFile, type Requirement } from '../src/core/requirements.ts';
import { emptyReview } from '../src/core/review.ts';
import { decide, move, openSession, skip, type ReviewSession } from '../src/core/session.ts';
import type { ClipboardPort } from '../src/tui/clipboard.ts';
import { ClipboardProvider, type ClipboardContextValue } from '../src/tui/copy-paste.ts';
import { ReviewScreen } from '../src/tui/review.tsx';

const SPEC = `## ADDED Requirements

### Requirement: Session timeout
The system SHALL end an idle session after {{example: 30 minutes}}.

#### Scenario: Idle user
- **WHEN** a user is idle for the timeout
- **THEN** their session ends

### Requirement: Remember me
The system SHALL keep a session across restarts when asked to.

#### Scenario: Returning user
- **WHEN** a user who ticked "remember me" comes back
- **THEN** they are still signed in
`;

const ROUNDS = [
  `### Requirement: Session timeout
The system SHALL end an idle session after a configurable timeout.

#### Scenario: Idle user
- **WHEN** a user is idle for the configured timeout
- **THEN** their session ends`,
  `### Requirement: Session timeout
The system SHALL end an idle session after a configurable timeout, {{example: 30 minutes}} by default.

#### Scenario: Idle user
- **WHEN** a user is idle for the configured timeout
- **THEN** their session ends

#### Scenario: Default timeout
- **WHEN** no timeout is configured
- **THEN** the default applies`,
];

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function project() {
  const root = mkdtempSync(join(tmpdir(), 'spectacular-revise-'));
  const changeRoot = join(root, 'openspec', 'changes', 'c');
  const dir = join(changeRoot, 'specs', 'auth');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'spec.md');
  writeFileSync(file, SPEC);
  writeFileSync(join(changeRoot, 'proposal.md'), '## Why\n\nSessions end too soon.\n');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { file, changeRoot };
}

/** A clipboard that is a variable. */
function fakeClipboard(initial = '') {
  const state = { content: initial, writes: [] as string[], notices: [] as string[] };
  const clipboard: ClipboardPort = {
    read: async () => ({ ok: true, text: state.content }),
    write: async (text) => {
      state.writes.push(text);
      state.content = text;
      return { ok: true, via: 'fake' };
    },
  };
  const value: ClipboardContextValue = { clipboard, notify: (m) => state.notices.push(m) };
  return { state, value };
}

/** The review screen as the app wires it, with an agent that answers from `answer`. */
async function mount(options: {
  answer?: (turns: RefineTurn[], instruction: string) => Promise<Refinement> | Refinement;
  unavailable?: string | null;
  clipboard?: string;
  before?: (session: ReviewSession) => ReviewSession;
} = {}) {
  const { file, changeRoot } = project();
  const parse = () => parseSpecFile(readFileSync(file, 'utf8'), capabilityFromPath(file), file).requirements;
  const initial = openSession('c', parse(), emptyReview('c'));
  const [session, setSession] = createSignal(options.before ? options.before(initial) : initial);
  const asked: { turns: RefineTurn[]; instruction: string; prompt: string }[] = [];
  let edited = 0;
  let back = 0;
  const clip = fakeClipboard(options.clipboard);

  const answer = options.answer ?? ((turns: RefineTurn[]) => ({
    block: ROUNDS[Math.min(turns.length, ROUNDS.length - 1)]!,
    summary: `Round ${turns.length + 1}.`,
    warnings: [],
  }));

  const setup = await testRender(
    () => (
      <ClipboardProvider value={clip.value}>
        <ReviewScreen
          session={session()}
          onAccept={() => setSession((s) => decide(s, 'accepted'))}
          onReject={(note) => setSession((s) => decide(s, 'rejected', { note }))}
          onDefer={(reason) => setSession((s) => decide(s, 'deferred', { deferReason: reason }))}
          onSkip={() => setSession((s) => skip(s))}
          onMove={(d) => setSession((s) => move(s, d))}
          onEdit={() => { edited++; }}
          onBack={() => { back++; }}
          refine={{
            unavailable: options.unavailable ?? null,
            current: (item) => readRequirementBlock(item),
            propose: async (item, turns, instruction) => {
              // The same context the real agent gets, so it is exercised too.
              const context = refineContext(changeRoot, item);
              asked.push({ turns: [...turns], instruction, prompt: context.spec });
              const r = await answer(turns, instruction);
              return parseRefinement({ requirement: r.block, summary: r.summary }, context);
            },
            accept: (item: Requirement, block) => {
              const result = acceptRefinement(session(), item, block, parse);
              if (result.ok) setSession(result.session);
              return result;
            },
          }}
        />
      </ClipboardProvider>
    ),
    { width: 110, height: 44, exitOnCtrlC: false },
  );
  cleanups.push(() => setup.renderer.destroy());

  const settle = async () => {
    await new Promise((r) => setTimeout(r, 15));
    await setup.flush();
  };
  await setup.flush();
  return {
    file,
    session,
    asked,
    clip: clip.state,
    edited: () => edited,
    back: () => back,
    frame: () => setup.captureCharFrame(),
    press: async (key: string, mods?: { ctrl?: boolean; shift?: boolean; meta?: boolean }) => {
      setup.mockInput.pressKey(key as never, mods);
      await settle();
    },
    type: async (text: string) => {
      for (const ch of text) setup.mockInput.pressKey(ch);
      await settle();
    },
    paste: async (text: string) => {
      await setup.mockInput.pasteBracketedText(text);
      await settle();
    },
    settle,
  };
}

describe('e: revising a requirement with the agent', () => {
  test('prompt, proposal as a diff, accept: only that requirement is rewritten', async () => {
    const ui = await mount();
    await ui.press('e');
    expect(ui.frame()).toContain('Revise with AI: Session timeout');
    expect(ui.frame()).toContain('How should this requirement change?');

    await ui.type('make the timeout configurable');
    await ui.press('RETURN');
    expect(ui.asked).toHaveLength(1);
    expect(ui.asked[0]!.instruction).toBe('make the timeout configurable');

    const frame = ui.frame();
    expect(frame).toContain('✦ Round 1.');
    expect(frame).toContain('- The system SHALL end an idle session after {{example: 30 minutes}}.');
    expect(frame).toContain('+ The system SHALL end an idle session after a configurable timeout.');
    expect(frame).toContain('accept — write it');
    // Nothing is written before accepting.
    expect(readFileSync(ui.file, 'utf8')).toBe(SPEC);

    await ui.press('a');
    const after = readFileSync(ui.file, 'utf8');
    expect(after).toBe(SPEC.replace(/### Requirement: Session timeout[\s\S]*?their session ends/, ROUNDS[0]!));
    expect(ui.frame()).toContain('pending again');
    expect(ui.frame()).toContain('a configurable timeout');
    expect(ui.session().items[0]!.state).toBe('pending');
  });

  test('iterates as often as asked; each round sees the ones before', async () => {
    const ui = await mount();
    await ui.press('e');
    await ui.type('make the timeout configurable');
    await ui.press('RETURN');
    await ui.press('i');
    expect(ui.frame()).toContain('What else should change?');
    await ui.type('add a default scenario');
    await ui.press('RETURN');
    await ui.press('i');
    await ui.type('keep it');
    await ui.press('RETURN');

    expect(ui.asked.map((a) => a.turns.length)).toEqual([0, 1, 2]);
    expect(ui.asked[2]!.turns.map((t) => t.instruction)).toEqual(['make the timeout configurable', 'add a default scenario']);
    expect(ui.asked[2]!.turns[0]!.revised).toBe(ROUNDS[0]!);
    expect(ui.frame()).toContain('round 3');
    expect(ui.frame()).toContain('+ #### Scenario: Default timeout');

    await ui.press('a');
    expect(readFileSync(ui.file, 'utf8')).toContain('#### Scenario: Default timeout');
    expect(readFileSync(ui.file, 'utf8')).toContain('### Requirement: Remember me\nThe system SHALL keep');
  });

  test('d discards the proposal and leaves the file alone', async () => {
    const ui = await mount();
    await ui.press('e');
    await ui.type('make it configurable');
    await ui.press('RETURN');
    await ui.press('d');
    expect(readFileSync(ui.file, 'utf8')).toBe(SPEC);
    expect(ui.frame()).toContain('Revision discarded');
    expect(ui.frame()).toContain('Requirement: Session timeout');
    expect(ui.back()).toBe(0);
  });

  test('ctrl+c while the agent works cancels back to the requirement, and a late answer is ignored', async () => {
    let release!: (r: Refinement) => void;
    const ui = await mount({ answer: () => new Promise<Refinement>((r) => (release = r)) });
    await ui.press('e');
    await ui.type('make it configurable');
    await ui.press('RETURN');
    expect(ui.frame()).toContain('The agent is revising it');

    await ui.press('c', { ctrl: true });
    expect(ui.frame()).toContain('Revision cancelled');
    expect(ui.frame()).toContain('Requirement: Session timeout');
    expect(ui.back()).toBe(0);

    release({ block: ROUNDS[0]!, summary: 'late', warnings: [] });
    await ui.settle();
    expect(ui.frame()).not.toContain('late');
    expect(readFileSync(ui.file, 'utf8')).toBe(SPEC);
  });

  test('ctrl+c on the prompt of a later round goes back to the proposal, not out', async () => {
    const ui = await mount();
    await ui.press('e');
    await ui.type('make it configurable');
    await ui.press('RETURN');
    await ui.press('i');
    await ui.press('c', { ctrl: true });
    expect(ui.frame()).toContain('✦ Round 1.');
    expect(ui.frame()).toContain('accept — write it');
  });

  test('a failed round says why, and enter asks again', async () => {
    let fail = true;
    const ui = await mount({
      answer: (turns) => {
        if (fail) {
          fail = false;
          throw new Error('agent went away');
        }
        return { block: ROUNDS[0]!, summary: 'ok', warnings: [] };
      },
    });
    await ui.press('e');
    await ui.type('make it configurable');
    await ui.press('RETURN');
    expect(ui.frame()).toContain('Could not revise it: agent went away');
    await ui.press('RETURN');
    expect(ui.asked.map((a) => a.instruction)).toEqual(['make it configurable', 'make it configurable']);
    expect(ui.frame()).toContain('✦ ok');
  });

  test('an answer that is not one requirement is refused, not written', async () => {
    const ui = await mount({ answer: () => ({ block: `${ROUNDS[0]}\n\n### Requirement: Extra\nIt SHALL.`, summary: '', warnings: [] }) });
    await ui.press('e');
    await ui.type('x');
    await ui.press('RETURN');
    expect(ui.frame()).toContain('holds 2 requirements');
    expect(readFileSync(ui.file, 'utf8')).toBe(SPEC);
  });

  test('without an agent, says so, and E still opens the editor', async () => {
    const ui = await mount({ unavailable: 'turned off by SPECTACULAR_NO_ADVISOR' });
    await ui.press('e');
    expect(ui.frame()).toContain('No AI to revise with: turned off by SPECTACULAR_NO_ADVISOR');
    expect(ui.frame()).toContain('E opens the requirement in your editor');
    await ui.press('x'); // any key closes
    expect(ui.frame()).toContain('a accept');
    await ui.press('E');
    expect(ui.edited()).toBe(1);
    await ui.press('e', { ctrl: true });
    expect(ui.edited()).toBe(2);
  });

  test('a rejected requirement starts the prompt from why it was rejected', async () => {
    const ui = await mount({ before: (s) => decide(s, 'rejected', { note: 'the timeout must be configurable' }) });
    await ui.press('p'); // decide moved on; back to it
    await ui.press('e');
    expect(ui.frame()).toContain('› the timeout must be configurable');
    await ui.press('RETURN');
    expect(ui.asked[0]!.instruction).toBe('the timeout must be configurable');
    await ui.press('a');
    const revised = ui.session().items[0]!;
    expect(revised.state).toBe('pending');
    expect(revised.review.note).toBeUndefined();
  });

  test('accepting a revision keeps the other requirements’ decisions', async () => {
    const ui = await mount({ before: (s) => decide(move(s, 1), 'accepted') });
    await ui.press('e'); // decide wrapped round to the first, still open
    await ui.type('make it configurable');
    await ui.press('RETURN');
    await ui.press('a');
    const [revised, other] = ui.session().items;
    expect(revised!.state).toBe('pending');
    expect(other!.state).toBe('accepted');
    expect(other!.drifted).toBe(false);
  });
});

describe('copy and paste on the review screen', () => {
  test('ctrl+v pastes the clipboard into the revise prompt, lines kept', async () => {
    const ui = await mount({ clipboard: 'split it into\ntwo scenarios' });
    await ui.press('e');
    await ui.press('v', { ctrl: true });
    expect(ui.frame()).toContain('› split it into');
    expect(ui.frame()).toContain('two scenarios');
    expect(ui.asked).toHaveLength(0);
    await ui.press('RETURN');
    expect(ui.asked[0]!.instruction).toBe('split it into\ntwo scenarios');
  });

  test('a multi-line terminal paste lands whole and does not send', async () => {
    const ui = await mount();
    await ui.press('e');
    await ui.paste('first line\nsecond line\n');
    expect(ui.asked).toHaveLength(0);
    expect(ui.frame()).toContain('first line');
    expect(ui.frame()).toContain('second line');
    await ui.type(' more');
    await ui.press('RETURN');
    expect(ui.asked[0]!.instruction).toBe('first line\nsecond line\n more');
  });

  test('alt+enter or a trailing backslash starts a new line instead of sending', async () => {
    const ui = await mount();
    await ui.press('e');
    await ui.type('one');
    await ui.press('RETURN', { meta: true });
    await ui.type('two\\');
    await ui.press('RETURN');
    await ui.type('three');
    expect(ui.asked).toHaveLength(0);
    await ui.press('RETURN');
    expect(ui.asked[0]!.instruction).toBe('one\ntwo\nthree');
  });

  test('ctrl+v in the reject prompt joins the lines into its one line', async () => {
    const ui = await mount({ clipboard: 'too vague,\nsay which timeout' });
    await ui.press('x');
    await ui.press('v', { ctrl: true });
    await ui.press('RETURN');
    expect(ui.session().items[0]!.review.note).toBe('too vague, say which timeout');
  });

  test('y copies the requirement as it is in the file', async () => {
    const ui = await mount();
    await ui.press('y');
    expect(ui.clip.writes).toHaveLength(1);
    expect(ui.clip.writes[0]).toStartWith('### Requirement: Session timeout\nThe system SHALL end');
    expect(ui.clip.writes[0]).toEndWith('- **THEN** their session ends');
    expect(ui.clip.notices).toEqual(['Copied the requirement']);
  });
});
