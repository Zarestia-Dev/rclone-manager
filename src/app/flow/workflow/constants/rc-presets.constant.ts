export type RcPresetCategory = 'all' | 'vfs' | 'ops' | 'core';

export interface RcPresetItem {
  category: 'vfs' | 'ops' | 'core';
  label: string;
  command: string;
  defaultParams?: Record<string, unknown>;
  title: string;
}

export const RC_PRESETS: RcPresetItem[] = [
  {
    category: 'vfs',
    label: 'vfs/refresh',
    command: 'vfs/refresh',
    defaultParams: { recursive: true },
    title: 'Notify the VFS cache to refresh directories or whole filesystem',
  },
  {
    category: 'vfs',
    label: 'vfs/forget',
    command: 'vfs/forget',
    defaultParams: {},
    title: 'Forget all directory cache entries or specific directory cache in VFS',
  },
  {
    category: 'vfs',
    label: 'vfs/poll-interval',
    command: 'vfs/poll-interval',
    defaultParams: { interval: '1m' },
    title: 'Adjust polling interval for remote file changes in VFS',
  },
  {
    category: 'ops',
    label: 'cleanup',
    command: 'operations/cleanup',
    defaultParams: { fs: 'remote:' },
    title: 'Empty trash / remove deleted files on a remote',
  },
  {
    category: 'ops',
    label: 'fsinfo',
    command: 'operations/fsinfo',
    defaultParams: { fs: 'remote:' },
    title: 'Inspect remote file system features and capabilities',
  },
  {
    category: 'ops',
    label: 'about',
    command: 'operations/about',
    defaultParams: { fs: 'remote:' },
    title: 'Get quota and usage information about the remote',
  },
  {
    category: 'core',
    label: 'bwlimit',
    command: 'core/bwlimit',
    defaultParams: { rate: '10M' },
    title: 'Adjust bandwidth speed limit (e.g. 10M, off)',
  },
  {
    category: 'core',
    label: 'core/stats',
    command: 'core/stats',
    defaultParams: {},
    title: 'Retrieve transfer and runtime stats',
  },
  {
    category: 'core',
    label: 'core/version',
    command: 'core/version',
    defaultParams: {},
    title: 'Retrieve rclone engine version and system details',
  },
];
