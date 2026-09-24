/**
 * The document viewer: reading what an agent drafted.
 *
 * A proposal or design is prose, not a list of requirements, so it is not
 * walked item by item — but it still has to be *read* before the next stage
 * is built on it. This shows it in full, scrollable, with the three things
 * worth doing next: move on, edit it, or have it redrafted with feedback.
 */

import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { wrap } from '../render/requirement.ts';
import { THEME } from './theme.ts';
import { editLine, isCancel, isEnter } from './input.ts';
import { Button, KeyBar, Panel } from './widgets.tsx';

export interface DocumentAction {
  label: string;
  key: string;
  run: () => void;
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
  const [top, setTop] = createSignal(0);
  const [focus, setFocus] = createSignal(0);
  const [feedback, setFeedback] = createSignal<string | null>(null);

  const lines = createMemo(() => render(props.content, Math.max(dims().width - 8, 30)));
  /** Rows available for the text, after the header, buttons and key bar. */
  const height = () => Math.max(dims().height - (feedback() !== null ? 16 : 13), 5);
  const maxTop = () => Math.max(lines().length - height(), 0);
  const scroll = (delta: number) => setTop((t) => Math.min(Math.max(t + delta, 0), maxTop()));

  const buttons = createMemo(() => [
    ...props.actions,
    ...(props.onRedraft
      ? [{ label: '↻ Redraft with feedback', key: 'f', run: () => setFeedback('') }]
      : []),
    { label: '← Back', key: 'q', run: props.onClose },
  ]);

  useKeyboard((key) => {
    const draft = feedback();
    if (draft !== null) {
      if (isCancel(key)) setFeedback(null);
      else if (isEnter(key)) {
        if (draft.trim()) {
          setFeedback(null);
          props.onRedraft?.(draft.trim());
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
    if (key.name === 'right' || key.name === 'tab') return setFocus((f) => (f + 1) % buttons().length);
    if (key.name === 'left') return setFocus((f) => (f - 1 + buttons().length) % buttons().length);
    if (isEnter(key)) return buttons()[focus()]?.run();
    const byKey = buttons().find((b) => b.key === key.name);
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
          <text style={{ fg: THEME.warn }}>What should change? The agent redrafts it with this.</text>
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
            ? [['enter', 'redraft'], ['ctrl+c', 'cancel']]
            : [['↑↓', 'scroll'], ['space', 'page'], ['←→', 'action'], ['enter', 'go'], ['q', 'back']]
        }
      />
    </box>
  );
}
