export const VAULT_WAVE_DURATION_MS = 9000;

export interface VaultWaveCell {
  id: string;
  x: number;
  y: number;
  delay: number;
}

/** Sparse cells on the same staggered lattice as the repeating SVG texture. */
export function createVaultWaveCells(
  width: number,
  height: number,
  tileWidth: number,
  tileHeight: number,
  seed: number
): VaultWaveCell[] {
  if (![width, height, tileWidth, tileHeight, seed].every(Number.isFinite)) return [];
  if (width <= 0 || height <= 0 || tileWidth <= 0 || tileHeight <= 0) return [];

  const columns = Math.ceil(width / tileWidth);
  const rows = Math.ceil((height * 2) / tileHeight);
  // Keep decoration bounded even on unusually large displays or tiny texture sizes.
  if ((columns + 1) * (rows + 1) > 20000) return [];
  const cells: (VaultWaveCell & { priority: number })[] = [];
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const hash = Math.abs(Math.sin(row * 127.1 + column * 311.7 + seed) * 43758.5453);
      const random = hash - Math.floor(hash);
      if (random > 0.12) continue;
      const x = (column + (row % 2) / 2) * tileWidth;
      const y = (row * tileHeight) / 2;
      if (x > width || y > height) continue;
      cells.push({
        id: `${row}-${column}`,
        x,
        y,
        delay: (x / width) * VAULT_WAVE_DURATION_MS + random * 1800,
        priority: random,
      });
    }
  }
  // Bound animation work and sample across the screen, rather than just the top rows.
  return cells
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 48)
    .map(({ id, x, y, delay }) => ({
      id,
      x,
      y,
      delay,
    }));
}

/** Normalized pointer position, bounded so leaving the viewport cannot over-rotate the HUD. */
export function getVaultPointerPosition(
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number } | null {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  return { x: clamp(x / width) * 2 - 1, y: clamp(y / height) * 2 - 1 };
}
