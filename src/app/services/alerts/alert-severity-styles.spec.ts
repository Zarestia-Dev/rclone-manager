import { describe, expect, it } from 'vitest';
import { SEVERITY_STYLES } from './alert.service';

describe('SEVERITY_STYLES', () => {
  it('gives every severity a text colour derived for text, not its fill colour', () => {
    for (const [severity, style] of Object.entries(SEVERITY_STYLES)) {
      const fill = style.color.match(/^var\((--[\w-]+)\)$/)?.[1];
      expect(fill, severity).toBeTruthy();
      // --primary-color has --primary-color-text; --orange has --orange-text.
      expect(style.text, severity).toBe(`var(${fill}-text)`);
    }
  });
});
