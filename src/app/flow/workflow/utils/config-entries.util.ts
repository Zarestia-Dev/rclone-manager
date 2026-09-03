import { getRcloneCfg } from '../../../shared/utils/profile-config.util';

export interface ActiveConfigItem {
  category: 'operation' | 'filter' | 'backend' | 'vfs' | 'general';
  key: string;
  value: string;
  path: string;
}

export const PRIMARY_EXCLUDED_KEYS = new Set([
  'title',
  'subtitle',
  'targetMode',
  'remote',
  'remoteName',
  'srcFs',
  'dstFs',
  'mountPoint',
  'fs',
  'path1',
  'path2',
  'source',
  'dest',
  'cronExpression',
  'watchPaths',
  'debounceSeconds',
  'globPattern',
  'recursive',
  'targetProfileId',
  'eventState',
  'command',
  'args',
  'argsRaw',
  'workingDir',
  'failOnError',
  'timeoutSeconds',
  'quickRunId',
  'status',
  'action',
  'seconds',
  'delaySeconds',
  'operator',
  'leftValue',
  'rightValue',
  'severity',
  'message',
  'path',
  'options',
  'filter_options',
  'backend_options',
  'vfs_options',
  'app',
  'config',
  'rclone',
]);

function formatConfigValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Extracts active non-default and advanced config flags from a node configuration object.
 */
export function extractActiveConfigEntries(
  cfg: Record<string, unknown> | null | undefined
): ActiveConfigItem[] {
  if (!cfg || typeof cfg !== 'object') return [];

  const items: ActiveConfigItem[] = [];

  const targetObj = (
    cfg['config'] && typeof cfg['config'] === 'object' ? cfg['config'] : cfg
  ) as Record<string, unknown>;
  const rclone =
    getRcloneCfg(targetObj) ??
    (targetObj['rclone'] as Record<string, unknown> | undefined) ??
    targetObj;

  if (rclone && typeof rclone === 'object') {
    // 1. Shared sections (vfs, filter, backend, runtimeRemote)
    for (const section of ['vfs', 'filter', 'backend', 'runtimeRemote'] as const) {
      const secObj = (rclone[section] ?? targetObj[`${section}_options`] ?? targetObj[section]) as
        Record<string, unknown> | undefined;
      if (secObj && typeof secObj === 'object') {
        for (const [k, v] of Object.entries(secObj)) {
          if (v !== undefined && v !== null && v !== '') {
            items.push({
              category: section === 'runtimeRemote' ? 'general' : section,
              key: k,
              value: formatConfigValue(v),
              path: `config.rclone.${section}.${k}`,
            });
          }
        }
      }
    }

    // 2. Options object (if present in targetObj.options)
    if (targetObj['options'] && typeof targetObj['options'] === 'object') {
      for (const [k, v] of Object.entries(targetObj['options'] as Record<string, unknown>)) {
        if (v !== undefined && v !== null && v !== '' && !PRIMARY_EXCLUDED_KEYS.has(k)) {
          if (typeof v !== 'object') {
            items.push({
              category: 'operation',
              key: k,
              value: formatConfigValue(v),
              path: `config.rclone.${k}`,
            });
          }
        }
      }
    }

    // 3. Direct options on rclone
    for (const [k, v] of Object.entries(rclone)) {
      if (
        [
          'vfs',
          'filter',
          'backend',
          'runtimeRemote',
          'options',
          'filter_options',
          'backend_options',
          'vfs_options',
        ].includes(k)
      ) {
        continue;
      }
      if (!PRIMARY_EXCLUDED_KEYS.has(k) && v !== undefined && v !== null && v !== '') {
        if (typeof v !== 'object') {
          items.push({
            category: 'operation',
            key: k,
            value: formatConfigValue(v),
            path: `config.rclone.${k}`,
          });
        }
      }
    }
  } else {
    // Fallback for non-operation nodes
    for (const [k, v] of Object.entries(cfg)) {
      if (!PRIMARY_EXCLUDED_KEYS.has(k) && v !== undefined && v !== null && v !== '') {
        if (typeof v !== 'object') {
          items.push({ category: 'general', key: k, value: formatConfigValue(v), path: k });
        }
      }
    }
  }

  return items;
}
