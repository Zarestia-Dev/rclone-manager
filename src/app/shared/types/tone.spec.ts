import { describe, it, expect } from 'vitest';
import { OPERATION_REGISTRY, OPERATION_TONE } from './operation-registry';
import { ALL_PANELS, ALL_QUICK_RUN_PANELS, PANEL_TONE } from './ui';
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

describe('overview panel tones', () => {
  it('gives every panel of every overview a tone', () => {
    for (const panel of [...ALL_PANELS, ...ALL_QUICK_RUN_PANELS]) {
      expect(isPillTone(PANEL_TONE[panel.id])).toBe(true);
    }
  });

  it('reads the tone of mounts and serves from their operations', () => {
    expect(PANEL_TONE.mounts).toBe(OPERATION_TONE['mount']);
    expect(PANEL_TONE.serves).toBe(OPERATION_TONE['serve']);
    expect(PANEL_TONE.serves).toBe('accent');
  });

  it('keeps automations out of the accent colour that mounts and serves use', () => {
    expect(PANEL_TONE.automations).not.toBe('accent');
  });
});
