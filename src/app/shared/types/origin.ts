export type Origin =
  | 'ui'
  | 'tray'
  | 'internal'
  | 'filemanager'
  | 'dashboard'
  | 'scheduler'
  | 'system'
  | 'api';

export const ORIGINS = {
  UI: 'ui' as Origin,
  TRAY: 'tray' as Origin,
  INTERNAL: 'internal' as Origin,
  FILEMANAGER: 'filemanager' as Origin,
  DASHBOARD: 'dashboard' as Origin,
  SCHEDULER: 'scheduler' as Origin,
  SYSTEM: 'system' as Origin,
  API: 'api' as Origin,
};
