import { Injectable } from '@angular/core';
import { ExplorerRoot } from '@app/types';

export interface PathSegment {
  name: string;
  path: string;
}

export type PathGroupType = 'local' | 'currentRemote' | `otherRemote:${string}`;

export interface PathGroup {
  type: PathGroupType;
  path: string;
  remote: string;
}

@Injectable({ providedIn: 'root' })
export class PathService {
  normalizePath(p: string): string {
    if (!p) return '';
    const normalized = p.replace(/\\/g, '/');
    const isAbsolute = normalized.startsWith('/');
    const stack: string[] = [];

    for (const part of this.splitSegments(normalized)) {
      if (part === '.') continue;
      if (part === '..') {
        stack.pop();
      } else {
        stack.push(part);
      }
    }

    return (isAbsolute ? '/' : '') + stack.join('/');
  }

  joinPath(...segments: string[]): string {
    return this.normalizePath(segments.filter(s => s != null).join('/'));
  }

  getFilename(path: string): string {
    return this.splitSegments(path).pop() ?? '';
  }

  getDirname(path: string): string {
    if (!path) return '';
    const normalized = path.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) return '';
    if (lastSlash === 0) return '/';
    return normalized.substring(0, lastSlash);
  }

  getParentPath(path: string): string {
    if (!path || path === '/' || /^[a-zA-Z]:[\\/]?$/.test(path)) return '';

    const normalized = path.replace(/\\/g, '/');
    const segments = this.splitSegments(normalized);
    if (segments.length <= 1) return path.startsWith('/') ? '/' : '';

    segments.pop();
    return (path.startsWith('/') ? '/' : '') + segments.join('/');
  }

  getPathSegments(path: string): PathSegment[] {
    if (!path) return [];
    const parts = this.splitSegments(path);
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  }

  normalizeRemoteForRclone(remoteName?: string): string {
    if (!remoteName) return '';
    if (remoteName.startsWith('/')) return remoteName;
    if (/^[A-Za-z]:[\\/]/.test(remoteName)) return remoteName;
    return remoteName.endsWith(':') ? remoteName : `${remoteName}:`;
  }

  normalizeRemoteName(remoteName?: string, isLocal = false): string {
    if (!remoteName) return '';
    if (isLocal && /^[a-zA-Z]:$/.test(remoteName)) return remoteName;
    return remoteName
      .trim()
      .replace(/:$/, '')
      .replace(/\{[A-Za-z0-9_-]+\}$/, '');
  }

  isLocalPath(path: string | string[]): boolean {
    const p = Array.isArray(path) ? path[0] : path;
    if (!p) return false;
    return p.startsWith('/') || /^[a-zA-Z]:([\\/]|$)/.test(p);
  }

  splitFsPath(fullPath: string | string[]): { remote: string; path: string } {
    const p = Array.isArray(fullPath) ? (fullPath[0] ?? '') : fullPath;
    if (this.isLocalPath(p)) return { remote: '', path: p };

    const colonIdx = p.indexOf(':');
    if (colonIdx === -1) return { remote: '', path: p };

    return {
      remote: p.substring(0, colonIdx),
      path: p.substring(colonIdx + 1).replace(/^\/+/, ''),
    };
  }

  splitLocalPath(path: string): { remote: string; remainder: string } {
    if (path.startsWith('/')) return { remote: '/', remainder: path.substring(1) };

    const match = path.match(/^([a-zA-Z]:)([\\/]?)(.*)$/);
    if (match) return { remote: match[1] + (match[2] ?? '\\'), remainder: match[3] };

    return { remote: path, remainder: '' };
  }

  normalizeFs(fs: unknown): string {
    if (typeof fs === 'string') return fs;
    if (!fs || typeof fs !== 'object') return '';

    const fsObj = fs as Record<string, unknown>;
    const root = typeof fsObj['_root'] === 'string' ? fsObj['_root'] : '';

    if (typeof fsObj['_name'] === 'string') return `${fsObj['_name']}:${root}`;
    if (typeof fsObj['type'] === 'string') return `:${fsObj['type']}:${root}`;
    return '';
  }

  getRemoteNameFromFs(fs: unknown): string {
    const normalized = this.normalizeFs(fs);
    if (!normalized) return '';
    if (this.isLocalPath(normalized)) return 'local';
    return this.normalizeRemoteName(normalized.split(':')[0]);
  }

  buildPathString(pathGroup: PathGroup | string, currentRemoteName: string): string {
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

  joinFsPath(fs: string | undefined, path: string): string {
    if (!fs) return path;
    return fs.endsWith(':') || fs.endsWith('/') || fs.endsWith('\\')
      ? `${fs}${path}`
      : `${fs}/${path}`;
  }

  buildPathStrings(
    pathGroups: PathGroup | PathGroup[] | null | undefined,
    currentRemoteName: string
  ): string[] {
    if (!pathGroups) return [];
    if (Array.isArray(pathGroups)) {
      return pathGroups.map(pg => this.buildPathString(pg, currentRemoteName)).filter(Boolean);
    }
    const single = this.buildPathString(pathGroups, currentRemoteName);
    return single ? [single] : [];
  }

  parsePathType(value: string): 'local' | 'currentRemote' | 'otherRemote' {
    if (value === 'local') return 'local';
    if (value === 'currentRemote') return 'currentRemote';
    if (value === 'otherRemote' || value?.startsWith('otherRemote:')) return 'otherRemote';
    return 'local';
  }

  getRemoteNameFromValue(value: string, currentRemoteName: string): string | null {
    if (value?.startsWith('otherRemote:')) return value.substring('otherRemote:'.length) || null;
    return value === 'currentRemote' ? currentRemoteName : null;
  }

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

  getDisplaySegment(remote: ExplorerRoot | null, path: string, fallback = ''): string {
    if (path) return this.splitSegments(path).pop() ?? path;
    if (remote) return remote.label || remote.name;
    return fallback;
  }

  extractName(path: string, remoteName?: string): string {
    if (path) return this.splitSegments(path).pop() ?? path;
    return remoteName ?? '';
  }

  splitSegments(path: string): string[] {
    if (!path) return [];
    return path.split(/[\\/]/).filter(Boolean);
  }

  isMultiPath(path: string | string[]): boolean {
    return Array.isArray(path) && path.length > 1;
  }

  asPathArray(path: string | string[]): string[] {
    return Array.isArray(path) ? path : [path];
  }

  getPrimaryPath(path: string | string[]): string {
    return Array.isArray(path) ? (path[0] ?? '') : path;
  }

  formatPathDisplay(path: string | string[]): string {
    if (!Array.isArray(path)) return path;
    if (path.length === 0) return '';
    if (path.length === 1) return path[0];
    return `${path[0]} (+${path.length - 1})`;
  }

  formatPathTooltip(path: string | string[]): string {
    return Array.isArray(path) ? path.join('\n') : path;
  }

  encodePath(
    path: string,
    isLocal: boolean,
    options: { platform?: string; protocol?: string } = {}
  ): string {
    if (!path) return '';

    const normalized = path.replace(/\\/g, '/');
    const isWindows = options.platform === 'windows';
    const isHttp = options.protocol === 'http';

    const encodedSegments = this.splitSegments(normalized).map((seg, i) => {
      if (i === 0 && /^[A-Za-z]:$/.test(seg)) {
        return isWindows && isHttp ? seg.replace(':', '%3A') : seg;
      }
      return encodeURIComponent(seg);
    });

    const joined = encodedSegments.join('/');
    return normalized.startsWith('/') && !joined.startsWith('/') ? '/' + joined : joined;
  }

  decodePath(path: string): string {
    if (!path) return '';
    return this.splitSegments(path)
      .map(seg => decodeURIComponent(seg))
      .join('/');
  }

  parseLocation(
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
      return (
        inputNorm.startsWith(rNorm) || (rNorm.endsWith('/') && inputNorm === rNorm.slice(0, -1))
      );
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
    return exactMatch ? { remote: exactMatch, path: '' } : null;
  }

  parseFsString(
    fs: string,
    defaultType: 'local' | 'currentRemote' = 'local',
    currentRemoteName = '',
    existingRemotes: string[] = []
  ): PathGroup {
    if (!fs) return { type: defaultType, path: '', remote: '' };

    const colonIdx = fs.indexOf(':');
    if (colonIdx > -1) {
      const remote = fs.substring(0, colonIdx);
      const path = fs.substring(colonIdx + 1);
      if (remote === currentRemoteName) {
        return { type: 'currentRemote', path, remote: '' };
      }
      return { type: `otherRemote:${remote}`, path, remote };
    }

    if (existingRemotes.includes(fs)) {
      if (fs === currentRemoteName) {
        return { type: 'currentRemote', path: '', remote: '' };
      }
      return { type: `otherRemote:${fs}`, path: '', remote: fs };
    }

    return { type: 'local', path: fs, remote: '' };
  }
}
