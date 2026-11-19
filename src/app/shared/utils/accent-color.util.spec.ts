import { describe, expect, it } from 'vitest';
import { accentPalette } from './accent-color.util';

describe('accentPalette', () => {
  it('derives the same text colours as libadwaita for its default blue', () => {
    expect(accentPalette('#3584e4')).toEqual({
      background: '#3584e4',
      backgroundRgb: '53, 132, 228',
      light: '#0461be',
      dark: '#81d0ff',
    });
  });

  it('keeps an accent that is already dark enough or light enough', () => {
    const palette = accentPalette('#1A5FB4');
    expect(palette?.background).toBe('#1a5fb4');
    expect(palette?.light).toBe('#1a5fb4');
    expect(accentPalette('#ffffff')?.dark).toBe('#ffffff');
  });

  it.each([null, undefined, '', 'blue', '#fff', '#12345g', 'rgb(1, 2, 3)'])('ignores %s', color => {
    expect(accentPalette(color)).toBeNull();
  });
});
