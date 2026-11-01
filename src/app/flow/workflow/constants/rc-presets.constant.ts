/**
 * Calls offered when rclone cannot be reached to list its own, and the parameters to start them
 * with. `remote:` in `fs` stands for the first remote the user has.
 */
export interface RcPresetItem {
  command: string;
  defaultParams?: Record<string, unknown>;
  title: string;
}

export const RC_PRESETS: RcPresetItem[] = [
  {
    command: 'vfs/refresh',
    defaultParams: { recursive: true },
    title: 'Notify the VFS cache to refresh directories or whole filesystem',
  },
  {
    command: 'vfs/forget',
    defaultParams: {},
    title: 'Forget all directory cache entries or specific directory cache in VFS',
  },
  {
    command: 'vfs/poll-interval',
    defaultParams: { interval: '1m' },
    title: 'Adjust polling interval for remote file changes in VFS',
  },
  {
    command: 'operations/cleanup',
    defaultParams: { fs: 'remote:' },
    title: 'Empty trash / remove deleted files on a remote',
  },
  {
    command: 'operations/fsinfo',
    defaultParams: { fs: 'remote:' },
    title: 'Inspect remote file system features and capabilities',
  },
  {
    command: 'operations/about',
    defaultParams: { fs: 'remote:' },
    title: 'Get quota and usage information about the remote',
  },
  {
    command: 'core/bwlimit',
    defaultParams: { rate: '10M' },
    title: 'Adjust bandwidth speed limit (e.g. 10M, off)',
  },
  {
    command: 'core/stats',
    defaultParams: {},
    title: 'Retrieve transfer and runtime stats',
  },
  {
    command: 'core/version',
    defaultParams: {},
    title: 'Retrieve rclone engine version and system details',
  },
];
