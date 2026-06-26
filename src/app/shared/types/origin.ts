export const ORIGINS = [
  'dashboard',
  'automation',
  'filemanager',
  'startup',
  'update',
  'internal',
] as const;

export type Origin = (typeof ORIGINS)[number];
