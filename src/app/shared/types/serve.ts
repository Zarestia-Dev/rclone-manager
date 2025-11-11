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
