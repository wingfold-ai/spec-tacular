/**
 * How wide a screen may draw.
 *
 * A persistent sidebar takes columns from the right, and screens that wrap
 * text from the terminal width would otherwise overflow their box. The App
 * provides the width left over; a screen mounted on its own (in a test, say)
 * falls back to the whole terminal.
 */

import { useTerminalDimensions } from '@opentui/solid';
import { createContext, useContext } from 'solid-js';

const ContentWidth = createContext<(() => number) | undefined>(undefined);

export const ContentWidthProvider = ContentWidth.Provider;

/** The width a screen has, accounting for any persistent sidebar. */
export function useContentWidth(): () => number {
  const dims = useTerminalDimensions();
  const provided = useContext(ContentWidth);
  return () => (provided ? provided() : dims().width);
}
