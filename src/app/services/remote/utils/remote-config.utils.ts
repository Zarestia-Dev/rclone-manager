import {
  RcConfigQuestionResponse,
  InteractiveFlowState,
  RcConfigOption,
  DEFAULT_PROFILE_NAME,
} from '@app/types';
import { staticFlagDefinitions } from '../flag-definitions';
import { PathGroup } from '../../infrastructure/platform/path.service';

/**
 * Creates the initial/reset state for interactive flow.
 */
export function createInitialInteractiveFlowState(): InteractiveFlowState {
  return {
    isActive: false,
    question: null,
    answer: null,
    isProcessing: false,
  };
}

/**
 * Converts a boolean answer to the string format expected by rclone API.
 */
export function convertBoolAnswerToString(answer: unknown): string {
  return answer === true || String(answer).toLowerCase() === 'true' ? 'true' : 'false';
}

/**
 * Returns a new state object with the given answer applied.
 */
export function updateInteractiveAnswer(
  state: InteractiveFlowState,
  newAnswer: string | number | boolean | null
): InteractiveFlowState {
  return { ...state, answer: newAnswer };
}

/**
 * Extracts the default answer from an interactive config question response.
 */
export function getDefaultAnswerFromQuestion(
  q: RcConfigQuestionResponse
): string | boolean | number {
  const opt = q.Option;
  if (!opt) return '';

  if (opt.Type === 'bool') {
    if (typeof opt.Value === 'boolean') return opt.Value;
    if (opt.ValueStr !== undefined) return opt.ValueStr.toLowerCase() === 'true';
    if (opt.DefaultStr !== undefined) return opt.DefaultStr.toLowerCase() === 'true';
    return typeof opt.Default === 'boolean' ? opt.Default : true;
  }

  return (
    opt.ValueStr || opt.DefaultStr || String(opt.Default ?? '') || opt.Examples?.[0]?.Value || ''
  );
}

/**
 * Strips leading CLI flag dashes (e.g., --, -) from a search query.
 */
export function stripCliPrefix(query: string): string {
  const q = query.toLowerCase().trim();
  if (q.startsWith('--')) {
    return q.slice(2);
  }
  if (q.startsWith('-')) {
    return q.slice(1);
  }
  return q;
}

/**
 * Normalizes an rclone config key for flexible searching
 * (lowercase, hyphens/spaces → underscores).
 */
export function normalizeRcloneKey(val: string | undefined | null): string {
  return val ? val.toLowerCase().replace(/[- ]/g, '_') : '';
}

/**
 * Returns true if a config field name or help text matches the given search query.
 */
export function matchesConfigSearch(field: RcConfigOption, query: string): boolean {
  if (!query) return true;

  const q = stripCliPrefix(query);
  const flexQ = normalizeRcloneKey(q);

  return (
    (field.Name?.toLowerCase() ?? '').includes(q) ||
    (field.FieldName?.toLowerCase() ?? '').includes(q) ||
    (field.Help?.toLowerCase() ?? '').includes(q) ||
    normalizeRcloneKey(field.Name).includes(flexQ) ||
    normalizeRcloneKey(field.FieldName).includes(flexQ)
  );
}

/**
 * Groups an array of items by a derived key.
 */
export function groupBy<T, K extends PropertyKey>(
  array: T[],
  keyGetter: (item: T) => K
): Record<K, T[]> {
  return array.reduce(
    (acc, item) => {
      const key = keyGetter(item);
      (acc[key] ??= []).push(item);
      return acc;
    },
    {} as Record<K, T[]>
  );
}

/**
 * Gets the standard control key for a given config option.
 */
export function getControlKey(field: RcConfigOption, type?: string): string {
  if (type === 'serve') {
    return field.Name || field.FieldName;
  }
  return field.FieldName || field.Name;
}

export interface PathMappingInfo {
  sourceKey: string;
  destKey?: string;
  isSourceArray?: boolean;
}

export const OPERATION_PATH_MAPPINGS: Record<string, PathMappingInfo> = {
  mount: { sourceKey: 'fs', destKey: 'mountPoint' },
  serve: { sourceKey: 'fs' },
  sync: { sourceKey: 'srcFs', destKey: 'dstFs', isSourceArray: true },
  copy: { sourceKey: 'srcFs', destKey: 'dstFs', isSourceArray: true },
  move: { sourceKey: 'srcFs', destKey: 'dstFs', isSourceArray: true },
  bisync: { sourceKey: 'path1', destKey: 'path2' },
};

/** Keys excluded from dynamic options when mapping config→form (structural/metadata fields). */
const CONFIG_METADATA_KEYS = new Set([
  'srcFs',
  'dstFs',
  'path1',
  'path2',
  'fs',
  'mountPoint',
  'mountType',
  'autoStart',
  'cronEnabled',
  'cronExpression',
  'watchEnabled',
  'watchDelay',
  'vfsProfile',
  'filterProfile',
  'backendProfile',
  'runtimeRemoteProfile',
  'name',
  'type',
  '_config',
  'mountOpt',
]);

export function getTopLevelKeysForProfile(type: string): string[] {
  const mapping = OPERATION_PATH_MAPPINGS[type];
  if (!mapping) return [];

  const keys: string[] = [mapping.sourceKey];
  if (mapping.destKey) keys.push(mapping.destKey);

  if (type === 'mount') {
    keys.push('mountType', 'mountOpt');
  } else if (type === 'serve') {
    keys.push('type');
  } else {
    keys.push('_config');
    const flatDefs = staticFlagDefinitions[type] || [];
    keys.push(...flatDefs.map(f => f.FieldName || f.Name));
  }

  return keys;
}

export interface FormToConfigContext {
  remoteName: string;
  pathService: {
    buildPathString(p: PathGroup | string, remoteName: string): string;
    buildPathStrings(p: PathGroup | PathGroup[] | null | undefined, remoteName: string): string[];
  };
  runtimeRemoteProfileNames?: string[];
  cleanData?: (options: Record<string, any>, fields: RcConfigOption[]) => Record<string, any>;
  dynamicFields?: RcConfigOption[];
  flatOptionNames?: Set<string>;
}

export function mapFormToConfigProfile(
  type: string,
  formData: Record<string, any>,
  ctx: FormToConfigContext
): Record<string, any> {
  const mapping = OPERATION_PATH_MAPPINGS[type];

  if (!mapping) {
    if (type === 'runtimeRemote' && ctx.cleanData && ctx.dynamicFields) {
      const cleaned = { ...ctx.cleanData(formData, ctx.dynamicFields) };
      delete cleaned['type'];
      return { [ctx.remoteName]: cleaned };
    }
    if (formData['options'] && ctx.cleanData && ctx.dynamicFields) {
      return ctx.cleanData(formData['options'], ctx.dynamicFields);
    }
    return {};
  }

  const app: Record<string, any> = {
    autoStart: formData['autoStart'] ?? false,
    cronEnabled: formData['cronEnabled'] ?? false,
    cronExpression: formData['cronExpression'] ?? null,
    watchEnabled: formData['watchEnabled'] ?? false,
    watchDelay: formData['watchDelay'] ?? 5,
    vfsProfile: formData['vfsProfile'] || DEFAULT_PROFILE_NAME,
    filterProfile: formData['filterProfile'] || DEFAULT_PROFILE_NAME,
    backendProfile: formData['backendProfile'] || DEFAULT_PROFILE_NAME,
  };

  if ('runtimeRemoteProfile' in formData) {
    const selectedProfile = String(formData['runtimeRemoteProfile'] || '').trim();
    app['runtimeRemoteProfile'] = ctx.runtimeRemoteProfileNames?.includes(selectedProfile)
      ? selectedProfile
      : DEFAULT_PROFILE_NAME;
  }

  const rclone: Record<string, any> = {};

  if (formData['source'] !== undefined) {
    const sourcePaths = ctx.pathService.buildPathStrings(
      Array.isArray(formData['source']) ? formData['source'] : [formData['source']],
      ctx.remoteName
    );
    rclone[mapping.sourceKey] = mapping.isSourceArray
      ? sourcePaths.length > 1
        ? sourcePaths
        : (sourcePaths[0] ?? '')
      : (sourcePaths[0] ?? '');
  }

  if (mapping.destKey && formData['dest'] !== undefined) {
    rclone[mapping.destKey] = ctx.pathService.buildPathString(formData['dest'], ctx.remoteName);
  }

  if (type === 'mount') {
    const val = formData['options']?.['mountType'];
    if (val && val !== 'mount') {
      rclone['mountType'] = val;
    }
  } else if (type === 'serve') {
    const val = formData['options']?.['type'];
    if (val && val !== 'http') {
      rclone['type'] = val;
    }
  }

  if (formData['options'] && ctx.cleanData && ctx.dynamicFields) {
    const cleanedOptions = { ...ctx.cleanData(formData['options'], ctx.dynamicFields) };
    delete cleanedOptions['type'];
    delete cleanedOptions['mountType'];

    if (type === 'mount') {
      if (Object.keys(cleanedOptions).length > 0) {
        rclone['mountOpt'] = cleanedOptions;
      }
    } else if (type === 'serve') {
      if (Object.keys(cleanedOptions).length > 0) {
        Object.assign(rclone, cleanedOptions);
      }
    } else if (ctx.flatOptionNames) {
      const flatOptions: Record<string, any> = {};
      const nestedOptions: Record<string, any> = {};
      for (const [k, v] of Object.entries(cleanedOptions)) {
        if (ctx.flatOptionNames.has(k)) {
          flatOptions[k] = v;
        } else {
          nestedOptions[k] = v;
        }
      }
      Object.assign(rclone, flatOptions);
      if (Object.keys(nestedOptions).length > 0) {
        rclone['_config'] = nestedOptions;
      }
    }
  }

  return { app, rclone };
}

export interface ConfigToFormContext {
  remoteName: string;
  existingRemotes: string[];
  pathService: {
    parseFsString(
      s: string,
      defaultType?: 'local' | 'currentRemote',
      remoteName?: string,
      existingRemotes?: string[]
    ): PathGroup;
  };
}

export function mapConfigToFormProfile(
  type: string,
  config: Record<string, any>,
  ctx: ConfigToFormContext
): Record<string, any> {
  const appConfig = config['app'] || config;
  const rcloneConfig = config['rclone'] || config;

  const result: Record<string, any> = {
    autoStart: appConfig['autoStart'] ?? false,
    cronEnabled: appConfig['cronEnabled'] ?? false,
    cronExpression: appConfig['cronExpression'] ?? null,
    watchEnabled: appConfig['watchEnabled'] ?? false,
    watchDelay: appConfig['watchDelay'] ?? 5,
    vfsProfile: appConfig['vfsProfile'] || 'default',
    filterProfile: appConfig['filterProfile'] || 'default',
    backendProfile: appConfig['backendProfile'] || 'default',
    runtimeRemoteProfile: appConfig['runtimeRemoteProfile'] || 'default',
  };

  const mapping = OPERATION_PATH_MAPPINGS[type];
  if (mapping) {
    const sourceVal = rcloneConfig[mapping.sourceKey];
    const configSources = (
      Array.isArray(sourceVal) ? sourceVal : sourceVal ? [sourceVal] : []
    ) as string[];

    if (mapping.isSourceArray) {
      result['source'] = configSources.map(s =>
        ctx.pathService.parseFsString(s, 'currentRemote', ctx.remoteName, ctx.existingRemotes)
      );
    } else {
      result['source'] = ctx.pathService.parseFsString(
        configSources[0] ?? '',
        'currentRemote',
        ctx.remoteName,
        ctx.existingRemotes
      );
    }

    if (mapping.destKey) {
      const destVal = rcloneConfig[mapping.destKey] ?? '';
      result['dest'] = ctx.pathService.parseFsString(
        destVal,
        'local',
        ctx.remoteName,
        ctx.existingRemotes
      );
    }
  }

  const incomingOptions: Record<string, any> = {};

  for (const [k, v] of Object.entries(rcloneConfig)) {
    if (!CONFIG_METADATA_KEYS.has(k)) {
      incomingOptions[k] = v;
    }
  }

  const nestedKey = type === 'mount' ? 'mountOpt' : '_config';
  const nested = rcloneConfig[nestedKey];
  if (nested && typeof nested === 'object') {
    Object.assign(incomingOptions, nested);
  }

  if (type === 'mount') {
    incomingOptions['mountType'] = rcloneConfig['mountType'] || null;
  } else if (type === 'serve') {
    incomingOptions['type'] = rcloneConfig['type'] || null;
  }

  result['options'] = incomingOptions;

  return result;
}
