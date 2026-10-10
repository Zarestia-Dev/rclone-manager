import { ExplorerRoot, PathGroup, PathSegment, PathStyle } from '@app/types';

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
 * Joins path segments into a canonical normalized POSIX path.
 */
export function joinPath(...segments: string[]): string {
  return normalizePath(segments.filter(s => s != null).join('/'));
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

/**
 * Returns the parent path respecting platform style.
 */
export function getParentPath(path: string, pathStyle: PathStyle = 'posix'): string {
  if (!path || path === '/') return '';
  if (pathStyle === 'windows' && /^[a-zA-Z]:[\\/]?$/.test(path)) return '';

  const segments = splitSegments(path);
  if (segments.length <= 1) return path.startsWith('/') ? '/' : '';

  segments.pop();
  return (path.startsWith('/') ? '/' : '') + segments.join('/');
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
 * Appends a trailing colon if missing, unless it represents an absolute local path.
 */
export function normalizeRemoteForRclone(
  remoteName?: string,
  pathStyle: PathStyle = 'posix'
): string {
  if (!remoteName) return '';
  const isAbsoluteLocal =
    pathStyle === 'windows' ? /^[A-Za-z]:[\\/]/.test(remoteName) : remoteName.startsWith('/');

  if (isAbsoluteLocal) return remoteName;
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
    if (match) return { remote: match[1] + (match[2] ?? '\\'), remainder: match[3] };
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
    const match = path.match(/^([A-Za-z]:)(.*)$/);
    const root = match ? match[1] + '/' : 'C:/';
    const remainder = match ? match[2] : path;
    let relative = remainder.replace(/\\/g, '/');
    if (relative.startsWith('/')) relative = relative.substring(1);
    return { root, relative };
  }
  const relative = path.startsWith('/') ? path.substring(1) : path;
  return { root: '/', relative };
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
  remote: ExplorerRoot | null,
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
    const hasSep = remote.name.endsWith('/') || remote.name.endsWith('\\');
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
  knownRemotes: ExplorerRoot[]
): { remote: ExplorerRoot; path: string } | null {
  if (!rawInput) return null;

  let normalized = rawInput.replace(/\\/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);

  const driveMatch = knownRemotes.find(r => {
    if (!r.isLocal) return false;
    const rNorm = r.name.replace(/\\/g, '/').toLowerCase();
    const inputNorm = normalized.toLowerCase();
    return inputNorm.startsWith(rNorm) || (rNorm.endsWith('/') && inputNorm === rNorm.slice(0, -1));
  });

  if (driveMatch) {
    const rNorm = driveMatch.name.replace(/\\/g, '/');
    return { remote: driveMatch, path: normalized.substring(rNorm.length).replace(/^[/:]+/, '') };
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

  if (normalized.startsWith('/')) {
    const root = knownRemotes.find(r => r.name === '/');
    if (root) return { remote: root, path: normalized.substring(1) };
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
