export const ORIGINS = [
  'dashboard',
  'automation',
  'filemanager',
  'startup',
  'update',
  'internal',
  'flow',
] as const;

export type Origin = (typeof ORIGINS)[number];
