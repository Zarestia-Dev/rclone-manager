import { Pipe, PipeTransform } from '@angular/core';

export type FlagType = 'mount' | 'bisync' | 'move' | 'copy' | 'sync' | 'filter' | 'vfs';
export type EditTarget = FlagType | 'remote' | null;

export type FieldType =
  | 'bool'
  | 'int'
  | 'Duration'
  | 'string'
  | 'stringArray'
  | 'CommaSeparatedList'
  | 'SizeSuffix'
  | 'int64'
  | 'uint32'
  | 'float'
  | 'password'
  | 'hidden'
  | 'option'
  | 'time'
  | 'date'
  | 'object'
  | 'json'
  | string;

export interface RemoteField {
  Name: string;
  Type: string;
  Help: string;
  Value: any;
  Default: any;
  Required: boolean;
  Advanced: boolean;
  Examples: any[];
}

export interface FlagField {
  ValueStr: string;
  Value: any;
  name: string;
  default: any;
  help: string;
  type: string;
  required: boolean;
  examples: any[];
}

export interface LoadingState {
  remoteConfig?: boolean;
  mountConfig?: boolean;
  copyConfig?: boolean;
  syncConfig?: boolean;
  saving: boolean;
  authDisabled: boolean;
  cancelled: boolean;
  [key: string]: boolean | undefined;
}

export interface RemoteType {
  value: string;
  label: string;
}

export interface MountConfig {
  autoStart: boolean;
  dest: string;
  source: string;
  type: string;
  options?: any;
  [key: string]: any;
}

export interface CopyConfig {
  autoStart: boolean;
  source: string;
  dest: string;
  createEmptySrcDirs?: boolean;
  options?: any;
  [key: string]: any;
}

export interface SyncConfig {
  autoStart: boolean;
  source: string;
  dest: string;
  createEmptySrcDirs?: boolean;
  options?: any;
  [key: string]: any;
}

export interface FilterConfig {
  options?: any;
  [key: string]: any;
}

export interface VfsConfig {
  options?: any;
  [key: string]: any;
}

export interface MoveConfig {
  autoStart: boolean;
  source: string;
  dest: string;
  createEmptySrcDirs?: boolean;
  deleteEmptySrcDirs?: boolean;
  options?: any;
  [key: string]: any;
}

export interface BisyncConfig {
  autoStart: boolean;
  source: string;
  dest: string;
  dryRun?: boolean;
  resync?: boolean;
  checkAccess?: boolean;
  checkFilename?: string;
  maxDelete?: number;
  force?: boolean;
  checkSync?: boolean | 'only';
  createEmptySrcDirs?: boolean;
  removeEmptyDirs?: boolean;
  filtersFile?: string;
  ignoreListingChecksum?: boolean;
  resilient?: boolean;
  workdir?: string;
  backupdir1?: string;
  backupdir2?: string;
  noCleanup?: boolean;
  options?: any;
  [key: string]: any;
}

export interface RemoteSettings {
  [remoteName: string]: any;
  mountConfig: MountConfig;
  copyConfig: CopyConfig;
  syncConfig: SyncConfig;
  moveConfig: MoveConfig;
  bisyncConfig: BisyncConfig;
  filterConfig: FilterConfig;
  vfsConfig: VfsConfig;
  showOnTray: boolean;
}

export interface QuickAddForm {
  remoteName: string;
  remoteType: string;
  // Mount options
  mountPath: string;
  autoMount: boolean;
  // Sync options
  syncDest: string;
  autoSync: boolean;
  // Copy options
  copyDest: string;
  autoCopy: boolean;
  // Move options
  moveDest?: string;
  autoMove?: boolean;
  // Bisync options
  bisyncDest?: string;
  autoBisync?: boolean;
}

export const REMOTE_NAME_REGEX = /^[A-Za-z0-9_\-.+@ ]+$/;

export interface Entry {
  ID: string;
  IsDir: boolean;
  MimeType: string;
  ModTime: string;
  Name: string;
  Path: string;
  Size: number;
}

export function getDefaultValueForType(type: FieldType): any {
  switch (type) {
    case 'bool':
      return false;
    case 'int':
    case 'int64':
    case 'uint32':
    case 'SizeSuffix':
      return 0;
    case 'string':
    case 'Duration':
    case 'FileMode':
    case 'CacheMode':
      return '';
    case 'stringArray':
      return [''];
    case 'Tristate':
      return null;
    case 'HARD|SOFT|CAUTIOUS':
      return 'HARD';
    default:
      return null;
  }
}

@Pipe({ name: 'linebreaks' })
export class LinebreaksPipe implements PipeTransform {
  transform(value: string): string {
    return value ? value.replace(/(?:\r\n|\r|\n)/g, '<br>') : '';
  }
}
