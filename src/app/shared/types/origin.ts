export type Origin = 'dashboard' | 'scheduler' | 'filemanager' | 'startup' | 'update' | 'internal';

export const ORIGINS = {
  DASHBOARD: 'dashboard' as Origin,
  SCHEDULER: 'scheduler' as Origin,
  FILEMANAGER: 'filemanager' as Origin,
  STARTUP: 'startup' as Origin,
  UPDATE: 'update' as Origin,
  INTERNAL: 'internal' as Origin,
};
