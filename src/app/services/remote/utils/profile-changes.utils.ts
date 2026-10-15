import { REMOTE_CONFIG_KEYS, RemoteSettings, SharedProfileType } from '@app/types';
import { deepEqual } from '../../../shared/utils';

export const DEFAULT_PROFILE_NAME = 'Default';
export type ProfileConfigMap = Record<string, unknown>;
export type ProfileCollection = Partial<Record<SharedProfileType, ProfileConfigMap>>;

export function createProfileBaseline(settings?: RemoteSettings | null): ProfileCollection {
  const baseline: ProfileCollection = {};
  for (const [type, key] of Object.entries(REMOTE_CONFIG_KEYS)) {
    const value = settings?.[key];
    const hasProfiles =
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0;
    baseline[type as SharedProfileType] = hasProfiles
      ? structuredClone(value as ProfileConfigMap)
      : {};
  }
  return baseline;
}

/** Build a sparse save request and the baseline to adopt only after it succeeds. */
export function buildProfileChanges(
  current: ProfileCollection,
  baseline: ProfileCollection
): {
  settings: Record<string, ProfileConfigMap>;
  expectedSettings: Record<string, ProfileConfigMap>;
  nextBaseline: ProfileCollection;
} {
  const settings: Record<string, ProfileConfigMap> = {};
  const expectedSettings: Record<string, ProfileConfigMap> = {};
  const nextBaseline: ProfileCollection = {};
  for (const [key, section] of Object.entries(REMOTE_CONFIG_KEYS)) {
    const type = key as SharedProfileType;
    const profiles = current[type] ?? {};
    const saved = baseline[type] ?? {};
    for (const name of new Set([...Object.keys(profiles), ...Object.keys(saved)])) {
      if (deepEqual(profiles[name], saved[name])) continue;
      if (Object.prototype.hasOwnProperty.call(profiles, name))
        (settings[section] ??= {})[name] = structuredClone(profiles[name]);
      if (Object.prototype.hasOwnProperty.call(saved, name))
        (expectedSettings[section] ??= {})[name] = structuredClone(saved[name]);
    }
    nextBaseline[type] = structuredClone(profiles);
  }
  return { settings, expectedSettings, nextBaseline };
}
