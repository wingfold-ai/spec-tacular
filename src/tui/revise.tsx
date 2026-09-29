/**
 * Revising the requirement under review with the agent, in conversation.
 *
 * Opened by `e` on the review screen. You say what should change; the agent
 * answers with the revised requirement, shown as a diff against the file;
 * then accept it, ask for more — as often as you like, the agent remembering
 * every round — or discard it. Nothing is written until you accept, and
 * ctrl+c at any point leaves the file as it was.
 */

import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type { RefineTurn, Refinement } from '../core/refine.ts';
import { lineDiff, type DiffLine } from '../render/diff.ts';
import { wrap } from '../render/requirement.ts';
import { useCopy, usePasteInto } from './copy-paste.ts';
import { editLine, isCancel, isEnter } from './input.ts';
import { useContentWidth } from './layout.ts';
import { THEME } from './theme.ts';
import { KeyBar, Spinner } from './widgets.tsx';

export type RevisePhase = 'prompt' | 'working' | 'proposal' | 'error' | 'unavailable';

export interface RevisePanelProps {
  name: string;
  /** The requirement's Markdown, as it is in the file now. */
  current: string;
  /** What the prompt starts with: the reason it was rejected, if it was. */
  seed?: string;
  /** Why there is no agent to revise with, or null when there is one. */
  unavailable: string | null;
  propose: (turns: RefineTurn[], instruction: string) => Promise<Refinement>;
  /** Writes the revision into the spec file. */
  onAccept: (block: string) => { ok: true } | { ok: false; reason: string };
  /** Closes the panel; the message says what happened to the requirement. */
  onClose: (message: string | null) => void;
  /** What is being revised, in messages: `requirement` unless said otherwise. */
  noun?: string;
  /** The line inviting the first instruction. */
  invite?: string;
  /** How else to edit it, shown when there is no agent. */
  editorHint?: string;
  /** Example instructions under the invitation. */
  examples?: string;
  /**
   * Takes the text as it is, unrevised: enter with nothing typed, before
   * anything was proposed — for a proposal that turns out fine after all.
   * Absent: the text is already where it belongs, and there is nothing to take.
   */
  onKeep?: (text: string) => { ok: true } | { ok: false; reason: string };
}

const STYLE: Record<DiffLine['op'], string> = { ' ': THEME.text, '-': THEME.err, '+': THEME.ok };

/** Wraps a diff line, keeping its indentation on every row. */
function wrapDiff(line: DiffLine, width: number): { text: string; fg: string }[] {
  const indent = /^\s*/.exec(line.text)![0];
  const rows = line.text.trim() === '' ? [''] : wrap(line.text.slice(indent.length), Math.max(width - indent.length - 2, 20));
  return rows.map((row, i) => ({
    text: `${i === 0 ? line.op : ' '} ${indent}${row}`,
    fg: STYLE[line.op],
  }));
}

/**
 * Whether enter here means a new line rather than send: shift or alt with
 * it (as far as the terminal reports those), ctrl+j, or a line ending in a
 * backslash — the one that works in every terminal.
 */
export function isNewline(key: { name: string; shift?: boolean; meta?: boolean }, draft: string): boolean {
  if (key.name === 'linefeed') return true;
  if (key.name !== 'return' && key.name !== 'enter') return false;
  return key.shift === true || key.meta === true || draft.endsWith('\\');
}

export function RevisePanel(props: RevisePanelProps) {
  const noun = () => props.noun ?? 'requirement';
  const dims = useTerminalDimensions();
  const contentWidth = useContentWidth();
  const copy = useCopy();
  const [phase, setPhase] = createSignal<RevisePhase>(props.unavailable ? 'unavailable' : 'prompt');
  const [draft, setDraft] = createSignal(props.seed ?? '');
  const [turns, setTurns] = createSignal<RefineTurn[]>([]);
  const [latest, setLatest] = createSignal<Refinement | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** The instruction in flight, kept to retry it or edit it after a failure. */
  const [asked, setAsked] = createSignal('');
  const [top, setTop] = createSignal(0);
  /** Scroll position in the text being revised, before there is a proposal. */
  const [currentTop, setCurrentTop] = createSignal(0);
  const [elapsed, setElapsed] = createSignal(0);
  // Bumped to disown a request: a cancelled one may still answer, and its
  // answer must not appear as though it had been asked for.
  let generation = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  onCleanup(() => clearInterval(ticker));

  const width = () => Math.max(contentWidth() - 10, 40);

  const diff = createMemo(() => {
    const next = latest();
    if (!next) return [];
    return lineDiff(props.current.split('\n'), next.block.split('\n')).flatMap((l) => wrapDiff(l, width()));
  });
  /** Rows for the diff, after the header, summary, warnings and keys. */
  const height = () => Math.max(dims().height - 18 - (latest()?.warnings.length ?? 0), 6);
  const scroll = (delta: number) =>
    setTop((t) => Math.min(Math.max(t + delta, 0), Math.max(diff().length - height(), 0)));

  const draftRows = createMemo(() => {
    const rows = `${draft()}▏`.split('\n').flatMap((line) => (line === '' ? [''] : wrap(line, width() - 4)));
    return rows.slice(-8);
  });

  /** What is being revised, in full: on screen until the first proposal replaces it with a diff. */
  const currentRows = createMemo(() =>
    props.current.split('\n').flatMap((line) => (line.trim() === '' ? [''] : wrap(line, width() - 2))));
  const currentHeight = () => Math.max(dims().height - 20 - draftRows().length, 5);
  const scrollCurrent = (delta: number) =>
    setCurrentTop((t) => Math.min(Math.max(t + delta, 0), Math.max(currentRows().length - currentHeight(), 0)));

  const send = (instruction: string) => {
    const mine = ++generation;
    setAsked(instruction);
    setError(null);
    setPhase('working');
    setElapsed(0);
    clearInterval(ticker);
    ticker = setInterval(() => setElapsed((s) => s + 1), 1000);
    props.propose(turns(), instruction).then(
      (refinement) => {
        if (mine !== generation) return;
        clearInterval(ticker);
        setTurns((t) => [...t, { instruction, revised: refinement.block }]);
        setLatest(refinement);
        setTop(0);
        setDraft('');
        setPhase('proposal');
      },
      (err: Error) => {
        if (mine !== generation) return;
        clearInterval(ticker);
        setError(err.message);
        setPhase('error');
      },
    );
  };

  /** Back one step: to the last proposal if there is one, else out. */
  const back = (message: string) => {
    generation++;
    clearInterval(ticker);
    if (latest()) setPhase('proposal');
    else props.onClose(message);
  };

  const accept = () => {
    const next = latest();
    if (!next) return;
    const result = props.onAccept(next.block);
    if (!result.ok) {
      setError(result.reason);
      setPhase('error');
      return;
    }
    props.onClose(null);
  };

  usePasteInto(() => (phase() === 'prompt' ? (text: string) => setDraft((d) => d + text) : null), { multiline: true });

  useKeyboard((key) => {
    switch (phase()) {
      case 'unavailable':
        props.onClose(null);
        return;

      case 'working':
        if (isCancel(key)) back(`Revision cancelled — the ${noun()} is unchanged`);
        return;

      case 'prompt': {
        if (isCancel(key)) return back(`Revision cancelled — the ${noun()} is unchanged`);
        if (isNewline(key, draft())) {
          setDraft((d) => (d.endsWith('\\') ? d.slice(0, -1) : d) + '\n');
          return;
        }
        if (isEnter(key)) {
          if (draft().trim()) return send(draft().trim());
          // Nothing asked, nothing proposed: take it as it is.
          if (!latest() && props.onKeep) {
            const result = props.onKeep(props.current);
            if (!result.ok) {
              setError(result.reason);
              setPhase('error');
              return;
            }
            props.onClose(null);
          }
          return;
        }
        // Page keys scroll the text being revised; arrows stay with the input.
        if (!latest() && key.name === 'pagedown') return scrollCurrent(currentHeight() - 2);
        if (!latest() && key.name === 'pageup') return scrollCurrent(-(currentHeight() - 2));
        const next = editLine(draft(), key);
        if (next !== null) setDraft(next);
        return;
      }

      case 'error':
        if (isCancel(key)) return back(`Revision cancelled — the ${noun()} is unchanged`);
        if (isEnter(key)) return send(asked());
        if (key.name === 'e' || key.name === 'i') {
          setDraft(asked());
          setPhase('prompt');
        }
        return;

      case 'proposal':
        if (isCancel(key) || key.name === 'd' || key.name === 'q') {
          generation++;
          return props.onClose(`Revision discarded — the ${noun()} is unchanged`);
        }
        if (key.name === 'a' || isEnter(key)) return accept();
        if (key.name === 'i' || key.name === 'e') {
          setDraft('');
          setPhase('prompt');
          return;
        }
        if (key.name === 'y') return copy(latest()!.block, `the revised ${noun()}`);
        if (key.name === 'down' || key.name === 'j') return scroll(1);
        if (key.name === 'up' || key.name === 'k') return scroll(-1);
        if (key.name === 'pagedown' || key.name === 'space') return scroll(height() - 2);
        if (key.name === 'pageup') return scroll(-(height() - 2));
        return;
    }
  });

  const keys = createMemo((): [string, string][] => {
    switch (phase()) {
      case 'prompt':
        return [
          ['enter', !latest() && props.onKeep && draft().trim() === '' ? 'take it as it is' : 'send'],
          ['alt+enter / \\', 'new line'],
          ['ctrl+v', 'paste'],
          ...(!latest() && currentRows().length > currentHeight() ? [['pgup/pgdn', 'scroll the text'] as [string, string]] : []),
          ['ctrl+c', latest() ? 'back to the proposal' : 'cancel'],
        ];
      case 'working':
        return [['ctrl+c', 'cancel']];
      case 'proposal':
        return [
          ['a', 'accept — write it'],
          ['i', 'ask for more changes'],
          ['d', 'discard'],
          ...(diff().length > height() ? [['↑↓', 'scroll'] as [string, string]] : []),
          ['y', 'copy'],
        ];
      case 'error':
        return [['enter', 'try again'], ['e', 'edit the request'], ['ctrl+c', 'back']];
      default:
        return [['any key', 'back']];
    }
  });

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      <text style={{ fg: THEME.accent }}>{`Revise with AI: ${props.name}`}</text>
      <Show when={turns().length > 0}>
        <text style={{ fg: THEME.dim }}>
          {`round ${turns().length} · ${turns().map((t) => `“${t.instruction.split('\n')[0]}”`).join(' → ')}`.slice(0, width())}
        </text>
      </Show>
      <text>{' '}</text>

      <Show when={phase() === 'unavailable'}>
        <text style={{ fg: THEME.warn }}>{`No AI to revise with: ${props.unavailable}.`}</text>
        <text style={{ fg: THEME.text }}>{props.editorHint ?? 'E opens the requirement in your editor instead.'}</text>
      </Show>

      {/* Before any proposal: the text being revised, in full */}
      <Show when={!latest() && phase() !== 'unavailable'}>
        <text style={{ fg: THEME.dim }}>
          {currentRows().length > currentHeight()
            ? `The ${noun()} as it is now — lines ${currentTop() + 1}–${Math.min(currentTop() + currentHeight(), currentRows().length)} of ${currentRows().length}`
            : `The ${noun()} as it is now`}
        </text>
        <box style={{ flexDirection: 'column', border: ['left'], borderColor: THEME.border, paddingLeft: 1 }}>
          <For each={currentRows().slice(currentTop(), currentTop() + currentHeight())}>
            {(row) => <text style={{ fg: THEME.text }}>{row || ' '}</text>}
          </For>
        </box>
        <text>{' '}</text>
      </Show>

      {/* The proposal: what accepting it changes in the file */}
      <Show when={latest() && phase() !== 'unavailable'}>
        <Show when={latest()!.summary}>
          <text style={{ fg: THEME.accent2 }}>{`✦ ${latest()!.summary}`}</text>
        </Show>
        <For each={latest()!.warnings}>
          {(w) => <text style={{ fg: THEME.warn }}>{`! ${w}`}</text>}
        </For>
        <box style={{ flexDirection: 'column', border: ['left'], borderColor: THEME.border, paddingLeft: 1 }}>
          <For each={diff().slice(top(), top() + height())}>
            {(row) => <text style={{ fg: row.fg }}>{row.text || ' '}</text>}
          </For>
        </box>
        <text>{' '}</text>
      </Show>

      <Show when={phase() === 'prompt'}>
        <text style={{ fg: THEME.warn }}>
          {latest()
            ? 'What else should change? The agent revises its proposal above.'
            : (props.invite ?? 'How should this requirement change? The agent proposes a revision; nothing is written until you accept it.')}
        </text>
        <Show when={!latest()}>
          <text style={{ fg: THEME.dim }}>{props.examples ?? 'e.g. "make the timeout configurable" · "split it into two scenarios"'}</text>
          <Show when={props.onKeep}>
            <text style={{ fg: THEME.dim }}>Happy with it after all? Press enter with nothing typed to take it as it is.</text>
          </Show>
        </Show>
        <box style={{ border: true, borderStyle: 'rounded', borderColor: THEME.accent, paddingLeft: 1, flexDirection: 'column' }}>
          <For each={draftRows()}>
            {(row, i) => <text style={{ fg: THEME.text }}>{`${i() === 0 ? '› ' : '  '}${row}`}</text>}
          </For>
        </box>
      </Show>

      <Show when={phase() === 'working'}>
        <Spinner label={`The agent is revising it · ${elapsed()}s`} />
        <text style={{ fg: THEME.dim }}>{`  “${asked().split('\n')[0]}”`}</text>
      </Show>

      <Show when={phase() === 'error'}>
        <text style={{ fg: THEME.err }}>{`Could not revise it: ${error()}`}</text>
      </Show>

      <box style={{ flexGrow: 1 }} />
      <KeyBar keys={keys()} />
    </box>
  );
}
