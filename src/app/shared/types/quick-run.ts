import type { AppConfig } from './remote-config';
import type { ConfigWithSubConfigs } from '../utils/profile-config.util';
import { getRcloneCfg } from '../utils/profile-config.util';
import type { PrimaryActionType } from './operations';
import type { ConfigValue } from './system';

/**
 * Runtime status of a quick run entry.
 *
 * - `idle`       — saved but never executed (or stopped long ago)
 * - `running`    — currently executing a job
 * - `completed`  — last execution finished successfully
 * - `failed`     — last execution failed
 * - `stopped`    — last execution was stopped by the user
 */
export type QuickRunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Payload sent to the backend when creating or updating a quick run.
 * The full rclone config (paths + flags) lives under `rclone`,
 * while app-level scheduling lives under `app` — the same split
 * the remote-config-modal uses for per-profile configs.
 *
 * This mirrors {@link ConfigWithSubConfigs} from profile-config.util so
 * the existing `getAppCfg()` / `getRcloneCfg()` helpers work on it
 * without any adapter. `rclone` is typed as `unknown` here (matching
 * the upstream interface) and narrowed to {@link RcloneSubConfig} at
 * consumption sites.
 */
export interface QuickRunConfig extends ConfigWithSubConfigs {
  /** App-level config: autostart, cron schedule, watch, etc. */
  app: AppConfig;
  /** Categorized or flat rclone config (opType, vfs, filter, backend). */
  rclone: Record<string, unknown>;
}

/**
 * A saved "quick run" — a one-off rclone operation that lives entirely
 * inside the Flow workspace and is NOT attached to a remote's profile map
 * (i.e. it is not stored under `RemoteConfigSections[REMOTE_CONFIG_KEYS[op]]`).
 *
 * Each quick run owns its own copy of:
 *   - a human-readable `name`
 *   - a stable `id` (uuid-ish)
 *   - the bound `remoteName` (used for path autocomplete + job dispatch)
 *   - the operation type (any `PrimaryActionType`)
 *   - the full app + rclone config (mirrors `ProfileConfig` shape)
 *   - runtime metadata (status, last run, job id, run count, etc.)
 */
export interface QuickRun {
  /** Stable unique identifier (uuid v4 or similar). */
  readonly id: string;

  /** User-facing display name. */
  name: string;

  /** Optional longer description shown in the inspect view. */
  description?: string;

  /** The rclone operation this quick run performs. */
  operationType: PrimaryActionType;

  /**
   * The remote this quick run is bound to. Used for path autocomplete,
   * job dispatch, and the inspect view's path-display component.
   */
  remoteName: string;

  /** Full app + rclone config — same shape as a remote-config profile. */
  config: QuickRunConfig;

  /** In-memory runtime status — drives the card badge + detail header color. */
  status: QuickRunStatus;
}

/**
 * Payload sent to the backend `create_quick_run` / `update_quick_run` commands.
 */
export interface QuickRunInput {
  id?: string;
  name: string;
  description?: string;
  operationType: PrimaryActionType;
  remoteName: string;
  config: QuickRunConfig;
}

/**
 * Safely extract the rclone srcFs/dstFs/path1/path2/fs/mountPoint from a
 * quick run's config, returning the most relevant value for display.
 *
 * Uses {@link getRcloneCfg} so it works on any {@link ConfigWithSubConfigs},
 * not just a fully-typed {@link QuickRunConfig} — useful when consuming
 * form values or backend payloads where `rclone` is still `unknown`.
 *
 * - For mount: returns `mountPoint` (no destination concept).
 * - For bisync: returns `path1` (source) and `path2` (destination).
 * - For sync/copy/move/check/cryptcheck/delete/copyurl/archivecreate:
 *   returns `srcFs` (source) and `dstFs` (destination).
 * - For serve: returns `fs` (source) only.
 */
export function getQuickRunPaths(config: ConfigWithSubConfigs): {
  source: string | string[] | undefined;
  destination: string | undefined;
} {
  const rclone = getRcloneCfg(config);
  if (!rclone) return { source: undefined, destination: undefined };
  const rawSrc = rclone['srcFs'] ?? rclone['path1'] ?? rclone['fs'] ?? rclone['source'];
  const rawDst = rclone['mountPoint'] ?? rclone['dstFs'] ?? rclone['path2'] ?? rclone['dest'];

  const source = Array.isArray(rawSrc)
    ? rawSrc.map(v => String(v ?? ''))
    : rawSrc != null
      ? String(rawSrc)
      : undefined;

  const destination = rawDst != null ? String(rawDst) : undefined;

  return { source, destination };
}

/**
 * Convert a `ConfigValue` to a string for display in the inspect view.
 * Arrays are joined with `, ` and falsy values become `''`.
 */
export function formatConfigValue(value: ConfigValue | undefined): string {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
