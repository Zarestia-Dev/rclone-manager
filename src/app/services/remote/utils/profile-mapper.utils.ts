import * as pathUtils from 'src/app/shared/utils/path.utils';
import {
  RcConfigOption,
  OperationType,
  SharedProfileType,
  RCLONE_PATH_KEYS,
  APP_CONFIG_DEFAULTS,
  DEFAULT_PROFILE_NAME,
  type PathGroup,
} from '@app/types';
import { staticFlagDefinitions } from '../flag-definitions';
import {
  getAppConfigValues,
  getAppCfg,
  getRcloneCfg,
  extractProfileSource,
  extractProfileDest,
} from '../../../shared/utils/profile-config.util';

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
  ...RCLONE_PATH_KEYS,
  ...Object.keys(APP_CONFIG_DEFAULTS),
  'app',
  'rclone',
  'showOnTray', // Legacy profile metadata must not become an rclone option.
  'mountType',
  'type',
  'name',
  'url',
  'filenames',
  'autoFilename',
  'vfs',
  'filter',
  'backend',
  'remotes',
  'runtimeRemote',
  ...Object.keys(OPERATION_PATH_MAPPINGS),
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
  cleanData?: (
    options: Record<string, unknown>,
    fields: RcConfigOption[]
  ) => Record<string, unknown>;
  dynamicFields?: RcConfigOption[];
}

function buildAppConfig(formData: Record<string, unknown>): Record<string, unknown> {
  const values = getAppConfigValues(formData);
  values['runtimeRemoteProfile'] =
    String(formData['runtimeRemoteProfile'] || '').trim() || DEFAULT_PROFILE_NAME;
  return Object.fromEntries(
    Object.entries(APP_CONFIG_DEFAULTS)
      .filter(([key, defaultValue]) => values[key] !== defaultValue)
      .map(([key]) => [key, values[key]])
  );
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
  const hasFilenames = filenames.some(Boolean);

  const rclone: Record<string, unknown> = {
    [mapping.sourceKey]: mapping.isSourceArray
      ? urls.length > 1
        ? urls
        : (urls[0] ?? '')
      : (urls[0] ?? ''),
    autoFilename: !hasFilenames,
  };
  if (hasFilenames) rclone['filenames'] = filenames;

  return rclone;
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
  const sourcePaths = pathUtils.buildPathStrings(
    sources as PathGroup | PathGroup[],
    ctx.remoteName
  );
  const sourceValue =
    mapping.isSourceArray && sourcePaths.length > 1 ? sourcePaths : (sourcePaths[0] ?? '');
  return { [mapping.sourceKey]: sourceValue };
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
  delete cleanedOptions['autoFilename'];
  delete cleanedOptions['app'];
  delete cleanedOptions['rclone'];
  return cleanedOptions;
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
    rclone[mapping.destKey] = pathUtils.buildPathString(
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
    getParentPath(path: string): string;
  };
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
    legacyFilename = pathUtils.getFilename(parsedDst.path);
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

function mapSourceToForm(
  type: string,
  rcloneConfig: Record<string, unknown>,
  mapping: PathMappingInfo,
  ctx: ConfigToFormContext
): Record<string, unknown> {
  const sourceVal = rcloneConfig[mapping.sourceKey] ?? extractProfileSource(rcloneConfig);
  const configSources = (
    Array.isArray(sourceVal) ? sourceVal : sourceVal ? [sourceVal] : []
  ) as string[];

  if (type === 'copyurl') {
    return mapCopyUrlToForm(rcloneConfig, configSources, mapping, ctx);
  }

  if (mapping.isSourceArray) {
    return {
      source: configSources.map(s =>
        ctx.pathService.parseFsString(s, 'local', ctx.remoteName, ctx.existingRemotes)
      ),
    };
  }

  const parsedSrc = ctx.pathService.parseFsString(
    configSources[0] ?? '',
    'currentRemote',
    ctx.remoteName,
    ctx.existingRemotes
  );
  return { source: parsedSrc };
}

function mapDestToForm(
  type: string,
  rcloneConfig: Record<string, unknown>,
  mapping: PathMappingInfo,
  ctx: ConfigToFormContext
): Record<string, unknown> {
  if (!mapping.destKey) return {};
  const destVal = rcloneConfig[mapping.destKey] ?? extractProfileDest(rcloneConfig) ?? '';
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
  const appConfig = getAppCfg(config) ?? config;
  const rawRclone = getRcloneCfg(config) ?? config;
  const nested = rawRclone[type];
  const rcloneConfig = {
    ...(nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : {}),
    ...rawRclone,
  };

  const result = getAppConfigValues(appConfig);

  const mapping = OPERATION_PATH_MAPPINGS[type as SharedProfileType];
  if (mapping) {
    Object.assign(result, mapSourceToForm(type, rcloneConfig, mapping, ctx));
    Object.assign(result, mapDestToForm(type, rcloneConfig, mapping, ctx));
  }

  const incomingOptions = collectIncomingOptions(rcloneConfig);

  if (type === 'mount') {
    const rawMountType = rcloneConfig[MOUNT_TYPE_KEY];
    const mountPoint = String(rcloneConfig['mountPoint'] ?? rcloneConfig['mount_point'] ?? '');
    incomingOptions[MOUNT_TYPE_KEY] =
      rawMountType || (mountPoint.startsWith('saf://') ? 'saf' : 'mount');
  } else if (type === 'serve') {
    incomingOptions[SERVE_TYPE_KEY] = rcloneConfig[SERVE_TYPE_KEY] || 'http';
  }

  result['options'] = incomingOptions;

  return result;
}

function retargetPath(val: unknown, oldRemote: string, newRemote: string): unknown {
  const replace = (s: string): string =>
    s === oldRemote || s === `${oldRemote}:`
      ? `${newRemote}:`
      : s.startsWith(`${oldRemote}:`)
        ? `${newRemote}:${s.slice(oldRemote.length + 1)}`
        : s;

  if (typeof val === 'string') return replace(val);
  if (Array.isArray(val)) return val.map(item => (typeof item === 'string' ? replace(item) : item));
  return val;
}

function retargetRemoteKey(
  scoped: Record<string, unknown>,
  oldRemote: string,
  newRemote: string
): void {
  if (Object.hasOwn(scoped, oldRemote)) {
    scoped[newRemote] = scoped[oldRemote];
    delete scoped[oldRemote];
  }
}

function retargetProfilePaths(
  target: Record<string, unknown>,
  oldRemote: string,
  newRemote: string
): void {
  for (const key of RCLONE_PATH_KEYS) {
    if (key in target) target[key] = retargetPath(target[key], oldRemote, newRemote);
  }
  for (const key of ['remotes', 'runtimeRemote']) {
    const scoped = target[key];
    if (scoped && typeof scoped === 'object' && !Array.isArray(scoped)) {
      retargetRemoteKey(scoped as Record<string, unknown>, oldRemote, newRemote);
    }
  }
}

export function retargetProfilesRemote<T extends Record<string, unknown>>(
  sections: T,
  oldRemote: string,
  newRemote: string
): T {
  if (!sections || !oldRemote || !newRemote || oldRemote === newRemote) return sections;

  const updated = structuredClone(sections) as Record<string, unknown>;
  for (const [sectionName, section] of Object.entries(updated)) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    for (const profile of Object.values(section)) {
      if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
        const config = profile as Record<string, unknown>;
        if (sectionName === 'runtimeRemote' || sectionName === 'runtimeRemoteConfigs') {
          retargetRemoteKey(config, oldRemote, newRemote);
        } else {
          retargetProfilePaths(config, oldRemote, newRemote);
          const rclone = getRcloneCfg(config);
          if (rclone) retargetProfilePaths(rclone, oldRemote, newRemote);
        }
      }
    }
  }
  return updated as T;
}
