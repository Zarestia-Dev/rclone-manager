export const ORIGINS = [
  'dashboard',
  'automation',
  'filemanager',
  'startup',
  'update',
  'internal',
  'flow',
  'quickrun',
] as const;

export type Origin = (typeof ORIGINS)[number];
