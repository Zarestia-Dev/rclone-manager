import { Injectable } from '@angular/core';
import { ExplorerRoot } from '@app/types';

export interface PathSegment {
  name: string;
  path: string;
}

@Injectable({
  providedIn: 'root',
})
export class PathService {
  /**
   * Normalize a path by resolving '.' and '..' segments and replacing backslashes.
   */
  normalizePath(p: string): string {
    if (!p) return '';
    const normalized = p.replace(/\\/g, '/');
    const isAbsolute = normalized.startsWith('/');
    const parts = this.splitSegments(normalized);
    const stack: string[] = [];

    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(part);
      }
    }

    return (isAbsolute ? '/' : '') + stack.join('/');
  }

  /**
   * Joins multiple path segments into a single path.
   */
  joinPath(...segments: string[]): string {
    const parts = segments.filter(s => s !== undefined && s !== null).join('/');
    return this.normalizePath(parts);
  }

  /**
   * Extracts the filename (last component) from a path.
   */
  getFilename(path: string): string {
    if (!path) return '';
    const segments = this.splitSegments(path);
    return segments.pop() || '';
  }

  /**
   * Gets the directory name of a path.
   */
  getDirname(path: string): string {
    if (!path) return '';
    const normalized = path.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) return '';
    // If it's just a slash at the beginning, return /
    if (lastSlash === 0) return '/';
    return normalized.substring(0, lastSlash);
  }

  /**
   * Gets the parent path of a directory or file.
   */
  getParentPath(path: string): string {
    if (!path || path === '/' || /^[a-zA-Z]:[\\/]?$/.test(path)) return '';

    const normalized = path.replace(/\\/g, '/');
    const segments = this.splitSegments(normalized);
    if (segments.length <= 1) {
      return path.startsWith('/') ? '/' : '';
    }

    segments.pop();
    const joined = segments.join('/');
    return path.startsWith('/') ? '/' + joined : joined;
  }

  /**
   * Returns path segments for breadcrumb-like UI.
   */
  getPathSegments(path: string): PathSegment[] {
    if (!path) return [];
    const parts = this.splitSegments(path);
    return parts.map((name, i) => ({
      name,
      path: parts.slice(0, i + 1).join('/'),
    }));
  }

  /**
   * Normalize remote name for rclone backend calls.
   * - Empty or `Local` should be treated as local filesystem (send empty string)
   * - If the remote already ends with ':' return as-is
   * - Otherwise append ':' so rclone receives `remote:` format
   */
  normalizeRemoteForRclone(remoteName?: string): string {
    if (!remoteName) return '';
    if (remoteName.startsWith('/')) return remoteName;
    if (/^[A-Za-z]:[\\/]/.test(remoteName)) return remoteName;
    return remoteName.endsWith(':') ? remoteName : `${remoteName}:`;
  }

  /**
   * Normalize remote name for internal lookups / display keys.
   * Removes a trailing ':' if present and handles rclone runtime suffixes (e.g., {Gyju7}).
   */
  normalizeRemoteName(remoteName?: string, isLocal = false): string {
    if (!remoteName) return '';
    // If it's a local Windows drive, we MUST preserve the colon
    if (isLocal && /^[a-zA-Z]:$/.test(remoteName)) return remoteName;

    return remoteName
      .trim()
      .replace(/:$/, '')
      .replace(/\{[A-Za-z0-9_-]+\}$/, '');
  }

  /**
   * Returns true for Unix absolute paths (/foo) and Windows drive paths (C:\ or C:/).
   */
  isLocalPath(path: string | string[]): boolean {
    const p = Array.isArray(path) ? path[0] : path;
    if (!p) return false;
    return p.startsWith('/') || /^[a-zA-Z]:([\\/]|$)/.test(p);
  }

  /**
   * Splits an rclone path into its remote name and relative path components.
   */
  splitFsPath(fullPath: string | string[]): { remote: string; path: string } {
    const p = Array.isArray(fullPath) ? fullPath[0] || '' : fullPath;
    if (this.isLocalPath(p)) return { remote: '', path: p };

    const colonIdx = p.indexOf(':');
    if (colonIdx === -1) return { remote: '', path: p };

    return {
      remote: p.substring(0, colonIdx),
      path: p.substring(colonIdx + 1).replace(/^\/+/, ''),
    };
  }

  /**
   * Splits an absolute local path into its root and remainder.
   */
  splitLocalPath(path: string): { remote: string; remainder: string } {
    if (path.startsWith('/')) {
      return { remote: '/', remainder: path.substring(1) };
    }
    const windowsMatch = path.match(/^([a-zA-Z]:)([\\/]?)(.*)$/);
    if (windowsMatch) {
      return { remote: windowsMatch[1] + (windowsMatch[2] || '\\'), remainder: windowsMatch[3] };
    }
    return { remote: path, remainder: '' };
  }

  /**
   * Normalizes an rclone fs value to a string.
   */
  normalizeFs(fs: unknown): string {
    if (typeof fs === 'string') return fs;
    if (!fs || typeof fs !== 'object') return '';

    const fsObj = fs as Record<string, unknown>;
    const root = typeof fsObj['_root'] === 'string' ? fsObj['_root'] : '';

    if (typeof fsObj['_name'] === 'string') return `${fsObj['_name']}:${root}`;
    if (typeof fsObj['type'] === 'string') return `:${fsObj['type']}:${root}`;

    return '';
  }

  /**
   * Safely extracts the remote name from an rclone fs value.
   */
  getRemoteNameFromFs(fs: unknown): string {
    const normalized = this.normalizeFs(fs);
    if (!normalized) return '';
    if (this.isLocalPath(normalized)) return 'local';
    return this.normalizeRemoteName(normalized.split(':')[0]);
  }

  /**
   * Builds an rclone path string (e.g. "myRemote:path/to/dir") from a form path group object.
   */
  buildPathString(pathGroup: any, currentRemoteName: string): string {
    if (pathGroup === null || pathGroup === undefined) return '';

    // Simple string path — e.g. mount dest which is always local
    if (typeof pathGroup === 'string') return pathGroup;

    const { type, path, remote } = pathGroup;
    const p = path || '';

    if (typeof type === 'string' && type.startsWith('otherRemote:')) {
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
   * Robustly joins an rclone filesystem root and a relative path.
   */
  joinFsPath(fs: string | undefined, path: string): string {
    if (!fs) return path;
    if (fs.endsWith(':') || fs.endsWith('/') || fs.endsWith('\\')) {
      return `${fs}${path}`;
    }
    return `${fs}/${path}`;
  }

  /**
   * Builds an array of rclone path strings from one or more form path groups.
   */
  buildPathStrings(pathGroups: any | any[], currentRemoteName: string): string[] {
    if (!pathGroups) return [];
    if (Array.isArray(pathGroups)) {
      return pathGroups.map(pg => this.buildPathString(pg, currentRemoteName)).filter(p => !!p);
    }
    const single = this.buildPathString(pathGroups, currentRemoteName);
    return single ? [single] : [];
  }

  /**
   * Parse a path type value (e.g. 'local', 'currentRemote', 'otherRemote:name')
   */
  parsePathType(value: string): 'local' | 'currentRemote' | 'otherRemote' {
    if (value === 'local') return 'local';
    if (value === 'currentRemote') return 'currentRemote';
    if (value?.startsWith('otherRemote:')) return 'otherRemote';
    return 'local';
  }

  /**
   * Extract remote name from a path type value.
   */
  getRemoteNameFromValue(value: string, currentRemoteName: string): string | null {
    if (value?.startsWith('otherRemote:')) {
      return value.substring('otherRemote:'.length) || null;
    }
    return value === 'currentRemote' ? currentRemoteName : null;
  }

  /**
   * Formats a path for display/input field, including remote prefix.
   */
  getFullDisplayPath(remote: ExplorerRoot | null, path: string): string {
    if (!remote) return path;
    if (remote.isLocal) {
      const sep = remote.name.endsWith('/') || remote.name.endsWith('\\') ? '' : '/';
      return path ? `${remote.name}${sep}${path}` : remote.name;
    }
    const prefix = remote.name.includes(':') ? remote.name : `${remote.name}:`;
    const cleanPath = path.startsWith('/') ? path.substring(1) : path;
    return path ? `${prefix}${cleanPath}` : prefix;
  }

  /**
   * Returns a display name for a specific path (usually the last segment or remote name).
   */
  getDisplaySegment(remote: ExplorerRoot | null, path: string, fallback = ''): string {
    if (path) {
      const segments = this.splitSegments(path);
      return segments.pop() || path;
    }
    if (remote) {
      return remote.label || remote.name;
    }
    return fallback;
  }

  /**
   * Extracts the filename (last component) from a path, falling back to remote name.
   */
  extractName(path: string, remoteName?: string): string {
    if (path) {
      const segments = this.splitSegments(path);
      return segments.pop() || path;
    }
    return remoteName || '';
  }

  /**
   * Robustly splits a path into non-empty segments, handling both / and \.
   */
  splitSegments(path: string): string[] {
    if (!path) return [];
    return path.split(/[\\/]/).filter(Boolean);
  }

  /**
   * Returns true when a path value contains multiple entries.
   */
  isMultiPath(path: string | string[]): boolean {
    return Array.isArray(path) && path.length > 1;
  }

  /**
   * Normalizes a path value into an array.
   */
  asPathArray(path: string | string[]): string[] {
    if (Array.isArray(path)) return path;
    return [path];
  }

  /**
   * Returns the primary path value from a single or multi-path input.
   */
  getPrimaryPath(path: string | string[]): string {
    return Array.isArray(path) ? path[0] || '' : path;
  }

  /**
   * Formats a path value for display in compact UI.
   */
  formatPathDisplay(path: string | string[]): string {
    if (Array.isArray(path)) {
      if (path.length === 0) return '';
      if (path.length === 1) return path[0];
      return `${path[0]} (+${path.length - 1})`;
    }
    return path;
  }

  /**
   * Formats a path value for tooltip display.
   */
  formatPathTooltip(path: string | string[]): string {
    return Array.isArray(path) ? path.join('\n') : path;
  }

  /**
   * Encodes path segments for URLs/custom protocols.
   * Handles Windows drive colons and individual segment encoding.
   */
  encodePath(
    path: string,
    isLocal: boolean,
    options: { platform?: string; protocol?: string } = {}
  ): string {
    if (!path) return '';

    const normalized = path.replace(/\\/g, '/');
    const segments = this.splitSegments(normalized);

    // Handle Windows drive letter at the start
    const isWindows = options.platform === 'windows';
    const isProtocolHttp = options.protocol === 'http';

    const encodedSegments = segments.map((seg, i) => {
      // First segment check for Windows drive "C:"
      if (i === 0 && /^[A-Za-z]:$/.test(seg)) {
        if (isWindows && isProtocolHttp) {
          // In http://local-asset.localhost/C%3A/..., we need %3A
          return seg.replace(':', '%3A');
        }
        return seg; // Keep as C: for other cases or Linux
      }
      return encodeURIComponent(seg);
    });

    const joined = encodedSegments.join('/');
    if (normalized.startsWith('/') && !joined.startsWith('/')) {
      return '/' + joined;
    }
    return joined;
  }

  /**
   * Decodes path segments.
   */
  decodePath(path: string): string {
    if (!path) return '';
    return this.splitSegments(path)
      .map(seg => decodeURIComponent(seg))
      .join('/');
  }

  /**
   * Parses a raw path string (rclone syntax, Windows drive letter, Unix path,
   * or bare remote name) into a resolved remote + path pair.
   */
  parseLocation(
    rawInput: string,
    knownRemotes: ExplorerRoot[]
  ): { remote: ExplorerRoot; path: string } | null {
    if (!rawInput) return null;

    let normalized = rawInput.replace(/\\/g, '/');
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    // 1. Local drive match (Windows C:\ or mounted drives)
    const driveMatch = knownRemotes.find(r => {
      if (!r.isLocal) return false;
      const rNameNorm = r.name.replace(/\\/g, '/').toLowerCase();
      const inputNorm = normalized.toLowerCase();
      return (
        inputNorm.startsWith(rNameNorm) ||
        (rNameNorm.endsWith('/') && inputNorm === rNameNorm.slice(0, -1))
      );
    });

    if (driveMatch) {
      const rNameNorm = driveMatch.name.replace(/\\/g, '/');
      const remaining = normalized.substring(rNameNorm.length);
      return { remote: driveMatch, path: remaining.replace(/^[/:]+/, '') };
    }

    // 2. Rclone syntax (remote:path)
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

    // 3. Unix root
    if (normalized.startsWith('/')) {
      const root = knownRemotes.find(r => r.name === '/');
      if (root) return { remote: root, path: normalized.substring(1) };
    }

    // 4. Bare remote name
    const exactMatch = knownRemotes.find(r => r.name === normalized || r.name === rawInput);
    if (exactMatch) return { remote: exactMatch, path: '' };

    return null;
  }

  /**
   * Parses an rclone fs string into a path group object for form use.
   */
  parseFsString(
    fs: string,
    defaultType: 'local' | 'currentRemote' = 'local',
    currentRemoteName = '',
    existingRemotes: string[] = []
  ): any {
    if (!fs) return { type: defaultType, path: '', remote: '' };

    // Check if it's a known remote:path
    const colonIdx = fs.indexOf(':');
    if (colonIdx > -1) {
      const remote = fs.substring(0, colonIdx);
      const path = fs.substring(colonIdx + 1);
      const type = remote === currentRemoteName ? 'currentRemote' : 'otherRemote';
      return { type, path, remote: type === 'otherRemote' ? remote : '' };
    }

    // Check if it's a bare remote name
    if (existingRemotes.includes(fs)) {
      const type = fs === currentRemoteName ? 'currentRemote' : 'otherRemote';
      return { type, path: '', remote: type === 'otherRemote' ? fs : '' };
    }

    // Otherwise assume local
    return { type: 'local', path: fs, remote: '' };
  }
}
