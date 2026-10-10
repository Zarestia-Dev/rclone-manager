import { RcConfigOption, OperationType, SharedProfileType, RCLONE_PATH_KEYS } from '@app/types';
import { staticFlagDefinitions } from '../flag-definitions';
import { PathGroup } from '../../infrastructure/platform/path.service';

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
  ...Object.values(OPERATION_PATH_MAPPINGS).flatMap(m =>
    m ? [m.sourceKey, m.destKey].filter((k): k is string => !!k) : []
  ),
  'app',
  'rclone',
  'mountType',
  'type',
  'autoStart',
  'showOnTray',
  'cronEnabled',
  'cronExpression',
  'watchEnabled',
  'watchDelay',
  'watchChangedOnly',
  'vfsProfile',
  'filterProfile',
  'backendProfile',
  'runtimeRemoteProfile',
  'name',
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
    showOnTray: formData['showOnTray'] !== undefined ? formData['showOnTray'] : true,
    cronEnabled: formData['cronEnabled'] ?? false,
    cronExpression: formData['cronExpression'] ?? null,
    watchEnabled: formData['watchEnabled'] ?? false,
    watchDelay: formData['watchDelay'] ?? 5,
    watchChangedOnly: formData['watchChangedOnly'] ?? false,
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
  const sourcePaths = ctx.pathService.buildPathStrings(
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
    showOnTray: appConfig['showOnTray'] !== undefined ? appConfig['showOnTray'] : true,
    cronEnabled: appConfig['cronEnabled'] ?? false,
    cronExpression: appConfig['cronExpression'] ?? null,
    watchEnabled: appConfig['watchEnabled'] ?? false,
    watchDelay: appConfig['watchDelay'] ?? 5,
    watchChangedOnly: appConfig['watchChangedOnly'] ?? false,
    vfsProfile: appConfig['vfsProfile'] || 'Default',
    filterProfile: appConfig['filterProfile'] || 'Default',
    backendProfile: appConfig['backendProfile'] || 'Default',
    runtimeRemoteProfile: appConfig['runtimeRemoteProfile'] || 'Default',
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
  if (type === 'mount' || type === 'serve') {
    parsedSrc.type = 'currentRemote';
    parsedSrc.remote = '';
  }
  return { source: parsedSrc };
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

export function retargetProfileRemote(
  profile: Record<string, unknown>,
  oldRemote: string,
  newRemote: string
): Record<string, unknown> {
  if (!profile || !oldRemote || !newRemote || oldRemote === newRemote) return profile;

  const updated = structuredClone(profile);
  const patchKeys = (target: Record<string, unknown>): void => {
    for (const key of RCLONE_PATH_KEYS) {
      if (key in target) target[key] = retargetPath(target[key], oldRemote, newRemote);
    }
  };

  if (
    updated['rclone'] &&
    typeof updated['rclone'] === 'object' &&
    !Array.isArray(updated['rclone'])
  ) {
    patchKeys(updated['rclone'] as Record<string, unknown>);
  }
  patchKeys(updated);

  if (oldRemote in updated) {
    updated[newRemote] = updated[oldRemote];
    delete updated[oldRemote];
  }

  return updated;
}

export function retargetProfilesRemote<T extends Record<string, unknown>>(
  sections: T,
  oldRemote: string,
  newRemote: string
): T {
  if (!sections || !oldRemote || !newRemote || oldRemote === newRemote) return sections;

  const updated = structuredClone(sections) as Record<string, unknown>;
  for (const [secKey, secVal] of Object.entries(updated)) {
    if (!secVal || typeof secVal !== 'object' || Array.isArray(secVal)) continue;

    const isRuntime = secKey === 'runtimeRemote' || secKey === 'runtimeRemoteConfigs';
    const newMap: Record<string, unknown> = {};

    for (const [pName, pData] of Object.entries(secVal as Record<string, unknown>)) {
      if (pData && typeof pData === 'object' && !Array.isArray(pData)) {
        const targetName = isRuntime && pName === oldRemote ? newRemote : pName;
        newMap[targetName] = retargetProfileRemote(
          pData as Record<string, unknown>,
          oldRemote,
          newRemote
        );
      } else {
        newMap[pName] = pData;
      }
    }
    updated[secKey] = newMap;
  }
  return updated as T;
}
