/**
 * Serve-related types
 */

import { BackendOptions, FilterOptions, VfsOptions } from './params';

/**
 * Parameters for starting a serve instance
 */
export interface ServeParams {
  remoteName: string;
  fs: string;
  serveType: string;
  vfsOptions?: VfsOptions;
  serveOptions?: Record<string, unknown>;
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
    opt?: Record<string, any>;
    vfsOpt?: Record<string, unknown>;
    _config?: Record<string, unknown>;
    _filter?: Record<string, unknown>;
  };
}

/**
 * Response from listing serves
 */
export interface ServeListResponse {
  list: ServeListItem[];
}
