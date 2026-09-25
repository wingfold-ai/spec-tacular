/**
 * The guided first run: the stepper, and the words shown
 * where a project has nothing in it yet.
 *
 * Every empty state names the next step and the key that takes it. A blank
 * screen with "0 changes" is accurate and useless — the person looking at it
 * is exactly the one who does not yet know which command comes next.
 */

import { For } from 'solid-js';
import { THEME } from './theme.ts';

/** `✓ Set up ── 2. Ground rules ── 3. Vision ── 4. First change`. */
export function Stepper(props: { step: number; steps: string[] }) {
  return (
    <box style={{ flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}>
      <For each={props.steps}>
        {(label, i) => (
          <text
            style={{
              fg: i() < props.step ? THEME.ok : i() === props.step ? THEME.accent : THEME.dim,
            }}
          >
            {`${i() < props.step ? '✓' : `${i() + 1}.`} ${label}${i() < props.steps.length - 1 ? '  ──  ' : ''}`}
          </text>
        )}
      </For>
    </box>
  );
}

/** The overview body when the ground rules are set and nothing is proposed. */
export function FirstChangeGuide() {
  const lines = [
    'Ground rules are set. Next: your first change.',
    '',
    'A change is one slice of work, small enough to review in one sitting —',
    '"add user login", not "build the app". It moves through four artifacts,',
    'and each one waits until you have accepted the one before it:',
    '',
    '  proposal   why this change, and what it changes',
    '  specs      the requirements, which you review one at a time',
    '  design     how it will be built, decided against accepted specs',
    '  tasks      the implementation checklist an agent works through',
    '',
    'Press n (or + New change) and describe what you want in a sentence or',
    'two — a name is proposed from it. Then an agent drafts the proposal, or',
    'you write it yourself.',
  ];
  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
      <For each={lines}>
        {(line, i) => (
          <text style={{ fg: i() === 0 ? THEME.accent : THEME.text }}>{line || ' '}</text>
        )}
      </For>
    </box>
  );
}

const HELP_LINES = [
  'Overview',
  '  ↑ / ↓, j / k   select a change (or click it)',
  '  ← / →, tab     choose between the next-step buttons',
  '  enter          press the highlighted button — the next step',
  '  r              review the selected change, one requirement at a time',
  '  n              start a new change',
  '  w              let an agent draft the next artifact, in the background',
  '  e              write the next artifact yourself, in $EDITOR',
  '  f              the ground rules: domain, stack, architecture, conventions',
  '  ctrl+j         background jobs · ctrl+b AI usage: model, cost, current step',
  '  h              back to the start screen',
  '  q              quit',
  '',
  'Ground rules',
  '  enter          take the highlighted choice — ⇐ derived or ★ recommended',
  '  tab, Skip      skip a question: left for later, never blocking a change',
  '  ctrl+f         done: leave the open questions for later and move on',
  '  ?              not sure: an explanation, examples and simpler questions',
  '',
  'Reviewing a requirement',
  '  a / r / d      accept, reject (asks why), defer (asks what would verify it)',
  '  e              revise it with AI: say what should change, see the diff, then',
  '                 a accept · i ask for more · d discard — nothing is written until a',
  '  E, ctrl+e      edit it in $EDITOR instead',
  '  y              copy it',
  '',
  'Copy and paste',
  '  drag           select text with the mouse; ctrl+c copies it (without a',
  '                 selection ctrl+c is back, as everywhere)',
  '  ctrl+v         paste the clipboard into the text you are typing',
  '  ctrl+shift+v   the terminal\'s own paste works too, several lines at once',
  '',
  'Pipeline marks',
  '  ✓ accepted by you   ● written, not yet accepted   ◉ ready to write   ○ blocked',
  '',
  'Press any key to close.',
];

export function HelpOverlay() {
  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
      <For each={HELP_LINES}>
        {(line) => (
          <text style={{ fg: line && !line.startsWith(' ') ? THEME.accent : THEME.text }}>
            {line || ' '}
          </text>
        )}
      </For>
    </box>
  );
}
