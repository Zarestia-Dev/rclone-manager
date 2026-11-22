import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_STATUS, JobInfo, QuickRun, QuickRunInput } from '@app/types';
import { WizardService } from './wizard.service';
import { QuickRunService } from './quick-run.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { RemoteManagementService } from '../remote/remote-management.service';
import { RemoteDiskUsageService } from '../remote/remote-disk-usage.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { RemotePresetsService } from '../remote/remote-presets';
import { SystemInfoService } from '../infrastructure/system/system-info.service';
import { SystemHealthService } from '../infrastructure/maintenance/system-health.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { PathService } from '../infrastructure/platform/path.service';
import { PathInspectionService } from '../infrastructure/platform/path-inspection.service';
import { FileSystemService } from '../operations/file-system.service';
import { WindowsMountTargetService } from '../operations/windows-mount-target.service';
import { JobManagementService } from '../operations/job-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { resolvePlan } from 'src/app/shared/utils/wizard.util';

const input = (rclone: Record<string, unknown> = {}): QuickRunInput => ({
  name: 'Drive backup',
  operationType: 'copy',
  remoteName: 'drive',
  config: { app: { watchEnabled: true }, rclone: { srcFs: '/a', dstFs: 'drive:a', ...rclone } },
});

const job = (status: JobInfo['status'], stats: Partial<JobInfo['stats']> = {}): JobInfo =>
  ({
    jobid: 7,
    execute_id: 'exec-1',
    remote_name: 'drive',
    status,
    stats: { transfers: 0, bytes: 0, deletes: 0, errors: 0, lastError: '', ...stats },
  }) as unknown as JobInfo;

describe('WizardService', () => {
  let service: WizardService;
  const jobs = signal<JobInfo[]>([]);
  const save = vi.fn();
  const start = vi.fn();
  const remove = vi.fn();
  const stop = vi.fn();
  const facadeStart = vi.fn();
  const facadeStop = vi.fn();
  const refresh = vi.fn();
  const mountedRemotes = signal<{ starter?: unknown }[]>([]);
  const runningServes = signal<{ starter?: unknown }[]>([]);
  const quickRunList = signal<{ id: string }[]>([]);
  const unmountRemote = vi.fn();
  const stopServe = vi.fn();
  const mountsOf = vi.fn();
  const servesOf = vi.fn();
  const stopJob = vi.fn();
  const getJobReport = vi.fn();
  const openInFiles = vi.fn();
  const canSelectDriveLetter = vi.fn();
  const selectFolder = vi.fn();
  const defaultDriveLetter = vi.fn();
  const resolveDefaultPath = vi.fn();
  const saveSetting = vi.fn();
  const getSettingValue = vi.fn();
  const getLocalDiskUsage = vi.fn();
  const getLocalAddresses = vi.fn();
  const getRemoteSettings = vi.fn();
  const remoteSettings = vi.fn();
  const saveRemoteSettings = vi.fn();
  const startProfileBatch = vi.fn();
  const mountRemoteProfile = vi.fn();
  const startServeProfile = vi.fn();
  const invoke = vi.fn();
  const isLocalBackend = signal(true);
  const backends = signal<{ name: string; host: string }[]>([]);
  const activeBackend = signal('Local');
  const getDiskUsage = vi.fn();
  const getRemotePaths = vi.fn();
  const getAllRemoteConfigs = vi.fn();
  const getLocalDrives = vi.fn();
  const createDirs = vi.fn();
  const mountPluginInstalled = signal<boolean | null>(true);
  const skipMountPluginCheck = signal(false);

  beforeEach(() => {
    TestBed.resetTestingModule();
    jobs.set([]);
    isLocalBackend.set(true);
    backends.set([]);
    activeBackend.set('Local');
    for (const fn of [
      save,
      start,
      remove,
      stop,
      facadeStart,
      facadeStop,
      unmountRemote,
      stopServe,
      stopJob,
      saveSetting,
      getSettingValue,
      getLocalDiskUsage,
      saveRemoteSettings,
      startProfileBatch,
      mountRemoteProfile,
      startServeProfile,
    ]) {
      fn.mockReset();
    }
    getRemoteSettings.mockReset().mockResolvedValue({});
    remoteSettings.mockReset().mockReturnValue({});
    getDiskUsage.mockRejectedValue(new Error('about unavailable'));
    getRemotePaths.mockReset();
    getAllRemoteConfigs.mockReset().mockResolvedValue({ drive: { type: 'drive' }, box: {} });
    getLocalDrives.mockReset().mockResolvedValue([
      { name: '/', label: 'nautilus.titles.fileSystem' },
      { name: '/home/me', label: 'titlebar.home' },
    ]);
    createDirs.mockReset().mockResolvedValue(undefined);
    saveSetting.mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);
    stop.mockResolvedValue(undefined);
    quickRunList.set([]);
    mountedRemotes.set([]);
    runningServes.set([]);
    refresh.mockReset().mockResolvedValue(undefined);
    mountsOf.mockReset().mockReturnValue([]);
    servesOf.mockReset().mockReturnValue([]);
    mountPluginInstalled.set(true);
    skipMountPluginCheck.set(false);

    TestBed.configureTestingModule({
      providers: [
        WizardService,
        { provide: ApiClientService, useValue: { invoke } },
        {
          provide: RemoteFacadeService,
          useValue: { startJob: facadeStart, stopJob: facadeStop, remoteSettings },
        },
        { provide: NotificationService, useValue: { showError: vi.fn() } },
        { provide: TranslateService, useValue: { instant: (k: string): string => k } },
        { provide: BackendTranslationService, useValue: {} },
        {
          provide: QuickRunService,
          useValue: { save, start, remove, stop, refresh, quickRuns: quickRunList },
        },
        {
          provide: JobManagementService,
          useValue: { jobs, stopJob, getJobReport, startProfileBatch },
        },
        { provide: RemoteManagementService, useValue: { getAllRemoteConfigs, getLocalDrives } },
        { provide: RemoteDiskUsageService, useValue: { load: vi.fn() } },
        {
          provide: RemoteFileOperationsService,
          useValue: { getRemotePaths, getSize: vi.fn(), getDiskUsage },
        },
        { provide: RemotePresetsService, useValue: { resolvePresets: vi.fn(() => ({})) } },
        { provide: SystemInfoService, useValue: { getLocalDiskUsage, getLocalAddresses } },
        {
          provide: SystemHealthService,
          useValue: {
            mountPluginInstalled,
            mountPluginMissing: computed(() => mountPluginInstalled() === false),
            skipMountPluginCheck,
            showRepairSheet: vi.fn(),
          },
        },
        { provide: BackendService, useValue: { isLocalBackend, backends, activeBackend } },
        {
          provide: AppSettingsService,
          useValue: {
            getSettingValue,
            saveSetting,
            getRemoteSettings,
            saveRemoteSettings,
          },
        },
        {
          provide: MountManagementService,
          useValue: {
            mountRemoteProfile,
            unmountRemote,
            getMountsForRemoteProfile: mountsOf,
            mountedRemotes,
          },
        },
        {
          provide: ServeManagementService,
          useValue: {
            startServeProfile,
            stopServe,
            getServesForRemoteProfile: servesOf,
            runningServes,
          },
        },
        {
          provide: PathService,
          useValue: {
            getParentPath: (p: string): string => p.slice(0, p.lastIndexOf('/')),
            splitLocalForStat: (p: string): { root: string; relative: string } => ({
              root: '/',
              relative: p.slice(1),
            }),
          },
        },
        {
          provide: PathInspectionService,
          useValue: { createRequiredDirectoriesForOperation: createDirs, resolveDefaultPath },
        },
        {
          provide: FileSystemService,
          useValue: { openInFiles, canSelectDriveLetter, selectFolder },
        },
        { provide: WindowsMountTargetService, useValue: { defaultDriveLetter } },
      ],
    });
    service = TestBed.inject(WizardService);
  });

  describe('loadEnvironment', () => {
    it('lists remotes with their types and finds the home folder', async () => {
      getSettingValue.mockResolvedValue(false);
      getLocalDiskUsage.mockResolvedValue({ free: 500, total: 1000, used: 500 });
      const env = await service.loadEnvironment();
      expect(env.remotes).toEqual([
        { name: 'drive', type: 'drive' },
        { name: 'box', type: '' },
      ]);
      expect(env.home).toBe('/home/me');
      // The drive list reports 0 for a folder that is not a mount point; rclone's answer wins.
      expect(env.homeFree).toBe(500);
      expect(getLocalDiskUsage).toHaveBeenCalledWith('/home/me');
      expect(env.canStartOnLogin).toBe(true);
      expect(env.startsOnLogin).toBe(false);
    });

    it('leaves the free space unknown when rclone cannot measure it', async () => {
      getSettingValue.mockResolvedValue(false);
      getLocalDiskUsage.mockRejectedValue(new Error('no du'));
      expect((await service.loadEnvironment()).homeFree).toBeUndefined();
    });

    it('treats a build without the setting as unable to start on login', async () => {
      getSettingValue.mockResolvedValue(undefined);
      expect((await service.loadEnvironment()).canStartOnLogin).toBe(false);
    });

    it('survives unknown drives', async () => {
      getLocalDrives.mockRejectedValue(new Error('no drives'));
      expect((await service.loadEnvironment()).home).toBeUndefined();
    });
  });

  describe('mount plugin', () => {
    it('is missing only once the check found it missing, not while it is unknown', () => {
      expect(service.mountPluginMissing()).toBe(false);
      mountPluginInstalled.set(null);
      expect(service.mountPluginMissing()).toBe(false);
      mountPluginInstalled.set(false);
      expect(service.mountPluginMissing()).toBe(true);
    });

    it('stops being missing when the plugin gets installed, without reloading the environment', () => {
      mountPluginInstalled.set(false);
      expect(service.mountPluginMissing()).toBe(true);
      mountPluginInstalled.set(true);
      expect(service.mountPluginMissing()).toBe(false);
    });

    it('is flagged as skipped when the check is turned off, and still missing', () => {
      mountPluginInstalled.set(false);
      skipMountPluginCheck.set(true);
      expect(service.mountPluginMissing()).toBe(true);
      expect(service.mountPluginCheckSkipped()).toBe(true);
    });
  });

  it('reads the free space like the file manager does, from rclone about', async () => {
    getDiskUsage.mockResolvedValue({ total: 100, used: 40, free: 60 });
    expect(await service.localFree('/home/me/Docs')).toBe(60);
    expect(getDiskUsage).toHaveBeenCalledWith('/', 'home/me/Docs', 'quickrun');
    expect(getLocalDiskUsage).not.toHaveBeenCalled();
  });

  it('falls back to core/du when about fails', async () => {
    getLocalDiskUsage.mockResolvedValue({ free: 7, total: 10, used: 3 });
    expect(await service.localFree('/home/me')).toBe(7);
  });

  it('ignores an answer without a number', async () => {
    getDiskUsage.mockResolvedValue({});
    getLocalDiskUsage.mockResolvedValue({});
    expect(await service.localFree('/home/me')).toBeUndefined();
  });

  it('walks up to the closest folder that exists to read the free space', async () => {
    getLocalDiskUsage.mockImplementation(async (dir: string) => {
      if (dir === '/home/me') return { free: 42, total: 100, used: 58 };
      throw new Error('missing');
    });
    expect(await service.localFree('/home/me/New/Folder')).toBe(42);
    getLocalDiskUsage.mockRejectedValue(new Error('missing'));
    expect(await service.localFree('/x')).toBeUndefined();
  });

  it('lists visible folders only, sorted, and an empty list on errors', async () => {
    getRemotePaths.mockResolvedValue({
      list: [
        { Name: 'b', IsDir: true },
        { Name: '.hidden', IsDir: true },
        { Name: 'file.txt', IsDir: false },
        { Name: 'a', IsDir: true },
      ],
    });
    expect(await service.localFolders('/home/me')).toEqual(['a', 'b']);
    expect(getRemotePaths).toHaveBeenCalledWith(
      '/',
      'home/me',
      { noModTime: true, noMimeType: true, dirsOnly: true },
      'quickrun'
    );
    getRemotePaths.mockRejectedValue(new Error('offline'));
    expect(await service.localFolders('/home/me')).toEqual([]);
  });

  describe('preview', () => {
    it('runs a hidden dry run, lists its files and removes it', async () => {
      save.mockResolvedValue({ id: 'tmp' });
      start.mockResolvedValue({ executeId: 'exec-1' });
      jobs.set([job(JOB_STATUS.Completed, { transfers: 4, bytes: 1024, deletes: 2 })]);
      getJobReport.mockResolvedValue({ combined: ['+ new.txt', '- gone.txt', '= same.txt'] });
      const onStarted = vi.fn();

      const result = await service.preview(
        { ...input(), operationType: 'sync' },
        'Drive backup (test)',
        onStarted
      );

      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Drive backup (test)',
          config: {
            app: { showOnTray: false },
            rclone: expect.objectContaining({ dryRun: true, combined: true }),
          },
        })
      );
      expect(onStarted).toHaveBeenCalledWith('exec-1');
      expect(getJobReport).toHaveBeenCalledWith(7);
      expect(result?.counts).toEqual({ transfers: 4, bytes: 1024, deletes: 2, errors: 0 });
      expect(result?.matched).toBe(1);
      expect(result?.groups.map(g => [g.kind, g.files.map(f => f.path)])).toEqual([
        ['delete', ['gone.txt']],
        ['add', ['new.txt']],
      ]);
      expect(remove).toHaveBeenCalledWith('tmp');
    });

    it('reads no report for an operation that keeps none and survives a missing one', async () => {
      save.mockResolvedValue({ id: 'tmp' });
      start.mockResolvedValue({ executeId: 'exec-1' });
      jobs.set([job(JOB_STATUS.Completed, { transfers: 2 })]);

      const bisync = await service.preview({ ...input(), operationType: 'bisync' }, 'p');
      expect(getJobReport).not.toHaveBeenCalled();
      expect(bisync?.fileLevel).toBe(false);

      getJobReport.mockRejectedValue(new Error('gone'));
      const copy = await service.preview({ ...input(), operationType: 'copy' }, 'p');
      expect(copy?.counts.transfers).toBe(2);
    });

    it('waits for the job to stop running', async () => {
      save.mockResolvedValue({ id: 'tmp' });
      start.mockResolvedValue({ executeId: 'exec-1' });
      jobs.set([job(JOB_STATUS.Running)]);
      const pending = service.preview(input(), 'p');
      await Promise.resolve();
      TestBed.tick();
      jobs.set([job(JOB_STATUS.Completed, { transfers: 1 })]);
      TestBed.tick();
      expect((await pending)?.counts.transfers).toBe(1);
    });

    it('removes the dry run when it fails', async () => {
      save.mockResolvedValue({ id: 'tmp' });
      start.mockResolvedValue({ executeId: 'exec-1' });
      jobs.set([job(JOB_STATUS.Failed, { lastError: 'denied' })]);
      await expect(service.preview(input(), 'p')).rejects.toThrow('denied');
      expect(remove).toHaveBeenCalledWith('tmp');
    });

    it('fails and removes the dry run when its job leaves the list before it stopped', async () => {
      save.mockResolvedValue({ id: 'tmp' });
      start.mockResolvedValue({ executeId: 'exec-1' });
      jobs.set([job(JOB_STATUS.Running)]);
      const pending = service.preview(input(), 'p');
      const outcome = expect(pending).rejects.toThrow('left the list');
      // Let it save, start and begin to watch the list before the job is seen and then lost.
      await new Promise(resolve => setTimeout(resolve));
      TestBed.tick();
      await new Promise(resolve => setTimeout(resolve));
      jobs.set([]);
      TestBed.tick();
      await outcome;
      expect(remove).toHaveBeenCalledWith('tmp');
    });

    it('fails and removes the dry run when its job never shows up', async () => {
      vi.useFakeTimers();
      try {
        save.mockResolvedValue({ id: 'tmp' });
        start.mockResolvedValue({ executeId: 'exec-1' });
        jobs.set([]);
        const outcome = expect(service.preview(input(), 'p')).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(31_000);
        await outcome;
        expect(remove).toHaveBeenCalledWith('tmp');
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives up quietly when it cannot be saved or started', async () => {
      save.mockResolvedValue(null);
      expect(await service.preview(input(), 'p')).toBeNull();
      save.mockResolvedValue({ id: 'tmp' });
      start.mockResolvedValue(null);
      expect(await service.preview(input(), 'p')).toBeNull();
      expect(remove).toHaveBeenCalledWith('tmp');
    });
  });

  describe('apply', () => {
    const saved = (rclone: Record<string, unknown>): QuickRun =>
      ({ ...input(rclone), id: 'qr-1' }) as QuickRun;

    it('saves and starts a one-way operation without waiting', async () => {
      const plan = resolvePlan('backup', { deleted: 'keep' });
      if (!plan) throw new Error('no plan');
      save.mockResolvedValue(saved({}));
      start.mockResolvedValue({ executeId: 'exec-1' });

      const result = await service.apply(input(), plan);

      expect(createDirs).toHaveBeenCalledWith('copy', expect.any(Object));
      expect(result?.quickRun?.id).toBe('qr-1');
      expect(result).toMatchObject({ destination: 'quick_run', name: 'Drive backup' });
      expect(save).toHaveBeenCalledTimes(1);
      expect(saveSetting).not.toHaveBeenCalled();
    });

    it('drops resync after a successful first two-way run', async () => {
      const plan = resolvePlan('devices', {});
      if (!plan) throw new Error('no plan');
      save.mockResolvedValueOnce(saved({ resync: true })).mockResolvedValueOnce(saved({}));
      start.mockResolvedValue({ executeId: 'exec-1' });
      jobs.set([job(JOB_STATUS.Completed)]);

      const result = await service.apply(input({ resync: true }), plan);

      expect(result?.firstRunDone).toBe(true);
      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: 'qr-1',
          config: expect.objectContaining({
            rclone: expect.not.objectContaining({ resync: true }),
          }),
        })
      );
    });

    it('keeps resync when the first two-way run failed', async () => {
      const plan = resolvePlan('devices', {});
      if (!plan) throw new Error('no plan');
      save.mockResolvedValue(saved({ resync: true }));
      start.mockResolvedValue({ executeId: 'exec-1' });
      jobs.set([job(JOB_STATUS.Failed)]);

      const result = await service.apply(input({ resync: true }), plan);

      expect(result?.firstRunDone).toBe(false);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('keeps resync when the job of the first two-way run is lost', async () => {
      vi.useFakeTimers();
      try {
        const plan = resolvePlan('devices', {});
        if (!plan) throw new Error('no plan');
        save.mockResolvedValue(saved({ resync: true }));
        start.mockResolvedValue({ executeId: 'exec-1' });
        jobs.set([]);

        const pending = service.apply(input({ resync: true }), plan);
        await vi.advanceTimersByTimeAsync(31_000);
        const result = await pending;

        expect(result?.firstRunDone).toBe(false);
        expect(save).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('turns on start with the system when asked', async () => {
      const plan = resolvePlan('access', {});
      if (!plan) throw new Error('no plan');
      save.mockResolvedValue(saved({}));
      start.mockResolvedValue({ executeId: 'exec-1', mountPoint: '/home/me/drive' });

      await service.apply(input(), plan, { startOnLogin: true });

      expect(saveSetting).toHaveBeenCalledWith('general', 'start_on_startup', true);
    });

    it('returns null when the Quick Run cannot be saved', async () => {
      const plan = resolvePlan('download', {});
      if (!plan) throw new Error('no plan');
      save.mockResolvedValue(null);
      expect(await service.apply(input(), plan)).toBeNull();
      expect(start).not.toHaveBeenCalled();
    });
    describe('as a profile of the remote', () => {
      const profileJob = (status: JobInfo['status'], name = 'Drive backup'): JobInfo =>
        ({ ...job(status), starter: { kind: 'profile', name } }) as JobInfo;

      it('saves a profile next to the existing ones and starts it', async () => {
        const plan = resolvePlan('backup', { deleted: 'keep' });
        if (!plan) throw new Error('no plan');
        getRemoteSettings.mockResolvedValue({
          drive: { copyConfigs: { Default: { rclone: { srcFs: '/x' } } } },
        });
        jobs.set([profileJob(JOB_STATUS.Running)]);
        const started = vi.fn();

        const result = await service.apply(input(), plan, {
          destination: 'profile',
          onStarted: started,
        });

        expect(save).not.toHaveBeenCalled();
        expect(saveRemoteSettings).toHaveBeenCalledWith('drive', {
          copyConfigs: {
            Default: { rclone: { srcFs: '/x' } },
            'Drive backup': {
              app: { watchEnabled: true },
              rclone: { srcFs: '/a', dstFs: 'drive:a' },
            },
          },
        });
        expect(startProfileBatch).toHaveBeenCalledWith('Copy', {
          remoteName: 'drive',
          profileName: 'Drive backup',
          source: 'dashboard',
        });
        expect(started).toHaveBeenCalledWith('exec-1');
        expect(result).toEqual({
          destination: 'profile',
          name: 'Drive backup',
          execution: { executeId: 'exec-1' },
        });
      });

      it('never replaces a profile that has the name', async () => {
        const plan = resolvePlan('backup', { deleted: 'keep' });
        if (!plan) throw new Error('no plan');
        getRemoteSettings.mockResolvedValue({
          drive: { copyConfigs: { 'Drive backup': { rclone: {} } } },
        });
        jobs.set([profileJob(JOB_STATUS.Running, 'Drive backup-2')]);

        const result = await service.apply(input(), plan, { destination: 'profile' });

        expect(result?.name).toBe('Drive backup-2');
        const saved = saveRemoteSettings.mock.calls[0][1].copyConfigs;
        expect(Object.keys(saved)).toEqual(['Drive backup', 'Drive backup-2']);
      });

      it('mounts the profile and keeps the VFS options in a VFS profile', async () => {
        const plan = resolvePlan('access', {});
        if (!plan) throw new Error('no plan');
        const mount: QuickRunInput = {
          name: 'Drive mount',
          operationType: 'mount',
          remoteName: 'drive',
          config: {
            app: { showOnTray: true },
            rclone: { fs: 'drive:', mountPoint: '/m', vfs: { vfs_cache_mode: 'full' } },
          },
        };

        const result = await service.apply(mount, plan, { destination: 'profile' });

        expect(saveRemoteSettings).toHaveBeenCalledWith('drive', {
          vfsConfigs: { 'Drive mount': { vfs_cache_mode: 'full' } },
          mountConfigs: {
            'Drive mount': {
              app: { vfsProfile: 'Drive mount' },
              rclone: { fs: 'drive:', mountPoint: '/m' },
            },
          },
        });
        expect(mountRemoteProfile).toHaveBeenCalledWith('drive', 'Drive mount', 'dashboard');
        expect(result).toMatchObject({ destination: 'profile', execution: {} });
      });

      it('reports the address a served profile listens on', async () => {
        const plan = resolvePlan('share', { device: 'folder' });
        if (!plan) throw new Error('no plan');
        startServeProfile.mockResolvedValue({ id: 'webdav-1', addr: '[::]:8082' });
        const serve: QuickRunInput = {
          name: 'Drive sharing',
          operationType: 'serve',
          remoteName: 'drive',
          config: { app: {}, rclone: { fs: 'drive:', type: 'webdav', addr: ':8082' } },
        };

        const result = await service.apply(serve, plan, { destination: 'profile' });

        expect(startServeProfile).toHaveBeenCalledWith('drive', 'Drive sharing');
        expect(result?.execution).toEqual({ serveAddr: '[::]:8082' });
      });

      it('drops resync from the profile after a successful first two-way run', async () => {
        const plan = resolvePlan('devices', {});
        if (!plan) throw new Error('no plan');
        const bisync: QuickRunInput = {
          name: 'Drive sync',
          operationType: 'bisync',
          remoteName: 'drive',
          config: { app: {}, rclone: { path1: '/a', path2: 'drive:a', resync: true } },
        };
        jobs.set([profileJob(JOB_STATUS.Completed, 'Drive sync')]);
        getRemoteSettings
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ drive: { bisyncConfigs: { 'Drive sync': bisync.config } } });

        const result = await service.apply(bisync, plan, { destination: 'profile' });

        expect(result?.firstRunDone).toBe(true);
        expect(saveRemoteSettings).toHaveBeenLastCalledWith('drive', {
          bisyncConfigs: {
            'Drive sync': { app: {}, rclone: { path1: '/a', path2: 'drive:a' } },
          },
        });
      });

      it('turns on start with the system for a profile too', async () => {
        const plan = resolvePlan('backup', { deleted: 'keep' });
        if (!plan) throw new Error('no plan');
        jobs.set([profileJob(JOB_STATUS.Running)]);
        await service.apply(input(), plan, { destination: 'profile', startOnLogin: true });
        expect(saveSetting).toHaveBeenCalledWith('general', 'start_on_startup', true);
      });
    });
  });

  describe('settings', () => {
    const answer = (values: Record<string, unknown>): void => {
      getSettingValue.mockImplementation(async (key: string) => values[key]);
    };

    it('follows the startup view when the destination is automatic', async () => {
      answer({ 'wizard.destination': 'auto', 'general.default_view': 'flow' });
      expect(await service.settings()).toEqual({
        afterRemote: true,
        setting: 'auto',
        destination: 'quick_run',
      });
      answer({ 'wizard.destination': 'auto', 'general.default_view': 'main_menu' });
      expect((await service.settings()).destination).toBe('profile');
    });

    it('uses the destination the setting names and reads whether the wizard follows a new cloud', async () => {
      answer({
        'wizard.after_remote': false,
        'wizard.destination': 'quick_run',
        'general.default_view': 'main_menu',
      });
      expect(await service.settings()).toEqual({
        afterRemote: false,
        setting: 'quick_run',
        destination: 'quick_run',
      });
    });

    it('falls back to the defaults when the settings cannot be read', async () => {
      getSettingValue.mockRejectedValue(new Error('no settings'));
      expect(await service.settings()).toEqual({
        afterRemote: true,
        setting: 'auto',
        destination: 'profile',
      });
    });

    it('saves each choice in the wizard category and resolves automatic', async () => {
      await service.saveAfterRemote(false);
      await service.saveDestination('profile');
      expect(saveSetting).toHaveBeenCalledWith('wizard', 'after_remote', false);
      expect(saveSetting).toHaveBeenCalledWith('wizard', 'destination', 'profile');

      getSettingValue.mockResolvedValue('nautilus');
      expect(await service.resolveDestination('auto')).toBe('quick_run');
      expect(await service.resolveDestination('profile')).toBe('profile');
    });
  });

  it('opens a folder through the file system service the whole app uses', async () => {
    openInFiles.mockResolvedValue(undefined);
    await service.openFolder('/home/me/drive');
    expect(openInFiles).toHaveBeenCalledWith('/home/me/drive');
  });

  describe('where a mount goes by default', () => {
    beforeEach(() => {
      defaultDriveLetter.mockReset().mockResolvedValue(null);
      resolveDefaultPath.mockReset().mockResolvedValue('/home/me/drive');
    });

    it('is a free drive letter on Windows', async () => {
      defaultDriveLetter.mockResolvedValue('Z:');
      expect(await service.defaultLocalPath('drive', 'mount')).toBe('Z:');
      expect(defaultDriveLetter).toHaveBeenCalledWith('drive');
      expect(resolveDefaultPath).not.toHaveBeenCalled();
    });

    it('is the folder of the settings where no letter can be chosen or none is left', async () => {
      expect(await service.defaultLocalPath('drive', 'mount')).toBe('/home/me/drive');
      expect(resolveDefaultPath).toHaveBeenCalledWith('drive', 'mount');
    });

    it('is always a folder for a two-way copy', async () => {
      defaultDriveLetter.mockResolvedValue('Z:');
      expect(await service.defaultLocalPath('drive', 'bisync')).toBe('/home/me/drive');
      expect(defaultDriveLetter).not.toHaveBeenCalled();
    });

    it('is empty when nothing can be worked out', async () => {
      resolveDefaultPath.mockRejectedValue(new Error('offline'));
      expect(await service.defaultLocalPath('drive', 'mount')).toBe('');
    });
  });

  describe('the profile it would save', () => {
    it('is planned against the profiles the remote has, so its name is free, and saves nothing', async () => {
      getRemoteSettings.mockResolvedValue({
        drive: { copyConfigs: { 'Drive backup': { app: {}, rclone: {} } } },
      });
      const input = {
        name: 'Drive backup',
        operationType: 'copy',
        remoteName: 'drive',
        config: { app: {}, rclone: { srcFs: '/a', dstFs: 'drive:a' } },
      } as never;
      const plan = await service.planProfile(input);
      expect(plan?.name).toBe('Drive backup-2');
      expect(Object.keys(plan?.settings['copyConfigs'] ?? {})).toEqual([
        'Drive backup',
        'Drive backup-2',
      ]);
      expect(saveRemoteSettings).not.toHaveBeenCalled();
    });

    it('is nothing for an operation without profiles', async () => {
      getRemoteSettings.mockResolvedValue({});
      expect(
        await service.planProfile({
          name: 'n',
          operationType: 'nothing',
          remoteName: 'drive',
          config: { app: {}, rclone: {} },
        } as never)
      ).toBeNull();
    });
  });

  it('says whether a mount can go to a drive letter', async () => {
    getSettingValue.mockResolvedValue(false);
    canSelectDriveLetter.mockReturnValue(true);
    expect((await service.loadEnvironment()).canUseDriveLetter).toBe(true);
    canSelectDriveLetter.mockReturnValue(false);
    expect((await service.loadEnvironment()).canUseDriveLetter).toBe(false);
  });

  describe('ports', () => {
    it('asks the backend whether a port is free', async () => {
      invoke.mockResolvedValue(false);
      expect(await service.portFree(8080)).toBe(false);
      expect(invoke).toHaveBeenCalledWith('check_port_available', { port: 8080 });
      invoke.mockResolvedValue(true);
      expect(await service.portFree(8081)).toBe(true);
    });

    it('does not know when the backend has no such check or rclone runs elsewhere', async () => {
      invoke.mockRejectedValue(new Error('unknown command'));
      expect(await service.portFree(8080)).toBeNull();
      expect(await service.nextFreePort(8080)).toBeNull();
      isLocalBackend.set(false);
      invoke.mockClear();
      expect(await service.portFree(8080)).toBeNull();
      expect(await service.nextFreePort(8080)).toBeNull();
      expect(invoke).not.toHaveBeenCalled();
    });

    it('finds the next free port', async () => {
      invoke.mockResolvedValue(8082);
      expect(await service.nextFreePort(8081)).toBe(8082);
      expect(invoke).toHaveBeenCalledWith('find_available_port', { startPort: 8081 });
    });
  });

  describe('network', () => {
    it('gives the host name and addresses of this machine', async () => {
      getLocalAddresses.mockResolvedValue({ hostName: 'my-pc', addresses: ['192.168.1.20'] });
      expect(await service.network()).toEqual({ hostName: 'my-pc', addresses: ['192.168.1.20'] });
    });

    it('gives the address the app connects to for a remote backend, not this machine’s', async () => {
      isLocalBackend.set(false);
      activeBackend.set('NAS');
      backends.set([
        { name: 'Local', host: 'localhost' },
        { name: 'NAS', host: '192.168.1.50' },
      ]);
      expect(await service.network()).toEqual({ addresses: ['192.168.1.50'], viaBackend: true });
      expect(getLocalAddresses).not.toHaveBeenCalled();
    });

    it('gives nothing for a remote backend reached through localhost', async () => {
      isLocalBackend.set(false);
      activeBackend.set('Tunnel');
      backends.set([{ name: 'Tunnel', host: 'localhost' }]);
      expect(await service.network()).toBeNull();
      expect(getLocalAddresses).not.toHaveBeenCalled();
    });

    it('gives nothing for a remote backend that is not in the list', async () => {
      isLocalBackend.set(false);
      expect(await service.network()).toBeNull();
    });

    it('gives nothing when the addresses cannot be read', async () => {
      getLocalAddresses.mockRejectedValue(new Error('unsupported'));
      expect(await service.network()).toBeNull();
    });
  });

  describe('undo', () => {
    const quickRun = { id: 'qr-1', name: 'Drive backup' } as QuickRun;

    it('stops a Quick Run and deletes it', async () => {
      quickRunList.set([{ id: 'qr-1' }]);
      remove.mockImplementation(async () => quickRunList.set([]));
      await service.undo(
        { destination: 'quick_run', name: quickRun.name, quickRun, execution: null },
        'drive',
        'copy'
      );
      expect(stop).toHaveBeenCalledWith('qr-1');
      expect(remove).toHaveBeenCalledWith('qr-1');
    });

    it('fails when the Quick Run is still there afterwards', async () => {
      quickRunList.set([{ id: 'qr-1' }]);
      await expect(
        service.undo(
          { destination: 'quick_run', name: quickRun.name, quickRun, execution: null },
          'drive',
          'copy'
        )
      ).rejects.toThrow();
    });

    it('stops what runs from a profile and deletes only that profile', async () => {
      getRemoteSettings.mockResolvedValue({
        drive: {
          mountConfigs: {
            Default: { rclone: { mountPoint: '/m' } },
            'Drive folder': { rclone: { mountPoint: '/x' } },
          },
        },
      });
      mountsOf.mockReturnValue([{ mount_point: '/x' }]);
      servesOf.mockReturnValue([{ id: 'serve-1' }]);
      jobs.set([job(JOB_STATUS.Running)]);

      await service.undo(
        { destination: 'profile', name: 'Drive folder', execution: { executeId: 'exec-1' } },
        'drive',
        'mount'
      );

      expect(mountsOf).toHaveBeenCalledWith('drive', 'Drive folder');
      expect(unmountRemote).toHaveBeenCalledWith('/x', 'drive');
      expect(stopServe).toHaveBeenCalledWith('serve-1', 'drive');
      expect(stopJob).toHaveBeenCalledWith(7, 'drive');
      expect(saveRemoteSettings).toHaveBeenCalledWith('drive', {
        mountConfigs: { Default: { rclone: { mountPoint: '/m' } } },
      });
    });

    it('copes with a remote that has no profiles of that kind', async () => {
      await service.undo(
        { destination: 'profile', name: 'Drive folder', execution: {} },
        'drive',
        'copy'
      );
      expect(saveRemoteSettings).toHaveBeenCalledWith('drive', { copyConfigs: {} });
    });
  });

  describe('setups', () => {
    const qr = (id: string, rclone: Record<string, unknown>, op = 'copy'): unknown => ({
      id,
      name: `Setup ${id}`,
      operationType: op,
      remoteName: 'drive',
      config: { app: {}, rclone },
    });

    it('lists the Quick Runs and profiles it can describe', async () => {
      quickRunList.set([
        qr('a', { srcFs: '/home/me/Docs', dstFs: 'drive:Docs' }),
        qr('b', { srcFs: '/one', dstFs: '/two' }, 'sync'),
        qr('c', { srcFs: 'drive:x', dstFs: '/local' }, 'sync'),
      ] as never);
      remoteSettings.mockReturnValue({
        drive: {
          mountConfigs: {
            Folder: { rclone: { fs: 'drive:', mountPoint: '/mnt/drive' } },
            Empty: { rclone: {} },
          },
          copyConfigs: { Default: {} },
        },
      });

      const setups = await service.loadSetups(['drive', 'box']);

      expect(refresh).toHaveBeenCalled();
      expect(setups.map(s => s.key)).toEqual([
        'quick_run:a',
        'quick_run:c',
        'profile:drive:mount:Folder',
      ]);
    });
  });

  it('stops only a running job', async () => {
    jobs.set([job(JOB_STATUS.Running)]);
    await service.cancel('exec-1');
    expect(stopJob).toHaveBeenCalledWith(7, 'drive');
    stopJob.mockReset();
    jobs.set([job(JOB_STATUS.Completed)]);
    await service.cancel('exec-1');
    expect(stopJob).not.toHaveBeenCalled();
  });
});
