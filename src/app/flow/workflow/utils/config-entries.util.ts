import { getRcloneCfg } from '../../../shared/utils/profile-config.util';
import { RCLONE_PATH_KEYS, formatConfigValue } from '@app/types';
import type { PillTone } from '../../../shared/types/pill';

type ActiveConfigCategory =
  'operation' | 'filter' | 'backend' | 'vfs' | 'general' | 'runtimeRemote';

const CATEGORY_TONE: Record<ActiveConfigCategory, PillTone> = {
  operation: 'accent',
  filter: 'primary',
  backend: 'orange',
  vfs: 'yellow',
  general: 'dim',
  runtimeRemote: 'purple',
};

export interface ActiveConfigItem {
  category: ActiveConfigCategory;
  tone: PillTone;
  key: string;
  value: string;
  path: string;
  /** The remote a runtime remote setting belongs to, when the settings are kept per remote. */
  scope?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function entry(
  category: ActiveConfigCategory,
  key: string,
  value: unknown,
  path: string,
  scope?: string
): ActiveConfigItem {
  return {
    category,
    tone: CATEGORY_TONE[category],
    key,
    value: formatConfigValue(value),
    path,
    ...(scope === undefined ? {} : { scope }),
  };
}

const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

export const PRIMARY_EXCLUDED_KEYS = new Set([
  ...RCLONE_PATH_KEYS,
  'title',
  'subtitle',
  'targetMode',
  'remote',
  'remoteName',
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
  'options',
  'filter_options',
  'backend_options',
  'vfs_options',
  'remotes',
  'app',
  'config',
  'rclone',
]);

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
    // 1. Shared sections (vfs, filter, backend)
    for (const section of ['vfs', 'filter', 'backend'] as const) {
      const secObj = (rclone[section] ?? targetObj[`${section}_options`] ?? targetObj[section]) as
        Record<string, unknown> | undefined;
      if (!secObj || typeof secObj !== 'object') continue;
      for (const [k, v] of Object.entries(secObj)) {
        if (isSet(v)) items.push(entry(section, k, v, `config.rclone.${section}.${k}`));
      }
    }

    // 2a. Runtime settings of remotes. The editor keeps them per remote under `remotes`; an
    // older shape used `runtimeRemote`, scoped the same way or, older still, as one flat list.
    for (const key of ['remotes', 'runtimeRemote'] as const) {
      const secObj = rclone[key];
      if (!isPlainObject(secObj)) continue;
      const perRemote = Object.values(secObj);
      if (perRemote.length > 0 && perRemote.every(isPlainObject)) {
        for (const [remote, opts] of Object.entries(
          secObj as Record<string, Record<string, unknown>>
        )) {
          for (const [k, v] of Object.entries(opts)) {
            if (isSet(v)) {
              items.push(
                entry('runtimeRemote', k, v, `config.rclone.${key}.${remote}.${k}`, remote)
              );
            }
          }
        }
      } else if (key === 'runtimeRemote') {
        for (const [k, v] of Object.entries(secObj)) {
          if (isSet(v))
            items.push(entry('runtimeRemote', k, v, `config.rclone.runtimeRemote.${k}`));
        }
      }
    }

    // 2b. Options object (if present in targetObj.options)
    if (targetObj['options'] && typeof targetObj['options'] === 'object') {
      for (const [k, v] of Object.entries(targetObj['options'] as Record<string, unknown>)) {
        if (v !== undefined && v !== null && v !== '' && !PRIMARY_EXCLUDED_KEYS.has(k)) {
          if (typeof v !== 'object') {
            items.push(entry('operation', k, v, `config.rclone.${k}`));
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
          'remotes',
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
          items.push(entry('operation', k, v, `config.rclone.${k}`));
        }
      }
    }
  } else {
    // Fallback for non-operation nodes
    for (const [k, v] of Object.entries(cfg)) {
      if (!PRIMARY_EXCLUDED_KEYS.has(k) && v !== undefined && v !== null && v !== '') {
        if (typeof v !== 'object') {
          items.push(entry('general', k, v, k));
        }
      }
    }
  }

  return items;
}
