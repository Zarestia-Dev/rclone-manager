import { describe, expect, it } from 'vitest';
import { JobInfo, MountedRemote, RemoteSettings, ServeListItem } from '@app/types';
import { buildRemoteProfileStatus, readRemoteProfiles } from './remote-profile-state.util';

function view(
  settings: RemoteSettings = {},
  jobs: JobInfo[] = [],
  mounts: MountedRemote[] = [],
  serves: ServeListItem[] = []
): { status: ReturnType<typeof buildRemoteProfileStatus> } {
  return {
    status: buildRemoteProfileStatus({
      profiles: readRemoteProfiles(settings),
      jobs,
      mounts,
      serves,
    }),
  };
}

describe('remote profile state', () => {
  it('handles empty profile settings', () => {
    const remote = view({ config: { name: 'old', type: 'drive' } });
    expect(remote.status.sync.active).toBe(false);
    expect(remote.status.serve.count).toBe(0);
  });

  it('selects the latest job per profile independent of array order and excludes other execution scopes', () => {
    const jobs = [
      { jobid: 3, profile: ' photos ', job_type: 'sync', status: 'Completed' },
      { jobid: 9, profile: 'photos', job_type: 'sync', status: 'Failed' },
      { jobid: 20, profile: 'photos', job_type: 'sync', status: 'Running', origin: 'quickrun' },
      { jobid: 21, profile: 'photos', job_type: 'sync', status: 'Running', workflow_id: 'flow' },
      { jobid: 10, profile: 'missing', job_type: 'copy', status: 'Running' },
    ] as JobInfo[];
    const settings = { syncConfigs: { photos: {} } };
    const first = view(settings, jobs).status;
    const reversed = view(settings, [...jobs].reverse()).status;
    expect(first.sync).toEqual(reversed.sync);
    expect(first.sync.jobId).toBe(9);
    expect(first.sync.lastRunProfiles).toEqual({ photos: 9 });
    expect(first.sync.active).toBe(false);
    expect(first.copy.active).toBe(true);
    expect(first.copy.activeProfiles).toEqual({});
  });

  it('supports prototype-like profile names and deduplicates valid browse paths', () => {
    const profiles = JSON.parse(
      '{"__proto__":{"rclone":{"source":["drive:a","drive:a",null,""]}},"constructor":{}}'
    );
    const remote = view({ syncConfigs: profiles }, [
      { jobid: 1, profile: '__proto__', job_type: 'sync', status: 'Running' },
      { jobid: 2, profile: 'constructor', job_type: 'sync', status: 'Running' },
    ] as JobInfo[]);
    expect(remote.status.sync.activeProfiles?.['__proto__']).toBe(1);
    expect(remote.status.sync.activeProfiles?.['constructor']).toBe(2);
    expect(remote.status.sync.profileBrowsePaths?.['__proto__']).toEqual(['drive:a']);
  });

  it('handles invalid profile data and chooses the most recent running job', () => {
    const settings = {
      mountConfigs: null,
      serveConfigs: [],
      syncConfigs: { main: {}, invalid: null },
    };
    const remote = view(settings, [
      { jobid: 2, profile: 'main', job_type: 'sync', status: 'Running' },
      { jobid: 5, profile: 'main', job_type: 'sync', status: 'Running' },
      { jobid: 8, profile: 'main', job_type: 'sync', status: 'Completed' },
    ] as JobInfo[]);
    expect(remote.status.sync.jobId).toBe(5);
    expect(remote.status.sync.activeProfiles).toEqual({ main: 5 });
    expect(remote.status.sync.lastRunProfiles).toEqual({ main: 8 });
    expect(remote.status.sync.configuredProfiles).toEqual(['main']);
    expect(remote.status.mount.configuredProfiles).toEqual([]);
  });

  it('counts only dashboard mounts and serves', () => {
    const remote = view(
      { mountConfigs: { main: {} }, serveConfigs: { web: {} } },
      [],
      [
        { fs: 'drive:', mount_point: '/tmp/mount', profile: 'main' },
        { fs: 'drive:', mount_point: '/tmp/quick', origin: 'quickrun' },
      ],
      [
        { id: 'web', profile: 'web' },
        { id: 'flow', workflow_id: 'workflow' },
      ] as ServeListItem[]
    );
    expect(remote.status.mount.activeProfiles).toEqual({ main: '/tmp/mount' });
    expect(remote.status.serve.count).toBe(1);
    expect(remote.status.serve.activeProfiles).toEqual({ web: 'web' });
  });
  it('validates configured action lists and ignores unsupported values', () => {
    const profiles = readRemoteProfiles({
      primaryActions: ['mount', 'mount', 'unknown', null],
      syncActions: ['mount', 'sync', 'sync', 'bad'],
    });
    expect(profiles.primaryActions).toEqual(['mount']);
    expect(profiles.syncActions).toEqual(['sync']);
    expect(readRemoteProfiles({ primaryActions: {}, syncActions: 'sync' }).primaryActions).toEqual(
      []
    );
  });

  it('reuses prepared profile metadata across job updates', () => {
    let reads = 0;
    const profiles = readRemoteProfiles({
      syncConfigs: {
        photos: {
          get rclone(): Record<string, string> {
            reads++;
            return { source: 'drive:photos' };
          },
        },
      },
    });
    const initial = buildRemoteProfileStatus({ profiles, jobs: [], mounts: [], serves: [] });
    const running = buildRemoteProfileStatus({
      profiles,
      jobs: [{ jobid: 1, profile: 'photos', job_type: 'sync', status: 'Running' }] as JobInfo[],
      mounts: [],
      serves: [],
    });
    expect(initial.sync.profileBrowsePaths).toBe(running.sync.profileBrowsePaths);
    expect(initial.sync.configuredProfiles).toBe(running.sync.configuredProfiles);
    expect(reads).toBe(1);
    expect(running.sync.activeProfiles).toEqual({ photos: 1 });
  });
  it('uses master jobs rather than batch child jobs for profile actions', () => {
    const remote = view({ syncConfigs: { main: {} } }, [
      { jobid: 1, profile: 'main', job_type: 'sync', status: 'Completed' },
      { jobid: 2, parent_job_id: 1, profile: 'main', job_type: 'sync', status: 'Running' },
    ] as JobInfo[]);
    expect(remote.status.sync.active).toBe(false);
    expect(remote.status.sync.jobId).toBe(1);
    expect(remote.status.sync.lastRunProfiles).toEqual({ main: 1 });
  });
  it('uses timestamps rather than numeric IDs when a newer engine execution has a lower ID', () => {
    const remote = view({ syncConfigs: { main: {} } }, [
      {
        jobid: 500,
        profile: 'main',
        job_type: 'sync',
        status: 'Completed',
        start_time: '2026-10-01T10:00:00Z',
      },
      {
        jobid: 1,
        profile: 'main',
        job_type: 'sync',
        status: 'Running',
        start_time: '2026-10-02T10:00:00Z',
      },
    ] as JobInfo[]);
    expect(remote.status.sync.jobId).toBe(1);
    expect(remote.status.sync.lastRunProfiles).toEqual({ main: 1 });
    expect(remote.status.sync.activeProfiles).toEqual({ main: 1 });
  });
});
