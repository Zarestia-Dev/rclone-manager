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
  name: string;
  isDir: boolean;
}

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
