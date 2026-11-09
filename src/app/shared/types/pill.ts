/** Colour role of a pill. Each maps to exactly one semantic colour token in `custom-theme.scss`. */
export const PILL_TONES = [
  'primary',
  'accent',
  'orange',
  'yellow',
  'purple',
  'warn',
  'dim',
] as const;
export type PillTone = (typeof PILL_TONES)[number];

/** Emphasis of a pill: `tonal` (tinted, the default), `solid` (filled) or `outline`. */
export const PILL_VARIANTS = ['tonal', 'solid', 'outline'] as const;
export type PillVariant = (typeof PILL_VARIANTS)[number];

/** Height of a pill: `xs` 20px, `sm` 24px, `md` 28px (the default). */
export type PillSize = 'xs' | 'sm' | 'md';

export function isPillTone(value: unknown): value is PillTone {
  return typeof value === 'string' && (PILL_TONES as readonly string[]).includes(value);
}

/** The colour token of each tone, for the few places that cannot read the tone scope (gradients). */
export const PILL_TONE_VAR: Readonly<Record<PillTone, string>> = Object.freeze({
  primary: 'var(--primary-color)',
  accent: 'var(--accent-color)',
  orange: 'var(--orange)',
  yellow: 'var(--yellow)',
  purple: 'var(--purple)',
  warn: 'var(--warn-color)',
  dim: 'var(--dim-color)',
});
