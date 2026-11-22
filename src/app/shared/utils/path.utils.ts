import {
  ExplorerRoot,
  MountPathCollision,
  PathGroup,
  PathSegment,
  PathStyle,
  REMOTE_CONFIG_KEYS,
  DefaultPathOp,
  QuickRun,
} from '@app/types';

/**
 * Splits a path into non-empty segments by forward or back slash.
 */
export function splitSegments(path: string): string[] {
  if (!path) return [];
  return path.split(/[\\/]/).filter(Boolean);
}

/**
 * Canonical POSIX normalization: resolves '.' and '..' segments, collapses multiple slashes.
 */
export function normalizePath(p: string): string {
  if (!p) return '';
  const normalized = p.replace(/\\/g, '/');
  const isAbsolute = normalized.startsWith('/');
  const stack: string[] = [];

  for (const part of splitSegments(normalized)) {
    if (part === '.') continue;
    if (part === '..') {
      stack.pop();
    } else {
      stack.push(part);
    }
  }

  return (isAbsolute ? '/' : '') + stack.join('/');
}

/**
 * Normalizes a path for the engine/host platform ('windows' uses backslashes, 'posix' uses forward slashes).
 */
export function normalizeForPlatform(path: string, pathStyle: PathStyle = 'posix'): string {
  if (!path) return '';
  if (pathStyle === 'windows') {
    return path.replace(/\//g, '\\').replace(/([^:\\])\\+/g, '$1\\');
  }
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * Splits what is being typed into the folder to list and the name typed so far in it:
 * `home/me/Do` is `home/me/` and `Do`. A path that ends in a separator, or a drive (`C:`), is a
 * folder to list whole; text without a separator is a name in the root.
 */
export function splitTypedPath(
  value: string,
  pathStyle: PathStyle = 'posix'
): { parent: string; leaf: string } {
  const windows = pathStyle === 'windows';
  const path = windows ? value.replaceAll('/', '\\') : value;
  if (windows && /^[a-z]:$/i.test(path)) return { parent: `${path}\\`, leaf: '' };
  const cut = path.lastIndexOf(windows ? '\\' : '/') + 1;
  return { parent: path.slice(0, cut), leaf: path.slice(cut) };
}

/**
 * Joins path segments into a canonical normalized POSIX path.
 */
export function joinPath(...segments: string[]): string {
  return normalizePath(segments.filter(Boolean).join('/'));
}

/**
 * Returns the trailing filename or directory name from a path.
 */
export function getFilename(path: string): string {
  return splitSegments(path).pop() ?? '';
}

/**
 * Returns the parent directory path in POSIX format.
 */
export function getDirname(path: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return '';
  if (lastSlash === 0) return '/';
  return normalized.substring(0, lastSlash);
}

/** UNC network names accepted by Rclone's Windows mount implementation. */
export function isWindowsMountNetworkPath(path: string): boolean {
  return /^\\\\[^\\?]+\\[^\\]/.test(path);
}

/** A drive root: `X:`, `X:\` or `X:/`. */
export function isWindowsDriveRoot(path: string): boolean {
  return /^[a-z]:[\\/]?$/i.test(path);
}

/** A path on a drive: a drive letter followed by a separator, such as `X:\` or `X:/folder`. */
export function isWindowsDrivePath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path);
}

/** A path inside a drive (`X:\folder`), not the drive root itself. */
export function isWindowsDriveFolder(path: string): boolean {
  return /^[a-z]:[\\/]./i.test(path);
}

/**
 * Explorer's "Copy as path" puts quotes around a drive path; returns the path without them,
 * or `path` unchanged when it is not a quoted drive path.
 */
export function unquoteWindowsPath(path: string): string {
  return /^"[a-z]:[\\/][^"]*"$/i.test(path) ? path.slice(1, -1) : path;
}

/** The drive letter (`X:`) of a drive-only mount target such as `x:` or `X:\`. */
export function mountDriveLetter(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  const target = path.trim();
  return isWindowsDriveRoot(target) ? target.slice(0, 2).toUpperCase() : undefined;
}

/**
 * How File Explorer names a mounted drive: `Name (Z:)`. A network drive shows its share and its
 * server, `share (\\server) (Z:)`; a name that is no UNC path is the share, after rclone's default
 * `\\server\` prefix, and no name at all is `\\server\share`. `fallbackName` stands in for an empty
 * disk name, `letter` is left out while it is not known.
 */
export function windowsDriveLabel(
  letter: string | undefined,
  name: string,
  network: boolean,
  fallbackName: string
): string {
  const suffix = letter ? ` (${letter})` : '';
  const trimmed = name.trim();
  if (!network) return `${trimmed || fallbackName}${suffix}`;
  const [, server = 'server', share = trimmed || 'share'] = isWindowsMountNetworkPath(trimmed)
    ? (/^\\\\([^\\]+)\\(.+)$/.exec(trimmed) ?? [])
    : [];
  return `${share} (\\\\${server})${suffix}`;
}

function windowsFolderName(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || /[<>:"/\\|?*]/.test(name) || name.endsWith('.')) return undefined;
  if (Array.from(name).some(character => character.charCodeAt(0) < 32)) return undefined;
  const base = name.split('.', 1)[0].trimEnd();
  if (/^(con|prn|aux|nul|(?:com|lpt)[1-9¹²³])$/i.test(base)) return undefined;
  return name;
}

/** The folder to mount into under `parent`, reusing the previous folder name or the disk and remote names. */
export function windowsMountFolderTarget(
  parent: string,
  previous: string,
  remoteName: string,
  diskName?: unknown
): string | undefined {
  const fallback = 'rclone-mount';
  if (!isWindowsDrivePath(parent)) return undefined;
  const directory = parent.replaceAll('/', '\\').replace(/\\+$/, '');
  const oldTarget = previous.replaceAll('/', '\\').replace(/\\+$/, '');
  const previousName =
    isWindowsDriveFolder(oldTarget) && oldTarget.toLowerCase() !== directory.toLowerCase()
      ? getFilename(oldTarget)
      : '';
  const existingName = previousName.toLowerCase() === fallback ? '' : previousName;
  const name =
    windowsFolderName(existingName) ??
    windowsFolderName(diskName) ??
    windowsFolderName(remoteName) ??
    fallback;
  return `${directory}\\${name}`;
}

/**
 * Returns the parent path respecting platform style.
 */
export function getParentPath(path: string, pathStyle: PathStyle = 'posix'): string {
  if (!path || path === '/' || (pathStyle === 'windows' && path === '\\')) return '';
  if (pathStyle === 'windows' && isWindowsDriveRoot(path)) return '';

  const segments = (pathStyle === 'windows' ? path.replace(/\\/g, '/') : path)
    .split('/')
    .filter(Boolean);
  const rooted = path.startsWith('/') || (pathStyle === 'windows' && path.startsWith('\\'));
  if (pathStyle === 'windows' && /^[\\/]{2}/.test(path)) {
    const rootSegments = segments[0] === '?' && segments[1]?.toUpperCase() === 'UNC' ? 4 : 2;
    if (segments.length <= rootSegments) return '';
    const parent = `//${segments.slice(0, -1).join('/')}`;
    return /^\/\/\?\/[a-zA-Z]:$/.test(parent) ? `${parent}/` : parent;
  }
  if (segments.length <= 1) return rooted ? '/' : '';

  segments.pop();
  if (pathStyle === 'windows' && segments.length === 1 && /^[a-zA-Z]:$/.test(segments[0])) {
    return `${segments[0]}/`;
  }
  return (rooted ? '/' : '') + segments.join('/');
}

/**
 * Splits a path into progressive breadcrumb segments.
 */
export function getPathSegments(path: string): PathSegment[] {
  if (!path) return [];
  const parts = splitSegments(path);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

/**
 * Normalizes a remote name by trimming, stripping trailing colons and `{guid}` suffixes.
 */
export function normalizeRemoteName(remoteName?: string, pathStyle: PathStyle = 'posix'): string {
  if (!remoteName) return '';
  if (pathStyle === 'windows' && /^[a-zA-Z]:$/.test(remoteName)) {
    return remoteName;
  }
  return remoteName
    .trim()
    .replace(/:$/, '')
    .replace(/\{[A-Za-z0-9_-]+\}$/, '');
}

/**
 * Appends a trailing colon to remote names, preserving rooted paths and Windows drive paths.
 */
export function normalizeRemoteForRclone(
  remoteName?: string,
  pathStyle: PathStyle = 'posix'
): string {
  if (!remoteName) return '';
  const isLocal =
    pathStyle === 'windows' ? /^(?:[A-Za-z]:|[\\/])/.test(remoteName) : remoteName.startsWith('/');

  if (isLocal) return remoteName;
  return remoteName.endsWith(':') ? remoteName : `${remoteName}:`;
}

/**
 * Normalizes an ExplorerRoot identifier for rclone.
 */
export function normalizeExplorerRoot(
  remote?: ExplorerRoot | null,
  pathStyle: PathStyle = 'posix'
): string {
  if (!remote) return '';
  return remote.isLocal ? remote.name : normalizeRemoteForRclone(remote.name, pathStyle);
}

/**
 * Splits a local path into remote (drive root or '/') and remainder.
 */
export function splitLocalPath(
  path: string,
  pathStyle: PathStyle = 'posix'
): { remote: string; remainder: string } {
  if (pathStyle === 'windows') {
    const match = path.match(/^([a-zA-Z]:)([\\/]?)(.*)$/);
    if (match) {
      const separator = match[2] || (match[3] ? '' : '\\');
      return { remote: match[1] + separator, remainder: match[3] };
    }
  } else if (path.startsWith('/')) {
    return { remote: '/', remainder: path.substring(1) };
  }
  return { remote: path, remainder: '' };
}

/**
 * Splits a local path for stat operations into root and relative path.
 */
export function splitLocalForStat(
  path: string,
  pathStyle: PathStyle = 'posix'
): { root: string; relative: string } {
  if (pathStyle === 'windows') {
    const normalized = path.replace(/\\/g, '/');
    const drive = normalized.match(/^((?:\/\/\?\/)?[A-Za-z]:)(\/?)(.*)$/);
    if (drive) return { root: drive[1] + drive[2], relative: drive[3] };
    const unc = normalized.match(/^(\/\/(?:\?\/UNC\/)?[^/]+\/[^/]+)(?:\/(.*))?$/i);
    if (unc) return { root: unc[1], relative: unc[2] ?? '' };
    if (normalized.startsWith('//')) return { root: normalized, relative: '' };
    return {
      root: normalized.startsWith('/') ? '/' : '.',
      relative: normalized.replace(/^\/+/, ''),
    };
  }
  const relative = path.startsWith('/') ? path.substring(1) : path;
  return { root: path.startsWith('/') ? '/' : '.', relative };
}

/**
 * Normalizes an rclone Fs object or string into a string format.
 */
export function normalizeFs(fs: unknown): string {
  if (typeof fs === 'string') return fs;
  if (!fs || typeof fs !== 'object') return '';

  const fsObj = fs as Record<string, unknown>;
  const root = typeof fsObj['_root'] === 'string' ? fsObj['_root'] : '';

  if (typeof fsObj['_name'] === 'string') return `${fsObj['_name']}:${root}`;
  if (typeof fsObj['type'] === 'string') return `:${fsObj['type']}:${root}`;
  return '';
}

/**
 * Builds a composite path string from a PathGroup object.
 */
export function buildPathString(pathGroup: PathGroup | string, currentRemoteName: string): string {
  if (!pathGroup) return '';
  if (typeof pathGroup === 'string') return pathGroup;

  const { type, path, remote } = pathGroup;
  const p = path ?? '';

  if (type.startsWith('otherRemote:')) {
    const remoteName = remote || type.split(':')[1];
    return `${remoteName}:${p}`;
  }

  switch (type) {
    case 'local':
      return p;
    case 'currentRemote':
      return `${currentRemoteName}:${p}`;
    default:
      return '';
  }
}

/**
 * Builds an array of path strings from one or more PathGroups.
 */
export function buildPathStrings(
  pathGroups: PathGroup | PathGroup[] | null | undefined,
  currentRemoteName: string
): string[] {
  if (!pathGroups) return [];
  if (Array.isArray(pathGroups)) {
    return pathGroups.map(pg => buildPathString(pg, currentRemoteName)).filter(Boolean);
  }
  const single = buildPathString(pathGroups, currentRemoteName);
  return single ? [single] : [];
}

/**
 * Categorizes a string type indicator into a standard PathGroup type.
 */
export function parsePathType(value: string): 'local' | 'currentRemote' | 'otherRemote' {
  if (value === 'local') return 'local';
  if (value === 'currentRemote') return 'currentRemote';
  if (value === 'otherRemote' || value?.startsWith('otherRemote:')) return 'otherRemote';
  return 'local';
}

/**
 * Resolves the remote name from an option value.
 */
export function getRemoteNameFromValue(value: string, currentRemoteName: string): string | null {
  if (value?.startsWith('otherRemote:')) return value.substring('otherRemote:'.length) || null;
  return value === 'currentRemote' ? currentRemoteName : null;
}

/**
 * Returns a user-friendly full display path.
 */
export function getFullDisplayPath(
  remote: Pick<ExplorerRoot, 'name' | 'isLocal'> | null,
  path: string,
  pathStyle: PathStyle = 'posix'
): string {
  if (!remote) return path;
  if (remote.isLocal) {
    const slash = pathStyle === 'windows' ? '\\' : '/';
    let cleanPath = path;
    if (pathStyle === 'windows' && path) {
      cleanPath = path.replace(/^[\\/]+/, '').replace(/\//g, '\\');
    }
    const hasSep =
      remote.name.endsWith('/') || (pathStyle === 'windows' && remote.name.endsWith('\\'));
    const sep = hasSep ? '' : slash;
    return cleanPath ? `${remote.name}${sep}${cleanPath}` : remote.name;
  }
  const prefix = remote.name.includes(':') ? remote.name : `${remote.name}:`;
  const cleanPath = path.startsWith('/') ? path.substring(1) : path;
  return path ? `${prefix}${cleanPath}` : prefix;
}

/**
 * Returns the short display segment (e.g. for header badges).
 */
export function getDisplaySegment(
  remote: ExplorerRoot | null,
  path: string,
  fallback = ''
): string {
  if (path) return splitSegments(path).pop() ?? path;
  if (remote) return remote.label || remote.name;
  return fallback;
}

/**
 * Extracts a display name from a path or falls back to remote name.
 */
export function extractName(path: string, remoteName?: string): string {
  if (path) return splitSegments(path).pop() ?? path;
  return remoteName ?? '';
}

export function isMultiPath(path: string | string[]): boolean {
  return Array.isArray(path) && path.length > 1;
}

export function asPathArray(path: string | string[]): string[] {
  return Array.isArray(path) ? path : [path];
}

export function getPrimaryPath(path: string | string[]): string {
  return Array.isArray(path) ? (path[0] ?? '') : path;
}

export function formatPathDisplay(path: string | string[]): string {
  if (!Array.isArray(path)) return path;
  if (path.length === 0) return '';
  return path.join(', ');
}

export function formatPathTooltip(path: string | string[]): string {
  return Array.isArray(path) ? path.join('\n') : path;
}

/**
 * Checks whether a given path is local, based on known registered remote names.
 */
export function isLocalPath(
  path: string | string[],
  remoteNames: Set<string>,
  pathStyle: PathStyle = 'posix'
): boolean {
  const p = Array.isArray(path) ? path[0] : path;
  if (!p) return false;

  const colonIdx = p.indexOf(':');
  const remotePart = colonIdx > -1 ? p.substring(0, colonIdx) : p;
  const normalized = normalizeRemoteName(remotePart, pathStyle);

  return !remoteNames.has(normalized);
}

/**
 * Checks whether a path is truly local on the host OS.
 */
export function isTrulyLocalPath(
  path: string,
  remoteNames: Set<string>,
  pathStyle: PathStyle = 'posix'
): boolean {
  if (!path) return false;
  if (path.startsWith('/') || (pathStyle === 'windows' && path.startsWith('\\'))) {
    return isLocalPath(path, remoteNames, pathStyle);
  }
  const colonIdx = path.indexOf(':');
  if (colonIdx > -1) {
    if (pathStyle === 'windows' && /^[a-zA-Z]:/.test(path)) {
      return isLocalPath(path, remoteNames, pathStyle);
    }
    return false;
  }
  return isLocalPath(path, remoteNames, pathStyle);
}

/**
 * Splits an fs path into remote name and relative path.
 */
export function splitFsPath(
  fullPath: string | string[],
  remoteNames: Set<string>,
  pathStyle: PathStyle = 'posix'
): { remote: string; path: string } {
  const p = Array.isArray(fullPath) ? (fullPath[0] ?? '') : fullPath;
  if (isLocalPath(p, remoteNames, pathStyle)) return { remote: '', path: p };

  const colonIdx = p.indexOf(':');
  if (colonIdx === -1) return { remote: '', path: p };

  return {
    remote: p.substring(0, colonIdx),
    path: p.substring(colonIdx + 1).replace(/^\/+/, ''),
  };
}

/**
 * Parses user-typed location string into a matching ExplorerRoot and path.
 */
export function parseLocation(
  rawInput: string,
  knownRemotes: ExplorerRoot[],
  pathStyle: PathStyle = 'posix'
): { remote: ExplorerRoot; path: string } | null {
  if (!rawInput) return null;

  const windows = pathStyle === 'windows';
  const localInput = rawInput.startsWith('/') || (windows && /^(?:[a-zA-Z]:|\\)/.test(rawInput));
  let normalized = windows && localInput ? rawInput.replace(/\\/g, '/') : rawInput;
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);

  const inputNorm = windows ? normalized.toLowerCase() : normalized;
  let driveMatch: ExplorerRoot | undefined;
  let matchedLength = -1;
  for (const remote of knownRemotes) {
    if (!remote.isLocal || !remote.name) continue;
    const root = (windows ? remote.name.replace(/\\/g, '/') : remote.name).replace(/\/+$/, '');
    const rootNorm = windows ? root.toLowerCase() : root;
    if (
      root.length > matchedLength &&
      (inputNorm === rootNorm || inputNorm.startsWith(`${rootNorm}/`))
    ) {
      driveMatch = remote;
      matchedLength = root.length;
    }
  }

  if (driveMatch) {
    return { remote: driveMatch, path: normalized.substring(matchedLength).replace(/^\/+/, '') };
  }

  if (localInput) {
    const { root, relative } = splitLocalForStat(normalized, pathStyle);
    // Keep drive-relative roots relative when another segment is appended.
    const name = windows && /^[a-zA-Z]:$/.test(root) ? `${root}.` : root;
    return {
      remote: { name, label: name, type: 'local', isLocal: true },
      path: relative,
    };
  }

  const colonIdx = normalized.indexOf(':');
  if (colonIdx > -1) {
    const rName = normalized.substring(0, colonIdx);
    const rPath = normalized.substring(colonIdx + 1);
    const remoteMatch = knownRemotes.find(r => r.name === rName);
    const targetRemote: ExplorerRoot = remoteMatch ?? {
      name: rName,
      label: rName,
      type: 'cloud',
      isLocal: false,
    };
    return { remote: targetRemote, path: rPath.startsWith('/') ? rPath.substring(1) : rPath };
  }

  const exactMatch = knownRemotes.find(r => r.name === normalized || r.name === rawInput);
  if (exactMatch) return { remote: exactMatch, path: '' };

  const posixRoot = knownRemotes.find(r => r.isLocal && r.name === '/');
  if (posixRoot) {
    const cleanPath = normalized.replace(/^\/+/, '');
    return { remote: posixRoot, path: cleanPath };
  }

  return null;
}

/** The folders a mount or a two-way folder pair keeps, from a profile or a Quick Run config. */
function foldersOf(opType: 'mount' | 'bisync', config: Record<string, unknown>): string[] {
  const rclone = config['rclone'] as Record<string, unknown> | undefined;
  const dest = config['dest'] as { path?: string } | undefined;
  const keys = opType === 'mount' ? ['mountPoint'] : ['path1', 'path2'];
  const values = [...keys.map(key => config[key]), dest?.path, ...keys.map(key => rclone?.[key])];
  return values.filter((value): value is string => typeof value === 'string' && value !== '');
}

interface CollisionOptions {
  pathStyle?: PathStyle;
  currentOperation?: DefaultPathOp;
  quickRuns?: readonly QuickRun[];
  currentQuickRunId?: string | null;
}

/** A folder as it is compared: Windows ignores case and the kind of slash, and a last slash. */
export function normalizeMountFolder(value: string, pathStyle?: PathStyle): string {
  const path = (pathStyle === 'windows' ? value.replace(/\\/g, '/') : value)
    .trim()
    .replace(/\/+$/, '');
  return pathStyle === 'windows' ? path.toLowerCase() : path;
}

/**
 * What keeps folders: every saved mount and bisync profile of every remote, and every Quick Run
 * that mounts or syncs a folder, with the folders it keeps. What is being edited is left out: the
 * profile by its remote and name, the Quick Run by its id.
 */
function* folderKeepers(
  allSettings: Record<string, unknown> | undefined | null,
  currentRemoteName: string,
  currentProfileName: string | undefined,
  options: CollisionOptions
): Generator<{ owner: Omit<MountPathCollision, 'path'>; folders: string[] }> {
  for (const [rName, rConfig] of Object.entries(allSettings ?? {})) {
    if (!rConfig || typeof rConfig !== 'object') continue;

    for (const opType of ['mount', 'bisync'] as const) {
      const remoteConfig = rConfig as Record<string, unknown>;
      const profilesMap = (remoteConfig[REMOTE_CONFIG_KEYS[opType]] ?? remoteConfig[opType]) as
        Record<string, Record<string, unknown>> | undefined;
      if (!profilesMap || typeof profilesMap !== 'object') continue;

      for (const [pName, pConfig] of Object.entries(profilesMap)) {
        if (!pConfig || typeof pConfig !== 'object') continue;
        if (
          rName === currentRemoteName &&
          pName === currentProfileName &&
          (!options.currentOperation || options.currentOperation === opType)
        )
          continue;

        yield {
          owner: { kind: 'profile', remoteName: rName, name: pName, opType },
          folders: foldersOf(opType, pConfig),
        };
      }
    }
  }

  for (const quickRun of options.quickRuns ?? []) {
    const { operationType: opType } = quickRun;
    if (quickRun.id === options.currentQuickRunId) continue;
    if (opType !== 'mount' && opType !== 'bisync') continue;
    yield {
      owner: { kind: 'quick_run', remoteName: quickRun.remoteName, name: quickRun.name, opType },
      folders: foldersOf(opType, quickRun.config as unknown as Record<string, unknown>),
    };
  }
}

/**
 * Finds what already uses a folder: the saved mount and bisync profiles of every remote, and the
 * Quick Runs that mount or sync a folder. Each collision names its owner, so the message can say
 * which profile or which Quick Run it is.
 */
export function checkMountPathCollision(
  proposedPath: string,
  currentRemoteName: string,
  allSettings: Record<string, unknown> | undefined | null,
  isLocalPathFn: (path: string) => boolean,
  currentProfileName?: string,
  options: CollisionOptions = {}
): MountPathCollision[] {
  if (!proposedPath || !proposedPath.trim()) return [];

  const target = normalizeMountFolder(proposedPath, options.pathStyle);
  const collisions: MountPathCollision[] = [];
  for (const { owner, folders } of folderKeepers(
    allSettings,
    currentRemoteName,
    currentProfileName,
    options
  )) {
    const path = folders.find(
      folder => isLocalPathFn(folder) && normalizeMountFolder(folder, options.pathStyle) === target
    );
    if (path !== undefined) collisions.push({ ...owner, path });
  }
  return collisions;
}

/**
 * The folders that are kept, normalized, for asking about many at once: one walk over what is
 * saved instead of one for each folder asked about. A folder collides when it is in the set.
 */
export function usedMountFolders(
  currentRemoteName: string,
  allSettings: Record<string, unknown> | undefined | null,
  isLocalPathFn: (path: string) => boolean,
  currentProfileName?: string,
  options: CollisionOptions = {}
): Set<string> {
  const used = new Set<string>();
  for (const { folders } of folderKeepers(
    allSettings,
    currentRemoteName,
    currentProfileName,
    options
  )) {
    for (const folder of folders) {
      if (isLocalPathFn(folder)) used.add(normalizeMountFolder(folder, options.pathStyle));
    }
  }
  return used;
}
