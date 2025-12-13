// Base option types
export type OperationOptions = Record<string, object>;
export type FlagOptions = Record<string, string | number | boolean>;

// Operation option aliases (backwards compatible)
export type SyncOptions = OperationOptions;
export type CopyOptions = OperationOptions;
export type BisyncOptions = OperationOptions;
export type MoveOptions = OperationOptions;
export type FilterOptions = OperationOptions;

// Flag option aliases (backwards compatible)
export type MountOptions = FlagOptions;
export type VfsOptions = FlagOptions;
export type BackendOptions = FlagOptions;
export type ServeOptions = FlagOptions;

// Tauri command parameter payloads
export interface SyncParams {
  remote_name: string;
  source: string;
  dest: string;
  create_empty_src_dirs: boolean;
  sync_options: SyncOptions | null;
  filter_options: FilterOptions | null;
  backend_options: BackendOptions | null;
  profile?: string;
}

export interface CopyParams {
  remote_name: string;
  source: string;
  dest: string;
  create_empty_src_dirs: boolean;
  copy_options: CopyOptions | null;
  filter_options: FilterOptions | null;
  backend_options: BackendOptions | null;
  profile?: string;
}

export interface BisyncParams {
  remote_name: string;
  source: string;
  dest: string;
  bisync_options: BisyncOptions | null;
  filter_options: FilterOptions | null;
  resync?: boolean;
  dryRun?: boolean;
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
  backend_options: BackendOptions | null;
  profile?: string;
}

export interface MoveParams {
  remote_name: string;
  source: string;
  dest: string;
  create_empty_src_dirs: boolean;
  delete_empty_src_dirs: boolean;
  move_options: MoveOptions | null;
  filter_options: FilterOptions | null;
  backend_options: BackendOptions | null;
  profile?: string;
}

export interface MountParams {
  remote_name: string;
  source: string;
  mount_point: string;
  mount_type: string;
  mount_options: MountOptions | null;
  vfs_options: VfsOptions | null;
  filter_options: FilterOptions | null;
  backend_options: BackendOptions | null;
  profile?: string;
}
