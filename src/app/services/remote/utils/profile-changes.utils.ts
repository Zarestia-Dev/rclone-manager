import { REMOTE_CONFIG_KEYS, RemoteSettings, SharedProfileType } from '@app/types';
import { deepEqual } from '../../../shared/utils';

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

/** Save complete changed sections so profile deletion and sibling profiles are preserved. */
export function buildProfileChanges(
  current: ProfileCollection,
  baseline: ProfileCollection
): {
  settings: Record<string, ProfileConfigMap>;
  nextBaseline: ProfileCollection;
} {
  const settings: Record<string, ProfileConfigMap> = {};
  const nextBaseline: ProfileCollection = {};
  for (const [key, section] of Object.entries(REMOTE_CONFIG_KEYS)) {
    const type = key as SharedProfileType;
    const profiles = current[type] ?? {};
    const saved = baseline[type] ?? {};
    if (!deepEqual(profiles, saved)) settings[section] = structuredClone(profiles);
    nextBaseline[type] = structuredClone(profiles);
  }
  return { settings, nextBaseline };
}
