// Backend management types
// These match the Rust backend types for type safety

export interface BackendInfo {
  name: string;
  is_local: boolean;
  host: string;
  port: number;
  is_active: boolean;
  has_auth: boolean;
  has_config_password: boolean;
  oauth_port?: number;
  username?: string;
  version?: string;
  os?: string;
  status?: string;
  config_path?: string;
  /** Actual config path being used by rclone (fetched at runtime) */
  runtime_config_path?: string;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  version?: string;
  os?: string;
  config_path?: string;
}

export interface AddBackendConfig {
  name: string;
  host: string;
  port: number;
  is_local: boolean;
  username?: string;
  password?: string;
  /** Password for encrypted rclone config (remote backends only) */
  config_password?: string;
  /** Custom config file path (remote backends only) */
  config_path?: string;
  /** OAuth callback port (Local backend only) */
  oauth_port?: number;
}
