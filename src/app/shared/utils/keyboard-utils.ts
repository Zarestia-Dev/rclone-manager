/**
 * Utility functions for keyboard shortcut handling, parsing, and input focus detection.
 */

/**
 * Checks whether an event originated from an active text input, select, or contenteditable element.
 */
export function isInputFocused(event?: Event | null): boolean {
  if (!event) return false;
  const target = event.target as HTMLElement | null;
  if (!target) return false;

  const tagName = target.tagName;
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    Boolean(target.isContentEditable) ||
    target.contentEditable === 'true' ||
    target.getAttribute?.('contenteditable') === 'true'
  );
}

/**
 * Parses shortcut keys string like 'F5 / Ctrl + R' into normalized combo token arrays:
 * [['F5'], ['Ctrl', 'R']]
 */
export function parseCombos(keysString: string): string[][] {
  if (!keysString) return [];
  return keysString
    .split('/')
    .map(combo =>
      combo
        .split('+')
        .map(k => k.trim())
        .filter(Boolean)
    )
    .filter(combo => combo.length > 0);
}

/**
 * Checks if a single combo (array of key tokens like ['Ctrl', 'Q']) matches a KeyboardEvent.
 */
export function matchesCombo(combo: string[], event: KeyboardEvent): boolean {
  if (!combo || combo.length === 0 || !event) return false;

  const hasCtrl = combo.includes('Ctrl') || combo.includes('Cmd');
  const hasAlt = combo.includes('Alt');
  const hasShift = combo.includes('Shift');

  const isCtrl = Boolean(event.ctrlKey || event.metaKey);
  const isAlt = Boolean(event.altKey);
  const isShift = Boolean(event.shiftKey);

  if (hasCtrl !== isCtrl) return false;
  if (hasAlt !== isAlt) return false;

  const mainKey = combo.find(k => !['Ctrl', 'Cmd', 'Alt', 'Shift'].includes(k));
  if (!mainKey) return false;

  if (mainKey === '?') {
    if (event.key !== '?' && event.key !== '/') return false;
  } else {
    if (hasShift !== isShift) return false;
  }

  const eventKey = event.key;

  switch (mainKey.toLowerCase()) {
    case 'up':
    case 'arrowup':
      return eventKey === 'ArrowUp';
    case 'down':
    case 'arrowdown':
      return eventKey === 'ArrowDown';
    case 'left':
    case 'arrowleft':
      return eventKey === 'ArrowLeft';
    case 'right':
    case 'arrowright':
      return eventKey === 'ArrowRight';
    case 'space':
      return eventKey === ' ' || eventKey === 'Space';
    case 'tab':
      return eventKey === 'Tab';
    case 'enter':
      return eventKey === 'Enter';
    case 'escape':
    case 'esc':
      return eventKey === 'Escape';
    case 'delete':
    case 'del':
      return eventKey === 'Delete';
    case 'backspace':
      return eventKey === 'Backspace';
    case '?':
      return eventKey === '?' || (isShift && eventKey === '/');
    default:
      return eventKey.toLowerCase() === mainKey.toLowerCase();
  }
}

/**
 * Checks if a KeyboardEvent matches any combination in the given shortcut string.
 * Supports multi-combos separated by '/' (e.g. 'F5 / Ctrl + R', 'Delete / Backspace').
 */
export function matchesShortcut(keysString: string, event: KeyboardEvent): boolean {
  const combos = parseCombos(keysString);
  return combos.some(combo => matchesCombo(combo, event));
}
