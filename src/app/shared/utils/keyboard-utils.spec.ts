import { describe, it, expect } from 'vitest';
import { isInputFocused, parseCombos, matchesCombo, matchesShortcut } from './keyboard-utils';

describe('keyboard-utils', () => {
  describe('isInputFocused', () => {
    it('returns false for null or undefined event', () => {
      expect(isInputFocused(null)).toBe(false);
      expect(isInputFocused(undefined)).toBe(false);
    });

    it('returns false when event target is not an input element', () => {
      const div = document.createElement('div');
      const event = new KeyboardEvent('keydown');
      Object.defineProperty(event, 'target', { value: div });
      expect(isInputFocused(event)).toBe(false);
    });

    it('returns true for INPUT, TEXTAREA, and SELECT elements', () => {
      for (const tag of ['input', 'textarea', 'select']) {
        const el = document.createElement(tag);
        const event = new KeyboardEvent('keydown');
        Object.defineProperty(event, 'target', { value: el });
        expect(isInputFocused(event)).toBe(true);
      }
    });

    it('returns true when element is contentEditable', () => {
      const div = document.createElement('div');
      div.contentEditable = 'true';
      const event = new KeyboardEvent('keydown');
      Object.defineProperty(event, 'target', { value: div });
      expect(isInputFocused(event)).toBe(true);
    });

    it('returns true when element has contenteditable attribute set to true', () => {
      const span = document.createElement('span');
      span.setAttribute('contenteditable', 'true');
      const event = new KeyboardEvent('keydown');
      Object.defineProperty(event, 'target', { value: span });
      expect(isInputFocused(event)).toBe(true);
    });
  });

  describe('parseCombos', () => {
    it('returns empty array for empty or whitespace string', () => {
      expect(parseCombos('')).toEqual([]);
    });

    it('correctly parses single key', () => {
      expect(parseCombos('Escape')).toEqual([['Escape']]);
      expect(parseCombos('Delete')).toEqual([['Delete']]);
    });

    it('correctly parses single combo with modifiers', () => {
      expect(parseCombos('Ctrl + Q')).toEqual([['Ctrl', 'Q']]);
      expect(parseCombos('Ctrl + Shift + N')).toEqual([['Ctrl', 'Shift', 'N']]);
      expect(parseCombos('Ctrl + Alt + A')).toEqual([['Ctrl', 'Alt', 'A']]);
    });

    it('correctly parses multi-combos separated by /', () => {
      expect(parseCombos('F5 / Ctrl + R')).toEqual([['F5'], ['Ctrl', 'R']]);
      expect(parseCombos('Backspace / Alt + Up')).toEqual([['Backspace'], ['Alt', 'Up']]);
      expect(parseCombos('Delete / Backspace')).toEqual([['Delete'], ['Backspace']]);
    });
  });

  describe('matchesCombo', () => {
    it('returns false for empty combo or event', () => {
      const event = new KeyboardEvent('keydown', { key: 'q', ctrlKey: true });
      expect(matchesCombo([], event)).toBe(false);
      expect(matchesCombo(['Ctrl', 'Q'], null as unknown as KeyboardEvent)).toBe(false);
    });

    it('matches Ctrl modifier correctly', () => {
      const matchEvent = new KeyboardEvent('keydown', { key: 'q', ctrlKey: true });
      const noCtrlEvent = new KeyboardEvent('keydown', { key: 'q', ctrlKey: false });
      const extraShiftEvent = new KeyboardEvent('keydown', {
        key: 'q',
        ctrlKey: true,
        shiftKey: true,
      });

      expect(matchesCombo(['Ctrl', 'Q'], matchEvent)).toBe(true);
      expect(matchesCombo(['Ctrl', 'Q'], noCtrlEvent)).toBe(false);
      expect(matchesCombo(['Ctrl', 'Q'], extraShiftEvent)).toBe(false);
    });

    it('matches Cmd modifier as equivalent to Ctrl', () => {
      const metaEvent = new KeyboardEvent('keydown', { key: 'q', metaKey: true });
      expect(matchesCombo(['Cmd', 'Q'], metaEvent)).toBe(true);
      expect(matchesCombo(['Ctrl', 'Q'], metaEvent)).toBe(true);
    });

    it('matches Alt and Shift modifiers correctly', () => {
      const combo = ['Ctrl', 'Shift', 'N'];
      const correctEvent = new KeyboardEvent('keydown', {
        key: 'N',
        ctrlKey: true,
        shiftKey: true,
      });
      const missingShift = new KeyboardEvent('keydown', {
        key: 'n',
        ctrlKey: true,
        shiftKey: false,
      });

      expect(matchesCombo(combo, correctEvent)).toBe(true);
      expect(matchesCombo(combo, missingShift)).toBe(false);
    });

    it('matches arrow keys correctly', () => {
      expect(
        matchesCombo(['Alt', 'Up'], new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true }))
      ).toBe(true);
      expect(
        matchesCombo(
          ['Alt', 'Down'],
          new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true })
        )
      ).toBe(true);
      expect(
        matchesCombo(
          ['Alt', 'Left'],
          new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true })
        )
      ).toBe(true);
      expect(
        matchesCombo(
          ['Alt', 'Right'],
          new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true })
        )
      ).toBe(true);
    });

    it('matches special keys: Space, Tab, Enter, Escape, Delete, Backspace', () => {
      expect(matchesCombo(['Space'], new KeyboardEvent('keydown', { key: ' ' }))).toBe(true);
      expect(matchesCombo(['Space'], new KeyboardEvent('keydown', { key: 'Space' }))).toBe(true);
      expect(matchesCombo(['Tab'], new KeyboardEvent('keydown', { key: 'Tab' }))).toBe(true);
      expect(matchesCombo(['Enter'], new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
      expect(matchesCombo(['Escape'], new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
      expect(matchesCombo(['Delete'], new KeyboardEvent('keydown', { key: 'Delete' }))).toBe(true);
      expect(matchesCombo(['Backspace'], new KeyboardEvent('keydown', { key: 'Backspace' }))).toBe(
        true
      );
    });

    it('matches ? key via Shift + / or direct ?', () => {
      const shiftSlash = new KeyboardEvent('keydown', { key: '/', shiftKey: true, ctrlKey: true });
      const directQuestion = new KeyboardEvent('keydown', { key: '?', ctrlKey: true });
      const normalSlash = new KeyboardEvent('keydown', { key: '/', ctrlKey: true });

      expect(matchesCombo(['Ctrl', '?'], shiftSlash)).toBe(true);
      expect(matchesCombo(['Ctrl', '?'], directQuestion)).toBe(true);
      expect(matchesCombo(['Ctrl', '?'], normalSlash)).toBe(false);
    });
  });

  describe('matchesShortcut', () => {
    it('matches single combo shortcut string', () => {
      const event = new KeyboardEvent('keydown', { key: 'q', ctrlKey: true });
      expect(matchesShortcut('Ctrl + Q', event)).toBe(true);
      expect(matchesShortcut('Ctrl + B', event)).toBe(false);
    });

    it('matches multi-combo shortcut string', () => {
      const f5Event = new KeyboardEvent('keydown', { key: 'F5' });
      const ctrlREvent = new KeyboardEvent('keydown', { key: 'r', ctrlKey: true });
      const otherEvent = new KeyboardEvent('keydown', { key: 'r' });

      expect(matchesShortcut('F5 / Ctrl + R', f5Event)).toBe(true);
      expect(matchesShortcut('F5 / Ctrl + R', ctrlREvent)).toBe(true);
      expect(matchesShortcut('F5 / Ctrl + R', otherEvent)).toBe(false);
    });

    it('matches Delete / Backspace correctly', () => {
      const delEvent = new KeyboardEvent('keydown', { key: 'Delete' });
      const backEvent = new KeyboardEvent('keydown', { key: 'Backspace' });
      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter' });

      expect(matchesShortcut('Delete / Backspace', delEvent)).toBe(true);
      expect(matchesShortcut('Delete / Backspace', backEvent)).toBe(true);
      expect(matchesShortcut('Delete / Backspace', enterEvent)).toBe(false);
    });
  });
});
