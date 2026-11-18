export type WindowButton = 'minimize' | 'maximize' | 'close';

/** Window buttons on each side of the title bar, in display order. */
export interface WindowButtonLayout {
  start: WindowButton[];
  end: WindowButton[];
}

/** The layout used where the desktop has none (Windows) or it cannot be read. */
export const DEFAULT_WINDOW_BUTTON_LAYOUT: WindowButtonLayout = Object.freeze({
  start: [],
  end: ['minimize', 'maximize', 'close'],
}) as WindowButtonLayout;

const WINDOW_BUTTONS: readonly string[] = ['minimize', 'maximize', 'close'];

const parseSide = (side: string): WindowButton[] => {
  const buttons: WindowButton[] = [];
  for (const name of side.split(',').map(part => part.trim())) {
    if (WINDOW_BUTTONS.includes(name) && !buttons.includes(name as WindowButton)) {
      buttons.push(name as WindowButton);
    }
  }
  return buttons;
};

/**
 * Parses GTK's `gtk-decoration-layout` (`appmenu:minimize,maximize,close`, `close:`...).
 * Buttons before the first colon go at the start of the title bar, the rest at the end; without
 * a colon they all go at the start, as in GTK. Other entries (`appmenu`, `icon`, `menu`,
 * `spacer`) are ignored. A missing or empty layout keeps the default.
 */
export function parseWindowButtonLayout(layout: string | null | undefined): WindowButtonLayout {
  if (!layout?.trim()) return DEFAULT_WINDOW_BUTTON_LAYOUT;
  const colon = layout.indexOf(':');
  if (colon < 0) return { start: parseSide(layout), end: [] };
  return { start: parseSide(layout.slice(0, colon)), end: parseSide(layout.slice(colon + 1)) };
}
