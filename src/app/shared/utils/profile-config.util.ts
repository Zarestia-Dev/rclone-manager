import { APP_CONFIG_DEFAULTS, AppConfig, ProfileConfig } from '../types/remote-config';

export type RcloneSubConfig = NonNullable<ProfileConfig['rclone']>;

export interface ConfigWithSubConfigs {
  app?: AppConfig;
  rclone?: Record<string, unknown>;
}

function pickSubConfig<T>(config: unknown, key: 'app' | 'rclone'): T | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const value = (config as ConfigWithSubConfigs)[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
}

export function getAppCfg(config: unknown): AppConfig | null {
  return pickSubConfig<AppConfig>(config, 'app');
}

export function getRcloneCfg(config: unknown): RcloneSubConfig | null {
  return pickSubConfig<RcloneSubConfig>(config, 'rclone');
}

/** Resolve only application fields, preserving explicit false and zero overrides. */
export function getAppConfigValues(
  config: Partial<Record<keyof AppConfig, unknown>>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(APP_CONFIG_DEFAULTS).map(([key, defaultValue]) => {
      const value = config[key as keyof AppConfig];
      return [key, value === '' ? defaultValue : (value ?? defaultValue)];
    })
  );
}

/** Normalize legacy flat runtime options into the same remote-scoped map as saved profiles. */
export function getRuntimeRemoteProfiles(
  config: Record<string, unknown>,
  remoteName: string
): Record<string, Record<string, unknown>> {
  const scoped = Object.values(config).every(
    value => value && typeof value === 'object' && !Array.isArray(value)
  );
  return scoped ? (config as Record<string, Record<string, unknown>>) : { [remoteName]: config };
}

export function parseTypedValue(val: string): unknown {
  const trimmed = val.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  try {
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      return JSON.parse(trimmed);
    }
  } catch {
    // fall through to plain string
  }
  return trimmed;
}

export function formatValueDisplay(val: unknown): string {
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

/**
 * Safely extracts the primary source path from an rclone config object.
 * Checks `srcFs`, `path1`, `fs`, `source`, and `url`.
 */
export function extractProfileSource(rclone: Record<string, unknown> | null | undefined): unknown {
  if (!rclone || typeof rclone !== 'object') return undefined;
  return rclone['srcFs'] ?? rclone['path1'] ?? rclone['fs'] ?? rclone['source'] ?? rclone['url'];
}

/**
 * Safely extracts the primary destination/target path from an rclone config object.
 * Checks `mountPoint`, `dstFs`, `path2`, and `dest`.
 */
export function extractProfileDest(rclone: Record<string, unknown> | null | undefined): unknown {
  if (!rclone || typeof rclone !== 'object') return undefined;
  return rclone['mountPoint'] ?? rclone['dstFs'] ?? rclone['path2'] ?? rclone['dest'];
}
