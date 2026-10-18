import {
  ALL_PRIMARY_ACTIONS,
  SYNC_TYPES,
  OPERATION_TYPE_KEYS,
  REMOTE_CONFIG_KEYS,
  RCLONE_PATH_KEYS,
  RemoteSettings,
  RemoteStatus,
  RemoteOperationState,
  PrimaryActionType,
  SyncOperationType,
  ProfileConfigMap,
  JobInfo,
  MountedRemote,
  ServeListItem,
  isProfileScoped,
} from '@app/types';

interface ConfiguredProfiles {
  names: string[];
  knownNames: ReadonlySet<string>;
  browsePaths: Record<string, string[]>;
}

interface ProfileActivity {
  active: boolean;
  activeProfiles: Record<string, string>;
  configuredProfiles: string[];
  profileBrowsePaths: Record<string, string[]>;
}

export interface RemoteProfiles {
  operations: Record<PrimaryActionType, ConfiguredProfiles>;
  primaryActions: PrimaryActionType[];
  syncActions: PrimaryActionType[];
}

export type RemoteProfileStatus = Omit<RemoteStatus, 'diskUsage'>;

/** Reads configuration once; job updates reuse names, membership sets and browse paths. */
export function readRemoteProfiles(settings: RemoteSettings): RemoteProfiles {
  const operations = Object.fromEntries<ConfiguredProfiles>(
    ALL_PRIMARY_ACTIONS.map(type => {
      const value = settings[REMOTE_CONFIG_KEYS[type]];
      const valid = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const profiles = Object.fromEntries(
        Object.entries(valid).filter(
          ([, profile]) => profile && typeof profile === 'object' && !Array.isArray(profile)
        )
      );
      const names = Object.keys(profiles);
      return [
        type,
        { names, knownNames: new Set(names), browsePaths: buildProfileBrowsePaths(profiles) },
      ];
    })
  ) as Record<PrimaryActionType, ConfiguredProfiles>;

  const actions = (value: unknown, allowed: ReadonlySet<string>): PrimaryActionType[] =>
    Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (action): action is PrimaryActionType =>
                typeof action === 'string' && allowed.has(action)
            )
          ),
        ]
      : [];

  return {
    operations,
    primaryActions: actions(settings['primaryActions'], OPERATION_TYPE_KEYS),
    syncActions: actions(settings['syncActions'], new Set(SYNC_TYPES)),
  };
}

/** Derives only live operation state; configuration and metadata have separate lifetimes. */
export function buildRemoteProfileStatus({
  profiles,
  jobs,
  mounts,
  serves,
}: {
  profiles: RemoteProfiles;
  jobs: JobInfo[];
  mounts: MountedRemote[];
  serves: ServeListItem[];
}): RemoteProfileStatus {
  const jobsByType = new Map<string, JobInfo[]>();
  for (const job of jobs) {
    if (!isProfileScoped(job) || job.parent_job_id != null) continue;
    const group = jobsByType.get(job.job_type);
    if (group) group.push(job);
    else jobsByType.set(job.job_type, [job]);
  }
  const sync = Object.fromEntries(
    SYNC_TYPES.map(type => [
      type,
      buildOperationState(jobsByType.get(type) ?? [], profiles.operations[type]),
    ])
  ) as Record<SyncOperationType, RemoteOperationState>;
  const profileMounts = mounts.filter(isProfileScoped);
  const profileServes = serves.filter(isProfileScoped);
  return {
    ...sync,
    mount: buildStatusEntry(
      profileMounts,
      profiles.operations.mount,
      m => m.profile,
      m => m.mount_point
    ),
    serve: {
      ...buildStatusEntry(
        profileServes,
        profiles.operations.serve,
        s => s.profile,
        s => s.id
      ),
      count: profileServes.length,
      serves: profileServes,
    },
  };
}

function buildOperationState(jobs: JobInfo[], profiles: ConfiguredProfiles): RemoteOperationState {
  const configured = profiles.knownNames;
  const activeProfiles = new Map<string, number>();
  const lastRunProfiles = new Map<string, number>();
  let latest: JobInfo | undefined;
  let running: JobInfo | undefined;
  for (const job of jobs) {
    if (!latest || job.jobid > latest.jobid) latest = job;
    const isRunning = job.status === 'Running';
    if (isRunning && (!running || job.jobid > running.jobid)) running = job;
    const profile = job.profile?.trim();
    if (!profile || !configured.has(profile)) continue;
    lastRunProfiles.set(profile, Math.max(lastRunProfiles.get(profile) ?? -Infinity, job.jobid));
    if (isRunning)
      activeProfiles.set(profile, Math.max(activeProfiles.get(profile) ?? -Infinity, job.jobid));
  }
  return {
    active: !!running,
    jobId: running?.jobid ?? latest?.jobid,
    configuredProfiles: profiles.names,
    profileBrowsePaths: profiles.browsePaths,
    activeProfiles: Object.fromEntries(activeProfiles),
    lastRunProfiles: Object.fromEntries(lastRunProfiles),
  };
}

function buildStatusEntry<T>(
  items: T[],
  profiles: ConfiguredProfiles,
  getProfile: (item: T) => string | null | undefined,
  getValue: (item: T) => string
): ProfileActivity {
  const activeProfiles = new Map<string, string>();
  for (const item of items) {
    const name = getProfile(item)?.trim();
    if (name && profiles.knownNames.has(name) && !activeProfiles.has(name)) {
      activeProfiles.set(name, getValue(item));
    }
  }
  return {
    active: items.length > 0,
    configuredProfiles: profiles.names,
    profileBrowsePaths: profiles.browsePaths,
    activeProfiles: Object.fromEntries(activeProfiles),
  };
}

function buildProfileBrowsePaths(profileMap: ProfileConfigMap): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null);
  for (const [name, profile] of Object.entries(profileMap)) {
    const rclone = (profile['rclone'] as Record<string, unknown>) || profile;
    const rawPaths = RCLONE_PATH_KEYS.map(key => rclone[key]);

    const paths = rawPaths
      .flat()
      .filter((val): val is string => typeof val === 'string' && val.length > 0);

    if (paths.length > 0) {
      result[name] = Array.from(new Set(paths));
    }
  }
  return result;
}
