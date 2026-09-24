/**
 * The few building blocks every screen is made of: panels, buttons, a spinner
 * and the key bar. Shared so the screens read as one interface rather than as
 * separate text dumps.
 */

import { homedir } from 'node:os';
import { createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { THEME } from './theme.ts';

/** A bordered panel with its title set into the top edge. */
export function Panel(props: {
  title?: string;
  children: JSX.Element;
  grow?: boolean;
  width?: number | `${number}%`;
  focused?: boolean;
}) {
  return (
    <box
      title={props.title ? ` ${props.title} ` : undefined}
      style={{
        border: true,
        borderStyle: 'rounded',
        borderColor: props.focused ? THEME.accent : THEME.border,
        backgroundColor: THEME.panel,
        flexDirection: 'column',
        paddingLeft: 1,
        paddingRight: 1,
        ...(props.grow ? { flexGrow: 1 } : {}),
        ...(props.width !== undefined ? { width: props.width } : {}),
      }}
    >
      {props.children}
    </box>
  );
}

/**
 * A button: keyboard-focusable and clickable. `primary` fills it with the
 * accent colour — one per screen, so the next step is never ambiguous.
 */
export function Button(props: {
  label: string;
  focused?: boolean;
  primary?: boolean;
  onPress: () => void;
}) {
  const filled = () => props.focused;
  return (
    <box
      onMouseDown={() => props.onPress()}
      style={{
        border: true,
        borderStyle: 'rounded',
        borderColor: props.focused ? THEME.accent : props.primary ? THEME.accent2 : THEME.border,
        backgroundColor: filled() ? THEME.accent : THEME.panel,
        paddingLeft: 2,
        paddingRight: 2,
        marginRight: 1,
      }}
    >
      <text style={{ fg: filled() ? THEME.onAccent : props.primary ? THEME.accent : THEME.text }}>
        {props.label}
      </text>
    </box>
  );
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A braille spinner frame that advances while mounted. */
export function useSpinner(intervalMs = 90): () => string {
  const [i, setI] = createSignal(0);
  const timer = setInterval(() => setI((n) => (n + 1) % FRAMES.length), intervalMs);
  onCleanup(() => clearInterval(timer));
  return () => FRAMES[i()]!;
}

export function Spinner(props: { label: string; color?: string }) {
  const frame = useSpinner();
  return (
    <text style={{ fg: props.color ?? THEME.accent2 }}>{`${frame()} ${props.label}`}</text>
  );
}

/**
 * `key action` chips along the bottom edge, with a notice on its own line
 * above them — a long message squeezed in beside the keys garbles both.
 */
export function KeyBar(props: { keys: [key: string, action: string][]; right?: string }) {
  return (
    <box style={{ flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
      <Show when={props.right}>
        <text style={{ fg: THEME.warn }}>{props.right}</text>
      </Show>
      <box style={{ flexDirection: 'row' }}>
        <For each={props.keys}>
          {([key, action]) => (
            <box style={{ flexDirection: 'row', marginRight: 2, flexShrink: 0 }}>
              <text style={{ fg: THEME.onAccent, bg: THEME.dim }}>{` ${key} `}</text>
              <text style={{ fg: THEME.dim }}>{` ${action}`}</text>
            </box>
          )}
        </For>
      </box>
    </box>
  );
}

/** Cuts a line to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(max - 1, 0))}…`;
}

/** A path as a header shows it: `~` for home, and the tail kept when long. */
export function shortPath(path: string, max = 60): string {
  const home = homedir();
  const p = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return p.length <= max ? p : `…${p.slice(p.length - max + 1)}`;
}
