import { describe, it, expect } from 'vitest';
import { generateCubicBezierPath, getCubicBezierMidpoint } from './bezier.util';

describe('bezier.util', () => {
  it('generates a valid SVG cubic bezier string', () => {
    const path = generateCubicBezierPath(100, 100, 300, 200);
    expect(path).toMatch(/^M 100 100 C \d+ 100, \d+ 200, 300 200$/);
  });

  it('calculates the midpoint of a horizontal bezier curve', () => {
    const mid = getCubicBezierMidpoint(0, 100, 200, 100);
    expect(mid.x).toBeCloseTo(100, 0);
    expect(mid.y).toBeCloseTo(100, 0);
  });

  it('calculates the midpoint of a diagonal bezier curve', () => {
    const mid = getCubicBezierMidpoint(0, 0, 200, 200);
    expect(mid.x).toBeCloseTo(100, 0);
    expect(mid.y).toBeCloseTo(100, 0);
  });
});
