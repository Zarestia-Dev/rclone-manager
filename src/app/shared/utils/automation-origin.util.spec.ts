import { describe, expect, it } from 'vitest';
import { Automation } from '@app/types';
import { matchesOriginFilter } from './automation-origin.util';

const withSource = (source?: string): Automation =>
  ({ id: 'a', args: source ? { source } : {} }) as unknown as Automation;

describe('matchesOriginFilter', () => {
  it('keeps everything under "all", including automations without arguments', () => {
    for (const automation of [withSource('workflow'), withSource(), {} as Automation]) {
      expect(matchesOriginFilter(automation, 'all')).toBe(true);
    }
  });

  it('counts profile automations as dashboard, and Quick Runs and workflows as their own', () => {
    expect(matchesOriginFilter(withSource(), 'dashboard')).toBe(true);
    expect(matchesOriginFilter(withSource('automation'), 'dashboard')).toBe(true);
    expect(matchesOriginFilter({} as Automation, 'dashboard')).toBe(true);
    expect(matchesOriginFilter(withSource('quickrun'), 'dashboard')).toBe(false);
    expect(matchesOriginFilter(withSource('workflow'), 'dashboard')).toBe(false);
    expect(matchesOriginFilter(withSource('workflow'), 'workflow')).toBe(true);
    expect(matchesOriginFilter(withSource('quickrun'), 'workflow')).toBe(false);
    expect(matchesOriginFilter(withSource('quickrun'), 'quickrun')).toBe(true);
  });
});
