import { SharedProfileType } from '@app/types';
import { ImportResult } from '../cli-flag-mapper.service';
import { OPERATION_PATH_MAPPINGS } from './profile-mapper.utils';

export const LINKED_OPTION_TYPES: ReadonlySet<SharedProfileType> = new Set([
  'vfs',
  'filter',
  'backend',
  'runtimeRemote',
]);

export function mergeImportedProfile(
  type: SharedProfileType,
  existing: Record<string, unknown>,
  result: ImportResult,
  importSourcePath: boolean,
  importDestPath: boolean,
  remoteName: string
): Record<string, unknown> {
  // Linked types store options as a flat map.
  if (type === 'vfs' || type === 'filter' || type === 'backend') {
    return mergeImportedFlags(existing, result, type);
  }

  // runtimeRemote scopes options under { [remoteName]: opts }.
  if (type === 'runtimeRemote') {
    const opts = (existing[remoteName] as Record<string, unknown>) ?? existing;
    return { ...existing, [remoteName]: mergeImportedFlags(opts, result, type) };
  }

  // Operation types store options under { app, rclone }.
  const existingApp = (existing['app'] as Record<string, unknown>) ?? {};
  const rclone: Record<string, unknown> = {
    ...((existing['rclone'] as Record<string, unknown>) ?? {}),
  };

  const mapping = OPERATION_PATH_MAPPINGS[type];
  if (mapping) {
    if (result.sourcePath && importSourcePath) {
      rclone[mapping.sourceKey] = mapping.isSourceArray ? [result.sourcePath] : result.sourcePath;
    }
    if (mapping.destKey && result.destPath && importDestPath) {
      rclone[mapping.destKey] = result.destPath;
    }
    if (type === 'mount' && result.mountSubtype) rclone['mountType'] = result.mountSubtype;
    if (type === 'serve' && result.serveSubtype) rclone['type'] = result.serveSubtype;
  }

  for (const cls of result.classified) {
    if (cls.status !== 'mapped' || !cls.fieldName) continue;
    const flagType = (cls.flagType || type) as SharedProfileType;
    if (flagType !== type && LINKED_OPTION_TYPES.has(flagType)) continue;
    rclone[cls.fieldName] = cls.coercedValue;
  }

  return { ...existing, app: { ...existingApp }, rclone };
}

export function mergeImportedFlags(
  existing: Record<string, unknown>,
  result: ImportResult,
  type: SharedProfileType
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const cls of result.classified) {
    if (cls.status !== 'mapped' || !cls.fieldName) continue;
    const flagType = (cls.flagType || type) as SharedProfileType;
    if (flagType !== type) continue;
    merged[cls.fieldName] = cls.coercedValue;
  }
  return merged;
}
