// Base option types
export type OperationOptions = Record<string, object>;
export type FlagOptions = Record<string, string | number | boolean>;

// Operation option aliases (used throughout the codebase)
export type SyncOptions = OperationOptions;
export type CopyOptions = OperationOptions;
export type BisyncOptions = OperationOptions;
export type MoveOptions = OperationOptions;
export type FilterOptions = OperationOptions;

// Flag option aliases (used in serve.ts and elsewhere)
export type MountOptions = FlagOptions;
export type VfsOptions = FlagOptions;
export type BackendOptions = FlagOptions;
export type ServeOptions = FlagOptions;

// Profile-based params - used by frontend services to start operations
// The backend resolves all options from cached settings
export interface ProfileParams {
  remote_name: string;
  profile_name: string;
}
