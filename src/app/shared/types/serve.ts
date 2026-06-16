/**
 * Serve-related types
 */

import { BackendOptions, FilterOptions, ServeOptions, VfsOptions } from './params';

/**
 * Parameters for starting a serve instance
 */
export interface ServeParams {
  remoteName: string;
  fs: string;
  serveType: string;
  vfsOptions?: VfsOptions;
  serveOptions?: ServeOptions;
  backendOptions?: BackendOptions;
  filterOptions?: FilterOptions;
}

/**
 * Response from starting a serve instance
 */
export interface ServeStartResponse {
  id: string; // Server ID (e.g., "http-abc123")
  addr: string; // Address server is listening on
}

/**
 * Running serve instance information
 */
export interface ServeListItem {
  id: string;
  addr: string;
  profile?: string;
  params: {
    fs: string;
    type: string;
    opt?: ServeOptions;
    vfsOpt?: VfsOptions;
    _config?: BackendOptions;
    _filter?: FilterOptions;
  };
}

/**
 * Response from listing serves
 */
export interface ServeListResponse {
  list: ServeListItem[];
}

export interface TypeInfo {
  icon: string;
}

export const TYPE_INFO: Record<string, TypeInfo> = {
  http: { icon: 'globe' },
  webdav: { icon: 'cloud' },
  ftp: { icon: 'file-arrow-up' },
  sftp: { icon: 'lock' },
  nfs: { icon: 'server' },
  dlna: { icon: 'tv' },
  restic: { icon: 'shield' },
  s3: { icon: 'bucket' },
};

export const DEFAULT_ICON = 'satellite-dish';
export const URL_BASED_PROTOCOLS = new Set(['http', 'webdav', 'ftp', 'sftp', 's3']);
