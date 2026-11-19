import { DEFAULT_WINDOW_BUTTON_LAYOUT, parseWindowButtonLayout } from './window-button-layout.util';

describe('parseWindowButtonLayout', () => {
  it('reads the GNOME default, which only has a close button', () => {
    expect(parseWindowButtonLayout('appmenu:close')).toEqual({ start: [], end: ['close'] });
  });

  it('keeps the order and side of each button', () => {
    expect(parseWindowButtonLayout('icon:minimize,maximize,close')).toEqual({
      start: [],
      end: ['minimize', 'maximize', 'close'],
    });
    expect(parseWindowButtonLayout('close,minimize,maximize:menu')).toEqual({
      start: ['close', 'minimize', 'maximize'],
      end: [],
    });
    expect(parseWindowButtonLayout('close:maximize')).toEqual({
      start: ['close'],
      end: ['maximize'],
    });
  });

  it('puts every button at the start when there is no colon', () => {
    expect(parseWindowButtonLayout('close,minimize')).toEqual({
      start: ['close', 'minimize'],
      end: [],
    });
  });

  it('ignores unknown entries, spaces, empty parts and duplicates', () => {
    expect(parseWindowButtonLayout(' spacer , close ::, minimize,,minimize,foo')).toEqual({
      start: ['close'],
      end: ['minimize'],
    });
    expect(parseWindowButtonLayout('appmenu: minimize ,close,close')).toEqual({
      start: [],
      end: ['minimize', 'close'],
    });
  });

  it('allows a layout without any window buttons', () => {
    expect(parseWindowButtonLayout('appmenu:')).toEqual({ start: [], end: [] });
  });

  it('falls back to the default for a missing or empty layout', () => {
    for (const layout of [null, undefined, '', '   ']) {
      expect(parseWindowButtonLayout(layout)).toBe(DEFAULT_WINDOW_BUTTON_LAYOUT);
    }
  });
});
