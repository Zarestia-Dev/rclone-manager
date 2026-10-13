import { describe, it, expect } from 'vitest';
import { INITIAL_COMMAND_OPTIONS, syncNonInteractiveOption } from './command-options.util';
import { CommandOption } from '@app/types';

describe('command-options.util', () => {
  describe('INITIAL_COMMAND_OPTIONS', () => {
    it('initializes with obscure option by default', () => {
      expect(INITIAL_COMMAND_OPTIONS.length).toBeGreaterThan(0);
      expect(INITIAL_COMMAND_OPTIONS[0].key).toBe('obscure');
      expect(INITIAL_COMMAND_OPTIONS[0].value).toBe(true);
    });
  });

  describe('syncNonInteractiveOption', () => {
    it('adds nonInteractive option if isInteractive is true and option is absent', () => {
      const options: CommandOption[] = [{ key: 'obscure', value: true }];
      const result = syncNonInteractiveOption(options, true);
      expect(result.some(o => o.key === 'nonInteractive')).toBe(true);
      expect(result.find(o => o.key === 'nonInteractive')?.value).toBe(true);
      expect(result.length).toBe(2);
    });

    it('does not duplicate nonInteractive option if already present and isInteractive is true', () => {
      const options: CommandOption[] = [
        { key: 'obscure', value: true },
        { key: 'nonInteractive', value: true },
      ];
      const result = syncNonInteractiveOption(options, true);
      expect(result.filter(o => o.key === 'nonInteractive').length).toBe(1);
    });

    it('removes nonInteractive option if isInteractive is false and option is present', () => {
      const options: CommandOption[] = [
        { key: 'obscure', value: true },
        { key: 'nonInteractive', value: true },
      ];
      const result = syncNonInteractiveOption(options, false);
      expect(result.some(o => o.key === 'nonInteractive')).toBe(false);
      expect(result.length).toBe(1);
    });

    it('returns same list if isInteractive is false and nonInteractive option was not present', () => {
      const options: CommandOption[] = [{ key: 'obscure', value: true }];
      const result = syncNonInteractiveOption(options, false);
      expect(result).toEqual(options);
    });
  });
});
