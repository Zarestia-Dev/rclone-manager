import {
  BisyncConfig,
  CopyConfig,
  EditTarget,
  Entry,
  FieldType,
  FilterConfig,
  FlagField,
  FlagType,
  LoadingState,
  MountConfig,
  QuickAddForm,
  RemoteConfigSections,
  RemoteField,
  RemoteType,
  REMOTE_NAME_REGEX,
  SyncConfig,
  VfsConfig,
  MoveConfig,
} from '@app/types';

// Keep compatibility: re-export moved types from shared/types
export type {
  BisyncConfig,
  CopyConfig,
  EditTarget,
  Entry,
  FieldType,
  FilterConfig,
  FlagField,
  FlagType,
  LoadingState,
  MountConfig,
  QuickAddForm,
  RemoteField,
  RemoteType,
  SyncConfig,
  VfsConfig,
  MoveConfig,
};

// Back-compat alias: old name RemoteSettings now maps to RemoteConfigSections
export type RemoteSettings = RemoteConfigSections;

export { REMOTE_NAME_REGEX };

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
