/**
 * The start screen: the logo, where the project stands, and one obvious
 * button for the next step.
 *
 * Shown on every launch, the way opencode opens on its own logo: it is the
 * one screen that answers "what is this, and what do I do now" before any
 * detail appears. Enter always takes the highlighted — next — step.
 */

import { useKeyboard } from '@opentui/solid';
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { GRADIENT, THEME } from './theme.ts';
import { isCancel, isEnter } from './input.ts';
import { Button, Panel, ScrollArea, shortPath, Spinner } from './widgets.tsx';
import { HelpOverlay } from './guide.tsx';
import { useContentWidth } from './layout.ts';

export interface HomeAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface HomeProps {
  root: string;
  /** One line on where the project stands. */
  status: string;
  /** The first is the next step and starts focused. */
  actions: HomeAction[];
  /** Shown instead of the buttons while an action runs. */
  busy: string | null;
  error: string | null;
  onQuit: () => void;
}

const LOGO = 'spec-tacular';
const TAGLINE = 'spec-driven development — every requirement reviewed before it is built';

export function HomeScreen(props: HomeProps) {
  const contentWidth = useContentWidth();
  const [focus, setFocus] = createSignal(0);
  const [tick, setTick] = createSignal(0);
  // The same key list as on the overview, so `?` means one thing everywhere.
  const [help, setHelp] = createSignal(false);

  // The logo types itself in, then its gradient keeps drifting slowly.
  const timer = setInterval(() => setTick((t) => t + 1), 70);
  onCleanup(() => clearInterval(timer));

  const shown = createMemo(() => LOGO.slice(0, Math.min(LOGO.length, tick() + 1)));
  const colors = createMemo(() => {
    const shift = Math.floor(tick() / 3);
    return [...LOGO].map((_, i) => GRADIENT[(i + shift) % GRADIENT.length]!);
  });
  // `block` needs about 100 columns; narrower terminals get the compact font.
  const font = createMemo(() => (contentWidth() >= 104 ? 'block' : 'tiny'));

  const total = () => props.actions.length + 1; // + Quit
  const press = (i: number) => {
    if (props.busy) return;
    if (i >= props.actions.length) return props.onQuit();
    void props.actions[i]!.run();
  };

  useKeyboard((key) => {
    // Help is a transient overlay: any key closes it rather than acting.
    if (help()) return setHelp(false);
    if (key.sequence === '?') return setHelp(true);
    if (props.busy) return;
    if (key.name === 'q' || isCancel(key)) return props.onQuit();
    if (isEnter(key) || key.name === 'space') return press(focus());
    if (key.name === 'right' || key.name === 'down' || (key.name === 'tab' && !key.shift)) {
      setFocus((f) => (f + 1) % total());
    } else if (key.name === 'left' || key.name === 'up' || (key.name === 'tab' && key.shift)) {
      setFocus((f) => (f - 1 + total()) % total());
    }
  });

  return (
    <Show
      when={!help()}
      fallback={
        <Panel title="Help · any key closes" grow focused>
          <ScrollArea>
            <HelpOverlay />
          </ScrollArea>
        </Panel>
      }
    >
    <box
      style={{
        flexDirection: 'column',
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <ascii_font text={shown()} font={font()} color={colors()} />
      <text>{' '}</text>
      <text>{' '}</text>
      <text style={{ fg: THEME.text }}>{TAGLINE}</text>
      <text>{' '}</text>
      <text style={{ fg: THEME.accent2 }}>{props.status}</text>
      <text>{' '}</text>

      <Show
        when={!props.busy}
        fallback={
          <box style={{ height: 3, justifyContent: 'center' }}>
            <Spinner label={props.busy ?? ''} />
          </box>
        }
      >
        <box style={{ flexDirection: 'row' }}>
          <For each={props.actions}>
            {(action, i) => (
              <Button
                label={i() === 0 ? `▶ ${action.label}` : action.label}
                primary={i() === 0}
                focused={focus() === i()}
                onPress={() => press(i())}
              />
            )}
          </For>
          <Button
            label="Quit"
            focused={focus() === props.actions.length}
            onPress={props.onQuit}
          />
        </box>
      </Show>

      <Show when={props.error}>
        <text>{' '}</text>
        <text style={{ fg: THEME.err }}>{props.error}</text>
      </Show>

      <text>{' '}</text>
      <text style={{ fg: THEME.dim }}>{shortPath(props.root, 80)}</text>
      <text style={{ fg: THEME.dim }}>←/→ choose · enter select · ? keys · q quit · or click</text>
    </box>
    </Show>
  );
}
