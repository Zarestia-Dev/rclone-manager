// Backend management types
// These match the Rust backend types for type safety

export interface BackendInfo {
  name: string;
  isLocal: boolean;
  host: string;
  port: number;
  isActive: boolean;
  hasAuth: boolean;
  hasConfigPassword: boolean;
  oauthPort?: number;
  username?: string;
  password?: string;
  version?: string;
  os?: string;
  status?: string;
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

export interface AddBackendConfig {
  name: string;
  host: string;
  port: number;
  isLocal: boolean;
  username?: string;
  password?: string;
  configPassword?: string;
  configPath?: string;
  oauthPort?: number;
}

export interface SettingOption {
  value: unknown;
  label: string;
  description?: string;
}

export interface BackendSettingMetadata {
  setting_type: 'toggle' | 'text' | 'number' | 'select' | 'info' | 'list';
  default: unknown;
  value?: unknown;
  constraints: {
    text?: { pattern?: string };
    number?: { min?: number; max?: number; step?: number };
    options?: SettingOption[];
    list?: { reserved?: string[] };
  };
  metadata: {
    label?: string;
    description?: string;
    placeholder?: string;
    input_type?: string;
    group?: string;
    order?: number;
    [key: string]: unknown;
  };
}
