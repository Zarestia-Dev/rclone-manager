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
