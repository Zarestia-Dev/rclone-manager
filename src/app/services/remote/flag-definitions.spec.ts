import { describe, expect, it } from 'vitest';
import { staticFlagDefinitions } from './flag-definitions';

const kebab = (name: string): string => name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

describe('staticFlagDefinitions', () => {
  it('offers cryptcheck only the options `rclone cryptcheck` has', () => {
    // rclone cryptcheck takes the report flags of `check`, but not --download or the checkfile ones.
    const cli = [
      'one-way',
      'combined',
      'missing-on-src',
      'missing-on-dst',
      'match',
      'differ',
      'error',
    ];
    const offered = staticFlagDefinitions['cryptcheck'].map(option => kebab(option.FieldName));
    expect(offered.filter(name => !cli.includes(name))).toEqual([]);
    expect(offered).toContain('one-way');
  });
});
