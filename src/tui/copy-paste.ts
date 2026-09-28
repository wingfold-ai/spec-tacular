/**
 * Copy and paste, the way a terminal app has to do them.
 *
 * Paste arrives two ways. The terminal's own paste (ctrl+shift+v, a middle
 * click, its menu) comes as one bracketed-paste event, newlines and all —
 * which is why it must never be fed through the key handlers, where every
 * newline would be an enter. ctrl+v comes as a key, and is answered by
 * reading the system clipboard. Both land in whichever input is open.
 *
 * Copy is a mouse selection plus ctrl+c. ctrl+c is also the app's "back",
 * so it copies only while something is selected, and the selection ends with
 * the next key — a selection left lying around would silently turn the next
 * ctrl+c, meant as back, into a copy.
 */

import { decodePasteBytes, type KeyEvent } from '@opentui/core';
import { useKeyboard, usePaste, useRenderer } from '@opentui/solid';
import { createContext, onCleanup, onMount, useContext } from 'solid-js';
import { cleanPaste, SystemClipboard, type ClipboardPort } from './clipboard.ts';

export interface ClipboardContextValue {
  clipboard: ClipboardPort;
  /** A short status: "Copied the requirement", or why it could not be. */
  notify: (message: string) => void;
}

const ClipboardContext = createContext<ClipboardContextValue>();

export const ClipboardProvider = ClipboardContext.Provider;

let fallback: ClipboardContextValue | null = null;

/** The app's clipboard, or the system's for a screen mounted on its own. */
export function useClipboard(): ClipboardContextValue {
  return useContext(ClipboardContext) ?? (fallback ??= { clipboard: new SystemClipboard(), notify: () => {} });
}

/** ctrl+v, which a terminal delivers as a key rather than as a paste. */
export function isPasteKey(key: Pick<KeyEvent, 'ctrl' | 'name' | 'meta'>): boolean {
  return key.ctrl === true && key.name === 'v' && !key.meta;
}

/**
 * Pastes into the input `target` returns, for as long as it returns one.
 *
 * `target` is asked again when the clipboard has been read: the input may
 * have closed in the meantime, and text must not land in whatever replaced it.
 */
export function usePasteInto(
  target: () => ((text: string) => void) | null,
  options: {
    multiline?: boolean;
    /** For the component that provides the clipboard, and so cannot use it. */
    clipboard?: ClipboardContextValue;
  } = {},
): void {
  const { clipboard, notify } = options.clipboard ?? useClipboard();
  const multiline = options.multiline ?? false;

  usePaste((event) => {
    const insert = target();
    if (!insert) return;
    event.preventDefault();
    const text = cleanPaste(decodePasteBytes(event.bytes), multiline);
    if (text) insert(text);
  });

  useKeyboard((key) => {
    if (!isPasteKey(key) || !target()) return;
    void clipboard.read().then((result) => {
      if (!result.ok) return notify(result.reason);
      const text = cleanPaste(result.text, multiline);
      if (text) target()?.(text);
    });
  });
}

/** Copies text to the clipboard and says so. */
export function useCopy(): (text: string, what: string) => void {
  const { clipboard, notify } = useClipboard();
  return (text, what) => {
    void clipboard.write(text).then((result) =>
      notify(
        result.ok
          ? `Copied ${what}${result.via === 'terminal' ? ' (through the terminal)' : ''}`
          : result.reason,
      ),
    );
  };
}

/** Keys that are only a modifier held down, reported by some protocols. */
const MODIFIER = /^(left|right)?(shift|ctrl|control|alt|option|meta|super|hyper|capslock|numlock)$/i;

/**
 * What a key does to a mouse selection: `copy` it (ctrl+c over selected
 * text), or `pass` the key on as though nothing were selected.
 */
export function selectionAction(key: Pick<KeyEvent, 'ctrl' | 'name' | 'meta'>, selected: string): 'copy' | 'pass' {
  return key.ctrl === true && key.name === 'c' && !key.meta && selected.trim() !== '' ? 'copy' : 'pass';
}

/** Selected text as it should be copied: without the padding of each row. */
export function selectedText(raw: string): string {
  return raw.split('\n').map((line) => line.trimEnd()).join('\n').replace(/^\n+|\n+$/g, '');
}

/**
 * ctrl+c copies the mouse selection, ahead of every other key handler.
 *
 * Registered in front of them so a copy stops there: a screen seeing the same
 * ctrl+c would go back as well.
 */
export function useSelectionCopy(provided?: ClipboardContextValue): void {
  const renderer = useRenderer();
  const { clipboard, notify } = provided ?? useClipboard();

  const handler = (key: KeyEvent) => {
    const selection = renderer.getSelection();
    if (!selection) return;
    const text = selectedText(selection.getSelectedText());
    if (selectionAction(key, text) === 'copy') {
      key.preventDefault();
      key.stopPropagation();
      renderer.clearSelection();
      void clipboard.write(text).then((result) =>
        notify(result.ok ? `Copied ${text.length} character${text.length === 1 ? '' : 's'}` : result.reason),
      );
      return;
    }
    if (!MODIFIER.test(key.name)) renderer.clearSelection();
  };

  onMount(() => renderer.keyInput.prependListener('keypress', handler));
  onCleanup(() => renderer.keyInput.off('keypress', handler));
}
