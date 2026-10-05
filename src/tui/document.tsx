/**
 * The document viewer: reading what an agent drafted.
 *
 * A proposal or design is prose, not a list of requirements, so it is not
 * walked item by item — but it still has to be *read* before the next stage
 * is built on it. This shows it in full, scrollable, with the three things
 * worth doing next: move on, edit it, or have it redrafted with feedback.
 *
 * It also shows what an agent said when it stopped without writing one: the
 * same reading, with actions that answer it instead.
 */

import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { wrap } from '../render/requirement.ts';
import { THEME } from './theme.ts';
import { useContentWidth } from './layout.ts';
import { editLine, isCancel, isEditor, isEnter, isRevise } from './input.ts';
import { useCopy, usePasteInto } from './copy-paste.ts';
import { Button, KeyBar, Panel } from './widgets.tsx';

export interface DocumentAction {
  label: string;
  key: string;
  /**
   * Asks for a line of text first, with this question, and runs with what
   * was typed — which may be nothing: the answer is optional.
   */
  ask?: string;
  run: (answer?: string) => void;
}

/** The line being typed, and what it is for. */
interface Asking {
  question: string;
  /** Whether enter on an empty line is refused. */
  required: boolean;
  submit: (text: string) => void;
  /** What enter does, for the key bar. */
  verb: string;
}

export interface DocumentViewProps {
  title: string;
  content: string;
  /** The next step first: it is focused, and enter presses it. */
  actions: DocumentAction[];
  /** Redrafts with the developer's feedback, when that is possible. */
  onRedraft?: (feedback: string) => void;
  onClose: () => void;
}

interface Line {
  text: string;
  fg: string;
  bold?: boolean;
}

/** Just enough Markdown to read comfortably: headings, lists, comments. */
function render(content: string, width: number): Line[] {
  const out: Line[] = [];
  let fence = false;
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) {
      fence = !fence;
      out.push({ text: raw, fg: THEME.dim });
      continue;
    }
    if (fence) {
      out.push({ text: raw, fg: THEME.accent2 });
      continue;
    }
    // Template comments an agent left in are instructions, not content.
    if (/^\s*<!--.*-->\s*$/.test(raw)) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      if (out.length > 0 && out[out.length - 1]!.text !== '') out.push({ text: '', fg: THEME.text });
      out.push({
        text: heading[2]!,
        fg: heading[1]!.length <= 2 ? THEME.accent : THEME.accent2,
        bold: true,
      });
      continue;
    }
    const bullet = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(raw);
    if (bullet) {
      const indent = bullet[1]!.length;
      const mark = /\d/.test(bullet[2]!) ? bullet[2]! : '•';
      const lines = wrap(bullet[3]!, width - indent - 4);
      lines.forEach((l, i) =>
        out.push({ text: `${' '.repeat(indent)}${i === 0 ? `${mark} ` : '  '}${l}`, fg: THEME.text }),
      );
      continue;
    }
    for (const l of wrap(raw, width)) out.push({ text: l, fg: THEME.text });
  }
  return out;
}

export function DocumentView(props: DocumentViewProps) {
  const dims = useTerminalDimensions();
  const contentWidth = useContentWidth();
  const [top, setTop] = createSignal(0);
  const [focus, setFocus] = createSignal(0);
  const [feedback, setFeedback] = createSignal<string | null>(null);
  const [asking, setAsking] = createSignal<Asking | null>(null);
  const copy = useCopy();

  const ask = (next: Asking) => {
    setAsking(next);
    setFeedback('');
  };

  usePasteInto(() => (feedback() !== null ? (text: string) => setFeedback((f) => (f ?? '') + text) : null));

  const lines = createMemo(() => render(props.content, Math.max(contentWidth() - 8, 30)));
  /** Rows available for the text, after the header, buttons and key bar. */
  const height = () => Math.max(dims().height - (feedback() !== null ? 16 : 13), 5);
  const maxTop = () => Math.max(lines().length - height(), 0);
  const scroll = (delta: number) => setTop((t) => Math.min(Math.max(t + delta, 0), maxTop()));

  const buttons = createMemo(() => [
    ...props.actions.map((a) => ({
      label: a.label,
      key: a.key,
      run: a.ask
        ? () => ask({ question: a.ask!, required: false, submit: (text) => a.run(text), verb: 'go' })
        : () => a.run(),
    })),
    ...(props.onRedraft
      ? [{
          label: '↻ Redraft with feedback',
          key: 'r',
          run: () => ask({
            question: 'What should change? The agent redrafts it with this.',
            required: true,
            submit: (text) => props.onRedraft?.(text),
            verb: 'redraft',
          }),
        }]
      : []),
    { label: '← Back', key: 'q', run: props.onClose },
  ]);

  useKeyboard((key) => {
    const draft = feedback();
    if (draft !== null) {
      const current = asking();
      if (isCancel(key)) setFeedback(null);
      else if (isEnter(key)) {
        if (current && (draft.trim() || !current.required)) {
          setFeedback(null);
          current.submit(draft.trim());
        }
      } else {
        const next = editLine(draft, key);
        if (next !== null) setFeedback(next);
      }
      return;
    }

    if (isCancel(key) || key.name === 'q') return props.onClose();
    if (key.name === 'down' || key.name === 'j') return scroll(1);
    if (key.name === 'up' || key.name === 'k') return scroll(-1);
    if (key.name === 'pagedown' || key.name === 'space') return scroll(height() - 2);
    if (key.name === 'pageup') return scroll(-(height() - 2));
    if (key.name === 'g') return setTop(key.shift ? maxTop() : 0);
    if (key.name === 'y' && !key.ctrl) return copy(props.content, `the ${props.title.split(' › ').pop() ?? 'document'}`);
    if (key.name === 'right' || key.name === 'tab') return setFocus((f) => (f + 1) % buttons().length);
    if (key.name === 'left') return setFocus((f) => (f - 1 + buttons().length) % buttons().length);
    if (isEnter(key)) return buttons()[focus()]?.run();
    // Keys as on every screen (input.ts: KEYS); `f`, as redrafting used to be.
    const pressed = isEditor(key) ? 'ctrl+e' : isRevise(key) || key.name === 'f' ? 'r' : key.ctrl ? null : key.name;
    const byKey = buttons().find((b) => b.key === pressed);
    if (byKey) byKey.run();
  });

  const scrolled = () =>
    lines().length <= height()
      ? 'all of it'
      : `${Math.round(((top() + height()) / lines().length) * 100)}% · ${lines().length} lines`;

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      <Panel title={`${props.title} · ${scrolled()}`} grow focused>
        <box
          style={{ flexDirection: 'column', flexGrow: 1 }}
          onMouseScroll={(event) => scroll(event.scroll?.direction === 'up' ? -3 : 3)}
        >
          <For each={lines().slice(top(), top() + height())}>
            {(line) => (
              <text style={{ fg: line.fg }}>
                {line.bold ? <strong>{line.text || ' '}</strong> : line.text || ' '}
              </text>
            )}
          </For>
        </box>
        <Show when={feedback() !== null}>
          <text style={{ fg: THEME.warn }}>{asking()?.question ?? ''}</text>
          <box style={{ border: true, borderStyle: 'rounded', borderColor: THEME.accent, paddingLeft: 1 }}>
            <text style={{ fg: THEME.text }}>{`› ${feedback()}▏`}</text>
          </box>
        </Show>
        <box style={{ flexDirection: 'row' }}>
          <For each={buttons()}>
            {(b, i) => (
              <Button
                label={`${b.label}  ${b.key}`}
                primary={i() === 0}
                focused={feedback() === null && i() === focus()}
                onPress={b.run}
              />
            )}
          </For>
        </box>
      </Panel>
      <KeyBar
        keys={
          feedback() !== null
            ? [['enter', asking()?.verb ?? 'go'], ['ctrl+v', 'paste'], ['ctrl+c', 'cancel']]
            : [['↑↓', 'scroll'], ['space', 'page'], ['←→', 'action'], ['enter', 'go'], ['y', 'copy'], ['q', 'back']]
        }
      />
    </box>
  );
}
