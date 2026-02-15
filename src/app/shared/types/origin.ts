export type Origin =
  | 'ui'
  | 'tray'
  | 'internal'
  | 'nautilus'
  | 'dashboard'
  | 'scheduled'
  | 'system'
  | 'api';

export const ORIGINS = {
  UI: 'ui' as Origin,
  TRAY: 'tray' as Origin,
  INTERNAL: 'internal' as Origin,
  NAUTILUS: 'nautilus' as Origin,
  DASHBOARD: 'dashboard' as Origin,
  SCHEDULED: 'scheduled' as Origin,
  SYSTEM: 'system' as Origin,
  API: 'api' as Origin,
};
