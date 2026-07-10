import { AppConfig, ProfileConfig } from '@app/types';

export type RcloneSubConfig = NonNullable<ProfileConfig['rclone']>;

export interface ConfigWithSubConfigs {
  app?: AppConfig;
  rclone?: unknown;
}

export function getAppCfg<T extends object>(config: T | undefined | null): AppConfig | null {
  if (!config) return null;
  const maybeApp = (config as ConfigWithSubConfigs).app;
  return maybeApp && typeof maybeApp === 'object' ? maybeApp : null;
}

export function getRcloneCfg<T extends object>(
  config: T | undefined | null
): RcloneSubConfig | null {
  if (!config) return null;
  const maybeRclone = (config as ConfigWithSubConfigs).rclone;
  return maybeRclone && typeof maybeRclone === 'object' ? (maybeRclone as RcloneSubConfig) : null;
}

export function getFormConfig(
  config: ProfileConfig | undefined | null
): ProfileConfig | RcloneSubConfig | null {
  if (config == null) return null;
  const rclone = getRcloneCfg(config);
  return rclone ?? config;
}
