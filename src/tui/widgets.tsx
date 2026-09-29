/**
 * The few building blocks every screen is made of: panels, buttons, a spinner
 * and the key bar. Shared so the screens read as one interface rather than as
 * separate text dumps.
 */

import { homedir } from 'node:os';
import { createEffect, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import type { ScrollBoxRenderable } from '@opentui/core';
import { THEME } from './theme.ts';
import { wrap } from '../render/requirement.ts';

/** A bordered panel with its title set into the top edge. */
export function Panel(props: {
  title?: string;
  children: JSX.Element;
  grow?: boolean;
  /** Keeps its content's height, but gives way when the screen runs out of room. */
  shrink?: boolean;
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
        // A panel that does not grow keeps its height when the screen runs out
        // of room; the one that grows gives way (and scrolls, with a ScrollArea).
        // Never cut below its content either way: it is clipped, not overlapped.
        overflow: 'hidden',
        flexShrink: props.grow || props.shrink ? 1 : 0,
        ...(props.grow ? { flexGrow: 1 } : {}),
        ...(props.width !== undefined ? { width: props.width } : {}),
      }}
    >
      {props.children}
    </box>
  );
}

/**
 * Content that may be taller than the space it gets: it scrolls instead.
 *
 * Without it the layout squeezes rows below their height when a view runs out
 * of room, and squeezed rows are drawn over each other — characters of two
 * lines jumbled into one. Inside, rows keep their natural height; `follow`
 * (the `id` of a row) keeps that row in view as it changes, for a selection.
 */
export function ScrollArea(props: {
  children: JSX.Element;
  follow?: string;
  /**
   * true (default): fills the room left over. false: as tall as its content,
   * and the first thing to give way when there is not room for it all.
   */
  grow?: boolean;
}) {
  let ref: ScrollBoxRenderable | undefined;
  createEffect(() => {
    const id = props.follow;
    if (id && ref) ref.scrollChildIntoView(id);
  });
  return (
    <scrollbox
      ref={(r: ScrollBoxRenderable) => (ref = r)}
      // Rows around it keep their height: it takes only the room left over,
      // or, sized to its content, gives up room before anything else does.
      style={
        props.grow === false
          ? { flexGrow: 0, flexShrink: 1000, minHeight: 3, rootOptions: { backgroundColor: THEME.panel } }
          : { flexGrow: 1, flexBasis: 0, flexShrink: 1, minHeight: 3, rootOptions: { backgroundColor: THEME.panel } }
      }
    >
      {props.children}
    </scrollbox>
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
    <box style={{ flexDirection: 'column', paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
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

/**
 * What the developer is typing, with its cursor, wrapped to `width` columns
 * (the `› ` prompt included) and kept to the last `maxLines` lines.
 *
 * One text, not one per line: rows that reflow on every keystroke, each its
 * own node, are laid out stale — a new line drawn over the one above it.
 */
export function DraftText(props: { draft: string; width: number; maxLines?: number }) {
  const text = () => {
    const lines = wrap(`${props.draft}▏`, Math.max(props.width - 2, 10));
    return lines
      .slice(props.maxLines ? -props.maxLines : 0)
      .map((line, i) => `${i === 0 ? '› ' : '  '}${line}`)
      .join('\n');
  };
  return <text style={{ fg: THEME.text }}>{text()}</text>;
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
