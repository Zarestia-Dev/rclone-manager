import { describe, it, expect } from 'vitest';
import { OPERATION_REGISTRY } from './operation-registry';
import { PILL_TONES, PILL_TONE_VAR, isPillTone } from './pill';

describe('pill tones', () => {
  it.each(PILL_TONES)('recognises %s and knows its colour token', tone => {
    expect(isPillTone(tone)).toBe(true);
    expect(PILL_TONE_VAR[tone]).toMatch(/^var\(--[a-z-]+\)$/);
  });

  it.each([undefined, null, '', 'p-accent', 'Accent', 'success', 42, {}])('rejects %j', value => {
    expect(isPillTone(value)).toBe(false);
  });

  it('gives every operation a tone', () => {
    for (const op of OPERATION_REGISTRY) expect(isPillTone(op.tone)).toBe(true);
  });
});
