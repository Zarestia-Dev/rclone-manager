import {
  RcConfigQuestionResponse,
  InteractiveFlowState,
  RcConfigOption,
  OperationType,
  SharedProfileType,
  ConfigValue,
} from '@app/types';
import { staticFlagDefinitions } from '../flag-definitions';
import { PathGroup } from '../../infrastructure/platform/path.service';

export function createInitialInteractiveFlowState(): InteractiveFlowState {
  return {
    isActive: false,
    question: null,
    answer: null,
    isProcessing: false,
  };
}

export function convertBoolAnswerToString(answer: unknown): string {
  return answer === true || String(answer).toLowerCase() === 'true' ? 'true' : 'false';
}

export function updateInteractiveAnswer(
  state: InteractiveFlowState,
  newAnswer: string | number | boolean | null
): InteractiveFlowState {
  return { ...state, answer: newAnswer };
}

export function getDefaultAnswerFromQuestion(
  q: RcConfigQuestionResponse
): string | boolean | number {
  const opt = q.Option;
  if (!opt) return '';

  if (opt.Type === 'bool') {
    if (typeof opt.Value === 'boolean') return opt.Value;
    if (opt.ValueStr !== undefined && opt.ValueStr !== '') {
      return opt.ValueStr.toLowerCase() === 'true';
    }
    if (opt.DefaultStr !== undefined && opt.DefaultStr !== '') {
      return opt.DefaultStr.toLowerCase() === 'true';
    }
    return typeof opt.Default === 'boolean' ? opt.Default : true;
  }

  let defVal = '';
  if (opt.ValueStr) {
    defVal = opt.ValueStr;
  } else if (opt.DefaultStr) {
    defVal = opt.DefaultStr;
  } else if (opt.Default !== undefined && opt.Default !== null) {
    defVal = String(opt.Default);
  } else if (opt.Examples?.length) {
    defVal = opt.Examples[0].Value;
  }

  if (opt.Examples?.length) {
    const hasExactMatch = opt.Examples.some(ex => ex.Value === defVal);
    if (!hasExactMatch) {
      const num = parseInt(defVal, 10);
      // rclone uses 1-based numeric indices for example selection
      if (!isNaN(num) && num >= 1 && num <= opt.Examples.length) {
        return opt.Examples[num - 1].Value;
      }
    }
  }

  return defVal;
}

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

export function normalizeRcloneKey(val: string | undefined | null): string {
  return val ? val.toLowerCase().replace(/[- ]/g, '_') : '';
}

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

export interface PathMappingInfo {
  sourceKey: string;
  destKey?: string;
  isSourceArray?: boolean;
}

export const OPERATION_PATH_MAPPINGS: Partial<Record<SharedProfileType, PathMappingInfo>> = {
  mount: { sourceKey: 'fs', destKey: 'mountPoint' },
  serve: { sourceKey: 'fs' },
  sync: { sourceKey: 'srcFs', destKey: 'dstFs', isSourceArray: true },
  copy: { sourceKey: 'srcFs', destKey: 'dstFs', isSourceArray: true },
  move: { sourceKey: 'srcFs', destKey: 'dstFs', isSourceArray: true },
  check: { sourceKey: 'srcFs', destKey: 'dstFs', isSourceArray: true },
  archivecreate: { sourceKey: 'srcFs', destKey: 'dstFs' },
  cryptcheck: { sourceKey: 'srcFs', destKey: 'dstFs', isSourceArray: true },
  bisync: { sourceKey: 'path1', destKey: 'path2' },
  delete: { sourceKey: 'srcFs', isSourceArray: true },
  copyurl: { sourceKey: 'srcFs', destKey: 'dstFs', isSourceArray: true },
};

const CONFIG_METADATA_KEYS: ReadonlySet<string> = new Set([
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
]);

const MOUNT_TYPE_KEY = 'mountType';
const SERVE_TYPE_KEY = 'type';
const DEFAULT_SERVE_TYPE = 'http';
const DEFAULT_MOUNT_TYPE = 'mount';

// Legacy compat keys — older config formats that should be flattened into options
const LEGACY_FLATTEN_KEYS = new Set(['_config', 'mountOpt', '_filter']);

export function getTopLevelKeysForProfile(type: string): string[] {
  const mapping = OPERATION_PATH_MAPPINGS[type as SharedProfileType];
  if (!mapping) return [];

  const keys: string[] = [mapping.sourceKey];
  if (mapping.destKey) keys.push(mapping.destKey);

  if (type === 'mount') {
    keys.push(MOUNT_TYPE_KEY);
  } else if (type === 'serve') {
    keys.push(SERVE_TYPE_KEY);
  }

  const flatDefs = staticFlagDefinitions[type as OperationType] || [];
  keys.push(...flatDefs.map(f => f.Name || f.FieldName));

  return keys;
}

export interface FormToConfigContext {
  remoteName: string;
  pathService: {
    buildPathString(p: PathGroup | string, remoteName: string): string;
    buildPathStrings(p: PathGroup | PathGroup[] | null | undefined, remoteName: string): string[];
    joinPath(...segments: string[]): string;
  };
  runtimeRemoteProfileNames?: string[];
  cleanData?: (
    options: Record<string, unknown>,
    fields: RcConfigOption[]
  ) => Record<string, unknown>;
  dynamicFields?: RcConfigOption[];
  flatOptionNames?: Set<string>;
}

function buildAppConfig(formData: Record<string, unknown>): Record<string, unknown> {
  const app: Record<string, unknown> = {
    autoStart: formData['autoStart'] ?? false,
    cronEnabled: formData['cronEnabled'] ?? false,
    cronExpression: formData['cronExpression'] ?? null,
    watchEnabled: formData['watchEnabled'] ?? false,
    watchDelay: formData['watchDelay'] ?? 5,
    vfsProfile: formData['vfsProfile'] || undefined,
    filterProfile: formData['filterProfile'] || undefined,
    backendProfile: formData['backendProfile'] || undefined,
  };

  if ('runtimeRemoteProfile' in formData) {
    const selectedProfile = String(formData['runtimeRemoteProfile'] || '').trim();
    app['runtimeRemoteProfile'] =
      selectedProfile && selectedProfile !== 'Default' ? selectedProfile : undefined;
  }

  return app;
}

function mapSourcePaths(
  type: string,
  formData: Record<string, unknown>,
  mapping: PathMappingInfo,
  ctx: FormToConfigContext
): Record<string, unknown> {
  if (formData['source'] === undefined) return {};

  if (type === 'copyurl') {
    return mapCopyUrlPaths(formData, mapping);
  }

  const sources = Array.isArray(formData['source']) ? formData['source'] : [formData['source']];
  const sourcePaths = ctx.pathService.buildPathStrings(
    sources as PathGroup | PathGroup[],
    ctx.remoteName
  );
  return {
    [mapping.sourceKey]: mapping.isSourceArray
      ? sourcePaths.length > 1
        ? sourcePaths
        : (sourcePaths[0] ?? '')
      : (sourcePaths[0] ?? ''),
  };
}

function mapCopyUrlPaths(
  formData: Record<string, unknown>,
  mapping: PathMappingInfo
): Record<string, unknown> {
  const sources = Array.isArray(formData['source']) ? formData['source'] : [formData['source']];
  const urls = (sources as ({ path?: string } | string)[])
    .map(s => (typeof s === 'string' ? s : s?.path || ''))
    .filter(Boolean);
  const filenames = (sources as { filename?: string }[]).map(s => s?.filename || '');

  const rclone: Record<string, unknown> = {
    [mapping.sourceKey]: mapping.isSourceArray
      ? urls.length > 1
        ? urls
        : (urls[0] ?? '')
      : (urls[0] ?? ''),
  };

  if (filenames.some(Boolean)) {
    rclone['filenames'] = filenames;
    if (formData['options']) {
      (formData['options'] as Record<string, unknown>)['autoFilename'] = false;
    }
  } else if (formData['options']) {
    (formData['options'] as Record<string, unknown>)['autoFilename'] = true;
  }

  return rclone;
}

function mapMountServeType(
  type: string,
  formData: Record<string, unknown>
): Record<string, unknown> {
  if (type === 'mount') {
    const val = (formData['options'] as Record<string, unknown> | undefined)?.[MOUNT_TYPE_KEY];
    return val && val !== DEFAULT_MOUNT_TYPE ? { mountType: val } : {};
  }
  if (type === 'serve') {
    const val = (formData['options'] as Record<string, unknown> | undefined)?.[SERVE_TYPE_KEY];
    return val && val !== DEFAULT_SERVE_TYPE ? { type: val } : {};
  }
  return {};
}

function cleanOptions(
  formData: Record<string, unknown>,
  ctx: FormToConfigContext
): Record<string, unknown> {
  if (!formData['options'] || !ctx.cleanData || !ctx.dynamicFields) return {};
  const cleanedOptions = {
    ...ctx.cleanData(formData['options'] as Record<string, unknown>, ctx.dynamicFields),
  };
  delete cleanedOptions[SERVE_TYPE_KEY];
  delete cleanedOptions[MOUNT_TYPE_KEY];
  return Object.keys(cleanedOptions).length > 0 ? cleanedOptions : {};
}

export function mapFormToConfigProfile(
  type: string,
  formData: Record<string, unknown>,
  ctx: FormToConfigContext
): Record<string, unknown> {
  const mapping = OPERATION_PATH_MAPPINGS[type as SharedProfileType];

  if (!mapping) {
    if (type === 'runtimeRemote' && ctx.cleanData && ctx.dynamicFields) {
      const cleaned = { ...ctx.cleanData(formData, ctx.dynamicFields) };
      delete cleaned[SERVE_TYPE_KEY];
      return { [ctx.remoteName]: cleaned };
    }
    if (formData['options'] && ctx.cleanData && ctx.dynamicFields) {
      return ctx.cleanData(formData['options'] as Record<string, unknown>, ctx.dynamicFields);
    }
    return {};
  }

  const app = buildAppConfig(formData);
  const rclone: Record<string, unknown> = {
    ...mapSourcePaths(type, formData, mapping, ctx),
  };

  if (mapping.destKey && formData['dest'] !== undefined) {
    rclone[mapping.destKey] = ctx.pathService.buildPathString(
      formData['dest'] as PathGroup | string,
      ctx.remoteName
    );
  }

  Object.assign(rclone, mapMountServeType(type, formData));
  Object.assign(rclone, cleanOptions(formData, ctx));

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
    getFilename(path: string): string;
    getParentPath(path: string): string;
  };
}

function buildAppConfigResult(appConfig: Record<string, unknown>): Record<string, unknown> {
  return {
    autoStart: appConfig['autoStart'] ?? false,
    cronEnabled: appConfig['cronEnabled'] ?? false,
    cronExpression: appConfig['cronExpression'] ?? null,
    watchEnabled: appConfig['watchEnabled'] ?? false,
    watchDelay: appConfig['watchDelay'] ?? 5,
    vfsProfile: appConfig['vfsProfile'] || 'Default',
    filterProfile: appConfig['filterProfile'] || 'Default',
    backendProfile: appConfig['backendProfile'] || 'Default',
    runtimeRemoteProfile: appConfig['runtimeRemoteProfile'] || 'Default',
  };
}

function mapSourceToForm(
  type: string,
  rcloneConfig: Record<string, unknown>,
  mapping: PathMappingInfo,
  ctx: ConfigToFormContext
): Record<string, unknown> {
  const sourceVal = rcloneConfig[mapping.sourceKey];
  const configSources = (
    Array.isArray(sourceVal) ? sourceVal : sourceVal ? [sourceVal] : []
  ) as string[];

  if (type === 'copyurl') {
    return mapCopyUrlToForm(rcloneConfig, configSources, mapping, ctx);
  }

  if (mapping.isSourceArray) {
    return {
      source: configSources.map(s =>
        ctx.pathService.parseFsString(s, 'currentRemote', ctx.remoteName, ctx.existingRemotes)
      ),
    };
  }

  const parsedSrc = ctx.pathService.parseFsString(
    configSources[0] ?? '',
    'currentRemote',
    ctx.remoteName,
    ctx.existingRemotes
  );
  if (type === 'mount' || type === 'serve') {
    parsedSrc.type = 'currentRemote';
    parsedSrc.remote = '';
  }
  return { source: parsedSrc };
}

function mapCopyUrlToForm(
  rcloneConfig: Record<string, unknown>,
  configSources: string[],
  mapping: PathMappingInfo,
  ctx: ConfigToFormContext
): Record<string, unknown> {
  const filenames = rcloneConfig['filenames'] as string[] | undefined;
  const autoFilename = rcloneConfig['autoFilename'] ?? false;
  const destVal = (mapping.destKey ? rcloneConfig[mapping.destKey] : '') ?? '';
  const parsedDst = ctx.pathService.parseFsString(
    destVal as string,
    'local',
    ctx.remoteName,
    ctx.existingRemotes
  );

  let legacyFilename = '';
  if (!filenames && !autoFilename && parsedDst.path) {
    legacyFilename = ctx.pathService.getFilename(parsedDst.path);
    parsedDst.path = ctx.pathService.getParentPath(parsedDst.path);
  }

  return {
    source: configSources.map((s, idx) => ({
      type: 'local',
      path: s,
      remote: '',
      filename: filenames?.[idx] || (idx === 0 ? legacyFilename : ''),
    })),
    dest: parsedDst,
  };
}

function mapDestToForm(
  type: string,
  rcloneConfig: Record<string, unknown>,
  mapping: PathMappingInfo,
  ctx: ConfigToFormContext
): Record<string, unknown> {
  if (!mapping.destKey) return {};
  const destVal = rcloneConfig[mapping.destKey] ?? '';
  const parsedDst = ctx.pathService.parseFsString(
    destVal as string,
    'local',
    ctx.remoteName,
    ctx.existingRemotes
  );
  if (type === 'mount') {
    parsedDst.type = 'local';
    parsedDst.remote = '';
  }
  return { dest: parsedDst };
}

function collectIncomingOptions(rcloneConfig: Record<string, unknown>): Record<string, unknown> {
  const incomingOptions: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(rcloneConfig)) {
    if (CONFIG_METADATA_KEYS.has(k)) continue;

    if (LEGACY_FLATTEN_KEYS.has(k)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
          incomingOptions[nk] = nv;
        }
      }
    } else {
      incomingOptions[k] = v;
    }
  }

  return incomingOptions;
}

export function mapConfigToFormProfile(
  type: string,
  config: Record<string, unknown>,
  ctx: ConfigToFormContext
): Record<string, unknown> {
  const appConfig = (config['app'] as Record<string, unknown>) || config;
  const rcloneConfig = (config['rclone'] as Record<string, unknown>) || config;

  const result: Record<string, unknown> = buildAppConfigResult(appConfig);

  const mapping = OPERATION_PATH_MAPPINGS[type as SharedProfileType];
  if (mapping) {
    Object.assign(result, mapSourceToForm(type, rcloneConfig, mapping, ctx));
    Object.assign(result, mapDestToForm(type, rcloneConfig, mapping, ctx));
  }

  const incomingOptions = collectIncomingOptions(rcloneConfig);

  if (type === 'mount') {
    incomingOptions[MOUNT_TYPE_KEY] = rcloneConfig[MOUNT_TYPE_KEY] || null;
  } else if (type === 'serve') {
    incomingOptions[SERVE_TYPE_KEY] = rcloneConfig[SERVE_TYPE_KEY] || null;
  }

  result['options'] = incomingOptions;

  return result;
}

// Re-exported for downstream consumers that need ConfigValue typing
export type { ConfigValue };
