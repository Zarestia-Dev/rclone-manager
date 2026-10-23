import { describe, expect, it } from 'vitest';
import {
  createVaultWaveCells,
  getVaultPointerPosition,
  VAULT_WAVE_DURATION_MS,
} from './vault-hud-effects';

describe('createVaultWaveCells', () => {
  it('places sparse unique cells on the texture lattice with a left-to-right delay', () => {
    const cells = createVaultWaveCells(1200, 800, 42, 73, 17);
    expect(cells.length).toBeGreaterThan(10);
    expect(new Set(cells.map(cell => cell.id)).size).toBe(cells.length);
    for (const cell of cells) {
      const row = Math.round(cell.y / 36.5);
      expect(cell.x / 42 - (row % 2) / 2).toBeCloseTo(Math.round(cell.x / 42 - (row % 2) / 2));
      expect(cell.y / 36.5).toBeCloseTo(row);
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x).toBeLessThanOrEqual(1200);
      expect(cell.y).toBeLessThanOrEqual(800);
      expect(cell.delay).toBeGreaterThanOrEqual((cell.x / 1200) * VAULT_WAVE_DURATION_MS);
      expect(cell.delay).toBeLessThan((cell.x / 1200) * VAULT_WAVE_DURATION_MS + 216);
    }
  });

  it('keeps the same geometry for shared cells after resizing and varies the seed', () => {
    const first = createVaultWaveCells(800, 600, 42, 73, 17);
    const resized = createVaultWaveCells(1000, 700, 42, 73, 17);
    const shared = first.filter(cell => resized.some(other => other.id === cell.id));
    expect(shared.length).toBeGreaterThan(0);
    for (const cell of shared) {
      expect(resized.find(other => other.id === cell.id)).toMatchObject({ x: cell.x, y: cell.y });
    }
    expect(createVaultWaveCells(800, 600, 42, 73, 17)).toEqual(first);
    expect(createVaultWaveCells(800, 600, 42, 73, 42)).not.toEqual(first);
  });

  it('keeps visible cells throughout each cycle after the initial sweep', () => {
    const cells = createVaultWaveCells(1920, 1080, 42, 73, 17);
    for (let time = VAULT_WAVE_DURATION_MS; time < VAULT_WAVE_DURATION_MS * 2; time += 100) {
      const active = cells.some(cell => {
        const phase = ((time - cell.delay) % VAULT_WAVE_DURATION_MS) / VAULT_WAVE_DURATION_MS;
        return phase >= 0.04 && phase <= 0.32;
      });
      expect(active, `no active cells at ${time}ms`).toBe(true);
    }
  });

  it('bounds the number of animated cells on large displays', () => {
    const cells = createVaultWaveCells(3840, 2160, 42, 73, 17);
    expect(cells).toHaveLength(48);
    expect(cells.some(cell => cell.x > 3840 * 0.75)).toBe(true);
    expect(cells.some(cell => cell.y > 2160 * 0.75)).toBe(true);
    expect(createVaultWaveCells(1e8, 1e8, 1, 1, 17)).toEqual([]);
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid dimensions (%s)', value => {
    expect(createVaultWaveCells(value, 800, 42, 73, 17)).toEqual([]);
    expect(createVaultWaveCells(1200, value, 42, 73, 17)).toEqual([]);
    expect(createVaultWaveCells(1200, 800, value, 73, 17)).toEqual([]);
    expect(createVaultWaveCells(1200, 800, 42, value, 17)).toEqual([]);
  });
});

describe('getVaultPointerPosition', () => {
  it('normalizes center and corners', () => {
    expect(getVaultPointerPosition(100, 50, 200, 100)).toEqual({ x: 0, y: 0 });
    expect(getVaultPointerPosition(0, 0, 200, 100)).toEqual({ x: -1, y: -1 });
    expect(getVaultPointerPosition(200, 100, 200, 100)).toEqual({ x: 1, y: 1 });
  });

  it('clamps coordinates outside the viewport', () => {
    expect(getVaultPointerPosition(-100, 1000, 200, 100)).toEqual({ x: -1, y: 1 });
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid viewport dimensions (%s)', value => {
    expect(getVaultPointerPosition(1, 1, value, 100)).toBeNull();
    expect(getVaultPointerPosition(1, 1, 100, value)).toBeNull();
  });

  it('rejects invalid pointer coordinates', () => {
    expect(getVaultPointerPosition(NaN, 0, 100, 100)).toBeNull();
    expect(getVaultPointerPosition(0, Infinity, 100, 100)).toBeNull();
  });
});
