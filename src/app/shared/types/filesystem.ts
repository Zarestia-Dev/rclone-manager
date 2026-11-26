/**
 * Filesystem information from rclone's operations/fsinfo endpoint (Some values not exist here because I don't need them.
 * When I need them I gonna add).
 */
export interface FsInfo {
  /** Supported hash types for this remote */
  Hashes?: string[];
  /** Feature flags supported by this remote */
  Features?: Record<string, boolean | undefined> & {
    /** Whether this remote is a local filesystem (includes aliases to local paths) */
    IsLocal?: boolean;
  };
  /** Remote name */
  Name?: string;
  /** Root path of the remote */
  Root?: string;
  /** Timestamp precision in nanoseconds */
  Precision?: number;
  /** Metadata information */
  MetadataInfo?: Record<string, unknown>;
}

export interface FsTransferItem {
  remote: string;
  path: string;
  /** The name it gets at the destination: its own, or another one that keeps both. */
  name: string;
  isDir: boolean;
  /** For a folder merged into one of the same name: what happens to the files of the same name. */
  existingFiles?: ExistingFiles;
}

/**
 * What a folder merged into one of the same name does with the files of the same name there:
 * the incoming file replaces it, the one there stays, or the newer of the two stays.
 */
export type ExistingFiles = 'replace' | 'keep' | 'newer';

/** A picked local file or folder, as `local_path_info` reads it. */
export interface LocalPathInfo {
  name: string;
  isDir: boolean;
  /** Zero for a folder. */
  size: number;
  /** ISO time, when the system keeps one. */
  modTime?: string;
}

/**
 * How a picked file or folder lands where one of the same name exists, by its own name: under
 * another name, or merged into the folder there with a choice for its files of the same name.
 */
export type UploadTargets = Record<string, { name?: string; existingFiles?: ExistingFiles }>;

export interface FsDeleteItem {
  remote: string;
  path: string;
  isDir: boolean;
}

export interface ArchiveListItem {
  path: string;
  isDir: boolean;
  size?: number;
  date?: string;
  time?: string;
  name?: string;
}

export interface ArchiveListResponse {
  success: boolean;
  items: ArchiveListItem[];
}
