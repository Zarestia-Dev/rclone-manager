import { describe, it, expect } from 'vitest';
import { TYPE_DEFAULT_EXAMPLES } from './remote-config-examples.constant';

describe('remote-config-examples.constant', () => {
  describe('TYPE_DEFAULT_EXAMPLES', () => {
    it('should define examples for common rclone types', () => {
      expect(TYPE_DEFAULT_EXAMPLES['Duration']).toBeDefined();
      expect(TYPE_DEFAULT_EXAMPLES['SizeSuffix']).toBeDefined();
      expect(TYPE_DEFAULT_EXAMPLES['CountSuffix']).toBeDefined();
      expect(TYPE_DEFAULT_EXAMPLES['BwTimetable']).toBeDefined();
      expect(TYPE_DEFAULT_EXAMPLES['FileMode']).toBeDefined();
      expect(TYPE_DEFAULT_EXAMPLES['Tristate']).toBeDefined();
    });

    it('should have valid Value and translation key Help for every type example', () => {
      for (const [_type, examples] of Object.entries(TYPE_DEFAULT_EXAMPLES)) {
        expect(examples.length).toBeGreaterThan(0);
        for (const ex of examples) {
          expect(ex.Value).toBeDefined();
          expect(ex.Help).toBeDefined();
          expect(ex.Help).toMatch(/^rcloneExamples\.types\./);
        }
      }
    });
  });
});
