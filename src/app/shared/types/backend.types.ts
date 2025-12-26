// Backend management types
// These match the Rust backend types for type safety

export interface BackendInfo {
  name: string;
  backend_type: 'local' | 'remote';
  host: string;
  port: number;
  is_active: boolean;
  status: string;
  username?: string;
  password?: string;
  config_password?: string;
  oauth_host?: string;
  oauth_port?: number;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  version?: string;
}

export interface AddBackendConfig {
  name: string;
  host: string;
  port: number;
  backend_type: 'local' | 'remote';
  username?: string;
  password?: string;
  config_password?: string;
}
