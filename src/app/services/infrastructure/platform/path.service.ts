import { Injectable, inject, Injector, signal } from '@angular/core';
import { ExplorerRoot, FileBrowserItem, LocalDrive } from '@app/types';
import { BackendService } from '../system/backend.service';
import { ApiClientService } from './api-client.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { RemoteFileOperationsService } from '../../remote/remote-file-operations.service';
import { RemoteFacadeService } from '../../facade/remote-facade.service';

export interface PathSegment {
  name: string;
  path: string;
}

export type PathStyle = 'posix' | 'windows';

export type PathGroupType = 'local' | 'currentRemote' | `otherRemote:${string}`;

export interface PathGroup {
  type: PathGroupType;
  path: string;
  remote: string;
}

export type DefaultPathOp = 'mount' | 'bisync';

export interface PathInspectionStatus {
  state: 'clean' | 'nonEmpty' | 'colliding' | 'willCreate' | 'checking';
  details?: string;
  icon: string;
  badgeClass: string;
  labelKey: string;
}

const MOUNT_TEMPLATE_FALLBACK = '{home}/rclone-manager/{remote}';
const BISYNC_TEMPLATE_FALLBACK = '{home}/rclone-manager/{remote}-bisync';
const HOME_FALLBACK_POSIX = '/root/rclone-manager';
const MAX_DEFAULT_PATH_ATTEMPTS = 10;

@Injectable({ providedIn: 'root' })
export class PathService {
  private readonly remoteNames = new Set<string>();
  private readonly backendService = inject(BackendService);
  private readonly apiClient = inject(ApiClientService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly remoteFileOps = inject(RemoteFileOperationsService);
  private readonly injector = inject(Injector);

  private get remoteFacade(): RemoteFacadeService {
    return this.injector.get(RemoteFacadeService);
  }

  private readonly statuses = signal<Record<string, PathInspectionStatus>>({});
  private readonly checkingKeys = new Set<string>();

  setRemoteNames(names: string[]): void {
    this.remoteNames.clear();
    for (const name of names) {
      this.remoteNames.add(this.normalizeRemoteName(name));
    }
  }

  enginePathStyle(): PathStyle {
    return this.backendService.isWindows() ? 'windows' : 'posix';
  }

  pathStyleForRemote(remote: { isLocal: boolean } | null | undefined): PathStyle {
    if (!remote || remote.isLocal) return this.enginePathStyle();
    return 'posix';
  }

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

  normalizeForPlatform(path: string, pathStyle: PathStyle = this.enginePathStyle()): string {
    if (!path) return '';
    if (pathStyle === 'windows') {
      return path.replace(/\//g, '\\').replace(/([^:\\])\\+/g, '$1\\');
    }
    return path.replace(/\\/g, '/').replace(/\/+/g, '/');
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

  getParentPath(path: string, pathStyle: PathStyle = this.enginePathStyle()): string {
    if (!path || path === '/') return '';
    if (pathStyle === 'windows' && /^[a-zA-Z]:[\\/]?$/.test(path)) return '';

    const segments = this.splitSegments(path);
    if (segments.length <= 1) return path.startsWith('/') ? '/' : '';

    segments.pop();
    return (path.startsWith('/') ? '/' : '') + segments.join('/');
  }

  getPathSegments(path: string): PathSegment[] {
    if (!path) return [];
    const parts = this.splitSegments(path);
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  }

  normalizeRemoteForRclone(
    remoteName?: string,
    pathStyle: PathStyle = this.enginePathStyle()
  ): string {
    if (!remoteName) return '';
    const isAbsoluteLocal =
      pathStyle === 'windows' ? /^[A-Za-z]:[\\/]/.test(remoteName) : remoteName.startsWith('/');

    if (isAbsoluteLocal) return remoteName;
    return remoteName.endsWith(':') ? remoteName : `${remoteName}:`;
  }

  normalizeRemoteName(remoteName?: string, pathStyle: PathStyle = this.enginePathStyle()): string {
    if (!remoteName) return '';
    if (pathStyle === 'windows' && /^[a-zA-Z]:$/.test(remoteName)) {
      return remoteName;
    }
    return remoteName
      .trim()
      .replace(/:$/, '')
      .replace(/\{[A-Za-z0-9_-]+\}$/, '');
  }

  isLocalPath(path: string | string[]): boolean {
    const p = Array.isArray(path) ? path[0] : path;
    if (!p) return false;

    const colonIdx = p.indexOf(':');
    const remotePart = colonIdx > -1 ? p.substring(0, colonIdx) : p;
    const normalized = this.normalizeRemoteName(remotePart);

    return !this.remoteNames.has(normalized);
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

  splitLocalPath(
    path: string,
    pathStyle: PathStyle = this.enginePathStyle()
  ): { remote: string; remainder: string } {
    if (pathStyle === 'windows') {
      const match = path.match(/^([a-zA-Z]:)([\\/]?)(.*)$/);
      if (match) return { remote: match[1] + (match[2] ?? '\\'), remainder: match[3] };
    } else if (path.startsWith('/')) {
      return { remote: '/', remainder: path.substring(1) };
    }
    return { remote: path, remainder: '' };
  }

  splitLocalForStat(
    path: string,
    pathStyle: PathStyle = this.enginePathStyle()
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

  getFullDisplayPath(remote: ExplorerRoot | null, path: string, pathStyle?: PathStyle): string {
    if (!remote) return path;
    const style = pathStyle ?? this.pathStyleForRemote(remote);
    if (remote.isLocal) {
      const slash = style === 'windows' ? '\\' : '/';
      let cleanPath = path;
      if (style === 'windows' && path) {
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
    return path.join(', ');
  }

  formatPathTooltip(path: string | string[]): string {
    return Array.isArray(path) ? path.join('\n') : path;
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
    if (exactMatch) return { remote: exactMatch, path: '' };

    // Fallback: If no colon present, but POSIX root drive ('/') exists in knownRemotes, treat as local path under '/'
    const posixRoot = knownRemotes.find(r => r.isLocal && r.name === '/');
    if (posixRoot) {
      const cleanPath = normalized.replace(/^\/+/, '');
      return { remote: posixRoot, path: cleanPath };
    }

    return null;
  }

  parseFsString(
    fs: string,
    defaultType: 'local' | 'currentRemote' = 'local',
    currentRemoteName = '',
    existingRemotes: string[] = []
  ): PathGroup {
    if (!fs) return { type: defaultType, path: '', remote: '' };

    if (this.isLocalPath(fs)) {
      return { type: 'local', path: fs, remote: '' };
    }

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

  resolvePathGroup(item: FileBrowserItem, currentRemoteName: string): PathGroup {
    const { isLocal, remote } = item.meta;
    const entryPath = item.entry.Path;

    if (isLocal) {
      const fullPath = this.joinPath(remote, entryPath);
      return { type: 'local', path: fullPath, remote: '' };
    }

    const normalizedRemote = this.normalizeRemoteName(remote);
    const normalizedCurrent = this.normalizeRemoteName(currentRemoteName);

    const type: PathGroupType =
      normalizedRemote === normalizedCurrent ? 'currentRemote' : `otherRemote:${normalizedRemote}`;

    return { type, path: entryPath, remote: normalizedRemote };
  }

  /**
   * Get the inspection status of a local path.
   * If not cached, triggers background validation and returns a 'checking' status immediately.
   */
  getPathStatus(
    path: string | undefined | null,
    opType: string,
    remoteName: string
  ): PathInspectionStatus | null {
    if (!path || !path.trim()) {
      return null;
    }
    const trimmedPath = path.trim();
    const cacheKey = `${remoteName}:${opType}:${trimmedPath}`;

    const cached = this.statuses()[cacheKey];
    if (cached) {
      return cached;
    }

    this.triggerInspection(cacheKey, trimmedPath, remoteName);

    return {
      state: 'checking',
      icon: 'spinner',
      badgeClass: 'checking',
      labelKey: 'remoteConfig.pathStatus.checking',
    };
  }

  private async triggerInspection(key: string, path: string, remoteName: string): Promise<void> {
    if (this.checkingKeys.has(key)) return;
    this.checkingKeys.add(key);

    try {
      const status = await this.runInspection(path, remoteName);
      this.statuses.update(m => ({ ...m, [key]: status }));
    } catch {
      const fallback: PathInspectionStatus = {
        state: 'willCreate',
        icon: 'folder-plus',
        badgeClass: 'will-create',
        labelKey: 'remoteConfig.pathStatus.willCreate',
      };
      this.statuses.update(m => ({ ...m, [key]: fallback }));
    } finally {
      this.checkingKeys.delete(key);
    }
  }

  private async runInspection(path: string, remoteName: string): Promise<PathInspectionStatus> {
    // 1. Collision check (highest priority, synchronous)
    const collisions = this.remoteFacade.checkMountPathCollision(path, remoteName);
    if (collisions.length > 0) {
      const c = collisions[0];
      return {
        state: 'colliding',
        details: `${c.remoteName} (${c.opType})`,
        icon: 'triangle-exclamation',
        badgeClass: 'colliding',
        labelKey: 'remoteConfig.pathStatus.colliding',
      };
    }

    // 2. Async check via Rclone API
    const { root, relative } = this.splitLocalForStat(path);
    try {
      const statRes = await this.remoteFileOps.getStat(root, relative);
      if (!statRes?.item) {
        return {
          state: 'willCreate',
          icon: 'folder-plus',
          badgeClass: 'will-create',
          labelKey: 'remoteConfig.pathStatus.willCreate',
        };
      }

      const sizeRes = await this.remoteFileOps.getSize(root, relative).catch(() => null);
      if (sizeRes && sizeRes.count > 0) {
        return {
          state: 'nonEmpty',
          icon: 'folder-open',
          badgeClass: 'non-empty',
          labelKey: 'remoteConfig.pathStatus.nonEmpty',
        };
      }

      return {
        state: 'clean',
        icon: 'check-circle',
        badgeClass: 'clean',
        labelKey: 'remoteConfig.pathStatus.clean',
      };
    } catch {
      return {
        state: 'willCreate',
        icon: 'folder-plus',
        badgeClass: 'will-create',
        labelKey: 'remoteConfig.pathStatus.willCreate',
      };
    }
  }

  /**
   * Resolve a unique default local path for mount or bisync based on config templates.
   */
  async resolveDefaultPath(remoteName: string, opType: DefaultPathOp): Promise<string> {
    const [template, home] = await Promise.all([this.getPathTemplate(opType), this.resolveHome()]);
    const remote = this.sanitizeRemoteName(remoteName);
    const raw = this.substitute(template, home, remote);
    const normalized = this.normalizeForPlatform(raw);
    return this.ensureMountableDefault(normalized);
  }

  private async getPathTemplate(opType: DefaultPathOp): Promise<string> {
    const settingKey = opType === 'bisync' ? 'default_bisync_directory' : 'default_mount_directory';
    const fallback = opType === 'bisync' ? BISYNC_TEMPLATE_FALLBACK : MOUNT_TEMPLATE_FALLBACK;
    const stored = await this.appSettingsService.getSettingValue<string>(settingKey);
    return stored && stored.trim() ? stored : fallback;
  }

  private async resolveHome(): Promise<string> {
    try {
      const drives = await this.apiClient.invoke<LocalDrive[]>('get_local_drives');
      if (drives && drives.length > 0) {
        const first = drives[0];
        const candidate = first.name || first.mount_point || '';
        if (candidate) return candidate;
      }
    } catch (err) {
      console.warn('[PathService] Could not query Rclone local drives:', err);
    }
    return HOME_FALLBACK_POSIX;
  }

  private sanitizeRemoteName(remoteName: string): string {
    return (remoteName || 'cloud-remote').replace(/[:/\\]/g, '-');
  }

  private substitute(template: string, home: string, remote: string): string {
    return template.replace('{home}', home).replace('{remote}', remote);
  }

  private async ensureMountableDefault(path: string): Promise<string> {
    const { root, relative } = this.splitLocalForStat(path);

    for (let attempt = 0; attempt < MAX_DEFAULT_PATH_ATTEMPTS; attempt++) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const candidate = `${path}${suffix}`;
      const candidateRel = `${relative}${suffix}`;

      try {
        const stat = await this.remoteFileOps.getStat(root, candidateRel);
        if (!stat?.item) {
          return candidate;
        }
        try {
          const size = await this.remoteFileOps.getSize(root, candidateRel);
          if (!size || size.count === 0) {
            return candidate;
          }
        } catch {
          return candidate;
        }
      } catch {
        return candidate;
      }
    }
    return path;
  }

  isTrulyLocalPath(path: string, pathStyle: PathStyle = this.enginePathStyle()): boolean {
    if (!path) return false;
    const colonIdx = path.indexOf(':');
    if (colonIdx > -1) {
      if (pathStyle === 'windows' && /^[a-zA-Z]:/.test(path)) {
        return this.isLocalPath(path);
      }
      return false;
    }
    return this.isLocalPath(path);
  }

  async createLocalDirectory(path: string, parentOnly = false): Promise<void> {
    if (!path) return;
    let targetPath = path;
    if (parentOnly) {
      targetPath = this.getParentPath(path);
      if (!targetPath) return;
    }
    const { root, relative } = this.splitLocalForStat(targetPath);
    try {
      await this.remoteFileOps.makeDirectory(root, relative);
    } catch (err) {
      console.error(`[PathService] Failed to create directory: ${targetPath}`, err);
    }
  }

  async createRequiredDirectories(settings: Record<string, any>): Promise<void> {
    const pathStyle = this.enginePathStyle();

    // 1. Handle Mount Configs
    const mountConfigs = settings['mountConfigs'] || {};
    for (const config of Object.values(mountConfigs) as any[]) {
      const mountPoint = config?.rclone?.mountPoint || config?.mountPoint;
      if (
        mountPoint &&
        typeof mountPoint === 'string' &&
        this.isTrulyLocalPath(mountPoint, pathStyle)
      ) {
        await this.createLocalDirectory(mountPoint, pathStyle === 'windows');
      }
    }

    // 2. Handle Bisync Configs
    const bisyncConfigs = settings['bisyncConfigs'] || {};
    for (const config of Object.values(bisyncConfigs) as any[]) {
      const path1 = config?.rclone?.path1 || config?.path1;
      const path2 = config?.rclone?.path2 || config?.path2;

      if (path1 && typeof path1 === 'string' && this.isTrulyLocalPath(path1, pathStyle)) {
        await this.createLocalDirectory(path1, false);
      }
      if (path2 && typeof path2 === 'string' && this.isTrulyLocalPath(path2, pathStyle)) {
        await this.createLocalDirectory(path2, false);
      }
    }
  }
}
