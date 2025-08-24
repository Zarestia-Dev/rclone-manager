// Operation option bags
export type SyncOptions = Record<string, object>;
export type CopyOptions = Record<string, object>;
export type BisyncOptions = Record<string, object>;
export type MoveOptions = Record<string, object>;
export type FilterOptions = Record<string, object>;

// Mount option bags
export type MountOptions = Record<string, string | number | boolean>;
export type VfsOptions = Record<string, string | number | boolean>;

// Tauri command parameter payloads
export interface SyncParams {
  remote_name: string;
  source: string;
  dest: string;
  create_empty_src_dirs: boolean;
  sync_options: SyncOptions | null;
  filter_options: FilterOptions | null;
}

export interface CopyParams {
  remote_name: string;
  source: string;
  dest: string;
  create_empty_src_dirs: boolean;
  copy_options: CopyOptions | null;
  filter_options: FilterOptions | null;
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
}

export interface MoveParams {
  remote_name: string;
  source: string;
  dest: string;
  create_empty_src_dirs: boolean;
  delete_empty_src_dirs: boolean;
  move_options: MoveOptions | null;
  filter_options: FilterOptions | null;
}

export interface MountParams {
  remote_name: string;
  source: string;
  mount_point: string;
  mount_type: string;
  mount_options: MountOptions | null;
  vfs_options: VfsOptions | null;
}
