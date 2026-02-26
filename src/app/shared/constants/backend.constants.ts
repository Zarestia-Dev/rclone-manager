/**
 * Shared constants for Backend Configuration
 */
export const BACKEND_CONSTANTS = {
  // Backend Types
  TYPE: {
    LOCAL: 'Local',
    REMOTE: 'Remote',
  },

  // Field Groups (matches Rust strict definitions)
  GROUPS: {
    CONNECTION: 'connection',
    AUTHENTICATION: 'authentication',
    OAUTH: 'oauth',
    SECURITY: 'security',
    ADVANCED: 'advanced',
  },

  // Default Values
  DEFAULTS: {
    HOST: 'localhost',
    IP: '127.0.0.1',
    PORT: 51900,
    OAUTH_PORT: 51901,
  },

  // Status Strings
  STATUS: {
    CONNECTED: 'connected',
    ERROR_PREFIX: 'error',
    UNKNOWN: 'unknown',
  },

  // Icons
  ICONS: {
    LOCAL: 'home',
    REMOTE: 'cloud',
    LINUX: 'linux',
    APPLE: 'apple',
    WINDOWS: 'windows',
    GLOBE: 'globe',
    USER: 'user',
    LOCK: 'lock',
    KEY: 'key',
    FILE: 'file-lines',
    EYE: 'eye',
    EYE_SLASH: 'eye-slash',
  },
} as const;
