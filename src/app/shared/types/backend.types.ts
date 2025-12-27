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
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  version?: string;
  os?: string;
}

export interface AddBackendConfig {
  name: string;
  host: string;
  port: number;
  is_local: boolean;
  username?: string;
  password?: string;
  config_password?: string;
}
