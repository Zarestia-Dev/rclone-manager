import { AppConfig, ProfileConfig } from '@app/types';

export type RcloneSubConfig = NonNullable<ProfileConfig['rclone']>;

export interface ConfigWithSubConfigs {
  app?: AppConfig;
  rclone?: Record<string, unknown>;
}

/** Internal helper shared by both getAppCfg and getRcloneCfg — avoids the previous duplication. */
function pickSubConfig<TKey extends 'app' | 'rclone'>(
  config: unknown,
  key: TKey
): TKey extends 'app' ? AppConfig | null : RcloneSubConfig | null {
  if (!config || typeof config !== 'object') return null;
  const value = (config as ConfigWithSubConfigs)[key];
  // `value && typeof value === 'object'` filters out null/undefined/primitives.
  return value && typeof value === 'object'
    ? (value as TKey extends 'app' ? AppConfig : RcloneSubConfig)
    : null;
}

export function getAppCfg(config: unknown): AppConfig | null {
  return pickSubConfig(config, 'app');
}

export function getRcloneCfg(config: unknown): RcloneSubConfig | null {
  return pickSubConfig(config, 'rclone');
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
