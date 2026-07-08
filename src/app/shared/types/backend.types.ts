// Backend management types
// These match the Rust backend types for type safety

export type RuntimeStatus =
  | { type: 'unknown' }
  | { type: 'connected' }
  | { type: 'inactive' }
  | { type: 'error'; message: string };

export interface BackendInfo {
  name: string;
  isLocal: boolean;
  isAuthGenerated: boolean;
  host: string;
  oauthHost?: string;
  port: number;
  isActive: boolean;
  hasAuth: boolean;
  hasConfigPassword: boolean;
  oauthPort?: number;
  username?: string;
  password?: string;
  version?: string;
  os?: string;
  status?: RuntimeStatus;
  configPath?: string;
  /** Actual config path being used by rclone (fetched at runtime) */
  runtimeConfigPath?: string;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  version?: string;
  os?: string;
  config_path?: string;
}

export interface AddBackendArgs {
  name: string;
  host: string;
  port: number;
  isLocal: boolean;
  username?: string;
  password?: string;
  configPassword?: string;
  configPath?: string;
  oauthPort?: number;
  oauthHost?: string;
  copyBackendFrom?: string | null;
  copyRemotesFrom?: string | null;
}
