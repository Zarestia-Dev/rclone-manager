import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentGuideModalComponent } from './intent-guide-modal.component';
import { NavigationDispatcherService } from 'src/app/services/ui/navigation-dispatcher.service';
import { GuideEnvironment, IntentGuideService } from 'src/app/services/flow/intent-guide.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { NotificationService } from 'src/app/services/ui/notification.service';

const ENV: GuideEnvironment = {
  remotes: [
    { name: 'drive', type: 'drive' },
    { name: 'onedrive', type: 'onedrive' },
  ],
  home: '/home/me',
  homeFree: 60,
  isServer: false,
  isAndroid: false,
  mountPluginMissing: false,
  canStartOnLogin: true,
  startsOnLogin: false,
};

describe('IntentGuideModalComponent', () => {
  const close = vi.fn();
  const guide = {
    loadEnvironment: vi.fn(),
    cloudUsage: vi.fn(),
    localFree: vi.fn(),
    folderSize: vi.fn(),
    localFolders: vi.fn(),
    defaultLocalPath: vi.fn(),
    presets: vi.fn(),
    network: vi.fn(),
    settings: vi.fn(),
    resolveDestination: vi.fn(),
    saveAfterRemote: vi.fn(),
    saveDestination: vi.fn(),
    portFree: vi.fn(),
    nextFreePort: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
    cancel: vi.fn(),
    job: vi.fn(),
    openFolder: vi.fn(),
    installMountPlugin: vi.fn(),
    undo: vi.fn(),
    startSetup: vi.fn(),
    stopSetup: vi.fn(),
    loadSetups: vi.fn(),
    setupStatus: vi.fn(),
  };
  const openRemoteInFiles = vi.fn();
  const openQuickRunEditor = vi.fn();
  const openQuickAddRemote = vi.fn();
  const confirmModal = vi.fn();
  const navigateToRemote = vi.fn();
  const navigateToQuickRun = vi.fn();

  const create = async (data: unknown = null): Promise<IntentGuideModalComponent> => {
    TestBed.configureTestingModule({
      providers: [
        { provide: MatDialogRef, useValue: { close } },
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: IntentGuideService, useValue: guide },
        { provide: RemoteFacadeService, useValue: { openRemoteInFiles } },
        {
          provide: NavigationDispatcherService,
          useValue: { navigateToRemote, navigateToQuickRun },
        },
        {
          provide: QuickRunService,
          useValue: { generateUniqueQuickRunName: (base: string): string => base },
        },
        { provide: ModalService, useValue: { openQuickRunEditor, openQuickAddRemote } },
        { provide: IconService, useValue: { getIconName: (n: string): string => n } },
        { provide: NotificationService, useValue: { showError: vi.fn(), confirmModal } },
        {
          provide: TranslateService,
          useValue: {
            currentLang: (): string => 'en',
            instant: (key: string, params?: Record<string, unknown>): string =>
              params ? `${key}:${JSON.stringify(params)}` : key,
          },
        },
      ],
    });
    const component = TestBed.runInInjectionContext(() => new IntentGuideModalComponent());
    await component.load();
    return component;
  };

  /** From the folders to the review, through the schedule step when there is one. */
  const toReview = (component: IntentGuideModalComponent): void => {
    component.afterWhere();
    if (component.step() === 'when') component.toReview();
  };

  /** Lets the fire-and-forget measurements and folder loads settle. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    close.mockReset();
    openRemoteInFiles.mockReset();
    openQuickRunEditor.mockReset();
    openQuickAddRemote.mockReset();
    confirmModal.mockReset().mockResolvedValue(true);
    navigateToRemote.mockReset();
    navigateToQuickRun.mockReset();
    for (const fn of Object.values(guide)) fn.mockReset();
    guide.loadEnvironment.mockResolvedValue(ENV);
    guide.loadSetups.mockResolvedValue([]);
    guide.setupStatus.mockReturnValue({ state: 'idle' });
    guide.cloudUsage.mockResolvedValue({ used: 180, free: 20 });
    guide.localFree.mockResolvedValue(60);
    guide.folderSize.mockResolvedValue(10);
    guide.localFolders.mockResolvedValue(['Documents', 'Notes']);
    guide.defaultLocalPath.mockResolvedValue('/home/me/drive');
    guide.presets.mockReturnValue({ vfs: { vfs_cache_mode: 'full' }, mount: {} });
    guide.settings.mockResolvedValue({
      afterRemote: true,
      setting: 'quick_run',
      destination: 'quick_run',
    });
    guide.saveAfterRemote.mockResolvedValue(undefined);
    guide.saveDestination.mockResolvedValue(undefined);
    guide.network.mockResolvedValue({ hostName: 'my-pc', addresses: ['192.168.1.20'] });
    guide.portFree.mockResolvedValue(true);
    guide.nextFreePort.mockResolvedValue(8081);
  });

  it('starts with the remote that was just created, with its real usage', async () => {
    const component = await create({ remoteName: 'onedrive' });
    await settle();
    expect(component.remoteName()).toBe('onedrive');
    expect(component.cloud()).toEqual({ used: 180, free: 20 });
    expect(component.appBrand()).toBe('OneDrive');
  });

  it('falls back to the first remote and reports a failed load', async () => {
    const component = await create({ remoteName: 'gone' });
    expect(component.remoteName()).toBe('drive');

    TestBed.resetTestingModule();
    guide.loadEnvironment.mockRejectedValue(new Error('down'));
    const failed = await create();
    expect(failed.loadFailed()).toBe(true);
  });

  it('goes straight from the folder goal to where, with a suggested mount folder', async () => {
    const component = await create();
    await settle();
    component.chooseGoal('access');
    expect(component.question()).toBeNull();
    await settle();
    expect(component.step()).toBe('where');
    expect(component.plan()?.operationType).toBe('mount');
    expect(guide.defaultLocalPath).toHaveBeenCalledWith('drive', 'mount');
    expect(component.localPath()).toBe('/home/me/drive');
    expect(component.whereValid()).toBe(true);
  });

  it('explains the folders only where the choice has a catch', async () => {
    const component = await create();
    await settle();
    const aboutOf = async (
      goal: 'access' | 'devices' | 'backup',
      answer?: string
    ): Promise<string | null> => {
      component.chooseGoal(goal);
      if (answer) component.answer(answer);
      await settle();
      const about = component.whereAbout();
      component.back();
      return about;
    };

    expect(await aboutOf('access')).toBe('stream');
    expect(await aboutOf('devices')).toBe('twoWay');
    expect(await aboutOf('backup', 'mirror')).toBe('mirror');
    expect(await aboutOf('backup', 'keep')).toBeNull();
  });

  it('names the cloud folder after the chosen local folder until one is picked', async () => {
    vi.useFakeTimers();
    try {
      const component = await create();
      component.chooseGoal('backup');
      component.answer('keep');
      await settle();
      expect(component.whereValid()).toBe(false);

      component.chooseHomeFolder('Documents');
      expect(component.localPath()).toBe('/home/me/Documents');
      expect(component.remotePath()).toBe('Documents');
      // The field holds what the guide suggested.
      expect(component.cloudGroup.controls.path.value).toBe('Documents');
      // The folder is measured when typing pauses, not on every key.
      expect(guide.folderSize).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(component.localFolderSize()).toBe(10);

      component.setRemotePath('Backups');
      component.chooseHomeFolder('Notes');
      expect(component.remotePath()).toBe('Backups');
      expect(component.whereValid()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('measures a folder once for a burst of typing', async () => {
    vi.useFakeTimers();
    try {
      const component = await create();
      component.chooseGoal('backup');
      component.answer('keep');
      await settle();
      guide.folderSize.mockClear();
      for (const text of ['/h', '/ho', '/home', '/home/me/Docs']) {
        component.localGroup.controls.path.setValue(text);
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(600);
      expect(guide.folderSize).toHaveBeenCalledTimes(1);
      expect(guide.folderSize).toHaveBeenCalledWith('/home/me/Docs');
      expect(component.localPath()).toBe('/home/me/Docs');
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks a mount folder and a two-way folder, and nothing else', async () => {
    const component = await create();
    component.chooseGoal('access');
    await settle();
    expect(component.inspectOp()).toBe('mount');

    component.back();
    component.chooseGoal('devices');
    await settle();
    expect(component.inspectOp()).toBe('bisync');

    component.back();
    component.chooseGoal('backup');
    component.answer('keep');
    await settle();
    expect(component.inspectOp()).toBeNull();
  });

  it('goes back from a question to the goals', async () => {
    const component = await create();
    component.chooseGoal('backup');
    expect(component.question()).toBe('deleted');
    component.back();
    expect(component.step()).toBe('goal');
  });

  it('returns from the folders to the last question', async () => {
    const component = await create();
    component.chooseGoal('backup');
    component.answer('keep');
    await settle();
    expect(component.step()).toBe('where');
    component.back();
    expect(component.step()).toBe('question');
    expect(component.question()).toBe('deleted');
  });

  it('goes straight to the folders for a goal without questions and back to the goals', async () => {
    const component = await create();
    component.chooseGoal('download');
    await settle();
    expect(component.step()).toBe('where');
    expect(component.plan()?.operationType).toBe('copy');
    component.back();
    expect(component.step()).toBe('goal');
  });

  it('opens the file browser straight away for browsing', async () => {
    const component = await create();
    component.chooseGoal('explore');
    component.answer('browse');
    await settle();
    expect(close).toHaveBeenCalled();
    expect(openRemoteInFiles).toHaveBeenCalledWith('drive', undefined);
  });

  it('needs a password before sharing over WebDAV', async () => {
    const component = await create();
    component.chooseGoal('share');
    component.answer('folder');
    await settle();
    expect(component.shareUser()).toBe('drive');
    expect(component.whereValid()).toBe(false);
    component.sharePassword.set('secret');
    expect(component.whereValid()).toBe(true);
  });

  describe('sharing', () => {
    const toShare = async (
      device: 'tv' | 'folder' | 'browser'
    ): Promise<IntentGuideModalComponent> => {
      const component = await create();
      component.chooseGoal('share');
      component.answer(device);
      await settle();
      return component;
    };

    it('starts a WebDAV share on the usual port, read-only, and knows where this machine is', async () => {
      const component = await toShare('folder');
      expect(component.sharePort()).toBe(8080);
      expect(component.shareReadOnly()).toBe(true);
      expect(component.network()).toEqual({ hostName: 'my-pc', addresses: ['192.168.1.20'] });
    });

    it('needs a port a normal user can bind', async () => {
      const component = await toShare('folder');
      component.sharePassword.set('secret');
      expect(component.whereValid()).toBe(true);
      for (const bad of [80, 70000, 0]) {
        component.setSharePort(bad);
        expect(component.sharePortValid()).toBe(false);
        expect(component.whereValid()).toBe(false);
      }
      component.setSharePort('9090');
      expect(component.sharePort()).toBe(9090);
      expect(component.whereValid()).toBe(true);
      component.setSharePort('abc');
      expect(component.sharePort()).toBe(9090);
    });

    it('quietly moves the default port to a free one without a warning', async () => {
      vi.useFakeTimers();
      try {
        guide.portFree.mockResolvedValue(false);
        const component = await toShare('folder');
        component.sharePassword.set('secret');
        await vi.advanceTimersByTimeAsync(10);
        expect(guide.portFree).toHaveBeenCalledWith(8080);
        expect(component.sharePort()).toBe(8081);
        expect(component.sharePortBusy()).toBe(false);
        expect(component.freePortSuggestion()).toBeNull();
        expect(component.whereValid()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the default port when it is free', async () => {
      vi.useFakeTimers();
      try {
        const component = await toShare('folder');
        await vi.advanceTimersByTimeAsync(10);
        expect(component.sharePort()).toBe(8080);
        expect(guide.nextFreePort).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('warns about a port the user typed that is taken and offers a free one', async () => {
      vi.useFakeTimers();
      try {
        const component = await toShare('folder');
        component.sharePassword.set('secret');
        await vi.advanceTimersByTimeAsync(10);
        guide.portFree.mockResolvedValue(false);
        guide.nextFreePort.mockResolvedValue(9091);

        component.setSharePort(9090);
        await vi.advanceTimersByTimeAsync(600);
        expect(component.sharePort()).toBe(9090);
        expect(component.sharePortBusy()).toBe(true);
        expect(component.freePortSuggestion()).toBe(9091);
        expect(component.whereValid()).toBe(false);

        guide.portFree.mockResolvedValue(true);
        component.useFreePort();
        await vi.advanceTimersByTimeAsync(600);
        expect(component.sharePort()).toBe(9091);
        expect(component.sharePortBusy()).toBe(false);
        expect(component.whereValid()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('checks the port once for a burst of typing and never for an invalid one', async () => {
      vi.useFakeTimers();
      try {
        const component = await toShare('folder');
        await vi.advanceTimersByTimeAsync(10);
        guide.portFree.mockClear();
        for (const port of [9, 90, 909, 9090]) {
          component.setSharePort(port);
          await vi.advanceTimersByTimeAsync(100);
        }
        await vi.advanceTimersByTimeAsync(600);
        expect(guide.portFree).toHaveBeenCalledTimes(1);
        expect(guide.portFree).toHaveBeenCalledWith(9090);
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats an unknown answer as a free port', async () => {
      vi.useFakeTimers();
      try {
        guide.portFree.mockResolvedValue(null);
        const component = await toShare('folder');
        component.sharePassword.set('secret');
        await vi.advanceTimersByTimeAsync(600);
        expect(component.sharePortBusy()).toBe(false);
        expect(component.whereValid()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows where to connect, with the port, the user and what devices may do', async () => {
      const component = await toShare('folder');
      component.sharePassword.set('secret');
      component.setSharePort(9090);
      const keys = component.details().map(d => d.key);
      expect(keys).toEqual(['address', 'address', 'port', 'user', 'readOnly']);
      expect(component.details()[0].value).toBe('http://192.168.1.20:9090');

      component.shareReadOnly.set(false);
      expect(component.details().at(-1)?.key).toBe('canChange');
      expect(component.effects().map(e => e.key)).toContain('shareWrite');
    });

    it('sets the share up with the chosen port and read-only access', async () => {
      const component = await toShare('folder');
      component.sharePassword.set('secret');
      component.setSharePort(9090);
      component.afterWhere();
      expect(component.step()).toBe('review');
      guide.apply.mockResolvedValue({
        quickRun: { id: 'qr', name: 'n' },
        execution: { serveAddr: '[::]:9090' },
      });
      await component.apply();
      expect(guide.apply.mock.calls[0][0].config.rclone).toEqual({
        fs: 'drive:',
        type: 'webdav',
        addr: ':9090',
        user: 'drive',
        pass: 'secret',
        vfs: { read_only: true },
      });
      expect(component.doneKey()).toBe('shareWebdav');
      // The port rclone reports wins over the one that was asked for.
      expect(component.shareLinks()).toEqual(['http://192.168.1.20:9090', 'http://my-pc:9090']);
    });

    it('says to use the machine address when none is known', async () => {
      guide.network.mockResolvedValue(null);
      const component = await toShare('folder');
      component.sharePassword.set('secret');
      expect(component.details().map(d => d.key)).toEqual([
        'addressUnknown',
        'port',
        'user',
        'readOnly',
      ]);
      component.afterWhere();
      guide.apply.mockResolvedValue({ quickRun: { id: 'qr', name: 'n' }, execution: null });
      await component.apply();
      expect(component.shareLinks()).toEqual([]);
      expect(component.doneKey()).toBe('noAddress');
    });

    it('shares a web page with a login and a port, in words of its own', async () => {
      const component = await toShare('browser');
      expect(component.whereValid()).toBe(false);
      component.sharePassword.set('secret');
      expect(component.whereValid()).toBe(true);
      expect(component.sharePlace()).toEqual({ icon: 'globe', key: 'browser' });
      expect(component.summaryKey()).toBe('share_http');
      expect(component.details().map(d => d.key)).toEqual([
        'address',
        'address',
        'port',
        'user',
        'readOnly',
      ]);
      component.afterWhere();
      guide.apply.mockResolvedValue({
        quickRun: { id: 'qr', name: 'n' },
        execution: { serveAddr: '[::]:8080' },
      });
      await component.apply();
      expect(guide.apply.mock.calls[0][0].config.rclone).toMatchObject({
        type: 'http',
        addr: ':8080',
        pass: 'secret',
      });
      expect(component.doneKey()).toBe('shareHttp');
    });

    it('names a DLNA share after the cloud and asks for no port or password', async () => {
      const component = await toShare('tv');
      expect(component.shareName()).toBe('drive');
      expect(component.whereValid()).toBe(true);
      component.shareName.set('Living room');
      expect(component.details().map(d => [d.key, d.value])).toEqual([['tvName', 'Living room']]);
      component.afterWhere();
      guide.apply.mockResolvedValue({ quickRun: { id: 'qr', name: 'n' }, execution: null });
      await component.apply();
      expect(guide.apply.mock.calls[0][0].config.rclone).toEqual({
        fs: 'drive:',
        type: 'dlna',
        name: 'Living room',
      });
      expect(component.doneKey()).toBe('shareDlna');
    });

    it('does not look up the network for anything but a share', async () => {
      guide.network.mockClear();
      const component = await create();
      component.chooseGoal('backup');
      component.answer('keep');
      await settle();
      expect(guide.network).not.toHaveBeenCalled();
    });
  });

  it('names a cloud folder for people, never as remote:path', async () => {
    const component = await create();
    expect(component.cloudLabel()).toBe('drive');
    expect(component.cloudFolder()).toBe('');
    component.remotePath.set('/Photos/2024/');
    expect(component.cloudFolder()).toBe('Photos › 2024');
    expect(component.cloudLabel()).toBe('drive › Photos › 2024');
  });

  it('tells a mount how much disk its cache may take', async () => {
    guide.presets.mockReturnValue({
      vfs: { vfs_cache_mode: 'full', vfs_cache_max_size: '250G', vfs_cache_max_age: '48h' },
      mount: {},
    });
    const component = await create();
    component.chooseGoal('access');
    await settle();
    const cache = component.details().find(d => d.key === 'cache');
    expect(cache?.params).toEqual({ size: '250 GB', age: '48 h' });
  });

  it('picks the other remote as the target of a move between clouds', async () => {
    const component = await create();
    component.chooseGoal('migrate');
    component.answer('keep');
    await settle();
    expect(component.targetRemote()).toBe('onedrive');
    expect(component.targetPath()).toBe('drive');
    expect(component.whereValid()).toBe(true);
  });

  it('shows what the dry run found, file by file, and tolerates a failed one', async () => {
    const component = await create();
    component.chooseGoal('download');
    await settle();
    toReview(component);
    expect(component.step()).toBe('review');

    const files = Array.from({ length: 120 }, (_, i) => ({ path: `photo-${i}.jpg`, size: 10 }));
    guide.preview.mockResolvedValue({
      counts: { transfers: 120, bytes: 1200, deletes: 1, errors: 0 },
      matched: 7,
      fileLevel: true,
      groups: [
        { kind: 'delete', files: [{ path: 'old.txt' }], bytes: 0 },
        { kind: 'add', files, bytes: 1200 },
      ],
    });
    await component.runPreview();

    expect(component.preview().state).toBe('done');
    // The deletions come first and are the group that opens.
    expect(component.previewKind()).toBe('delete');
    expect(component.previewDeletes()).toBe(1);
    expect(component.previewVisible().map(f => f.path)).toEqual(['old.txt']);

    component.selectPreviewKind('add');
    expect(component.previewMatches()).toHaveLength(120);
    expect(component.previewVisible()).toHaveLength(50);
    component.previewLimit.set(component.previewLimit() + component.previewPage);
    expect(component.previewVisible()).toHaveLength(100);

    // The search looks through the whole list, not only what is shown.
    component.setPreviewQuery('PHOTO-11');
    expect(component.previewMatches().map(f => f.path)).toEqual([
      'photo-11.jpg',
      'photo-110.jpg',
      'photo-111.jpg',
      'photo-112.jpg',
      'photo-113.jpg',
      'photo-114.jpg',
      'photo-115.jpg',
      'photo-116.jpg',
      'photo-117.jpg',
      'photo-118.jpg',
      'photo-119.jpg',
    ]);
    expect(component.previewVisible()).toHaveLength(11);

    expect(guide.preview.mock.calls[0][0]).toMatchObject({
      operationType: 'copy',
      config: { rclone: { srcFs: 'drive:', dstFs: '/home/me/drive' } },
    });

    guide.preview.mockRejectedValue(new Error('denied'));
    await component.runPreview();
    expect(component.preview().state).toBe('failed');
  });

  it('shows no group when the dry run would change nothing', async () => {
    const component = await create();
    component.chooseGoal('download');
    await settle();
    toReview(component);
    guide.preview.mockResolvedValue({
      counts: { transfers: 0, bytes: 0, deletes: 0, errors: 0 },
      matched: 12,
      fileLevel: true,
      groups: [],
    });
    await component.runPreview();
    expect(component.previewKind()).toBeNull();
    expect(component.previewGroup()).toBeUndefined();
    expect(component.previewDeletes()).toBe(0);
  });

  it('cancels a running preview', async () => {
    const component = await create();
    component.preview.set({ state: 'running', executeId: 'exec-1' });
    await component.cancelPreview();
    expect(component.preview().state).toBe('idle');
    expect(guide.cancel).toHaveBeenCalledWith('exec-1');
  });

  it('sets the mount up, turns on start with the system and lands on done', async () => {
    const component = await create();
    component.chooseGoal('access');
    await settle();
    component.afterWhere();
    expect(component.step()).toBe('when');
    expect(component.offersStartOnLogin()).toBe(true);
    component.toReview();
    guide.apply.mockResolvedValue({
      quickRun: { id: 'qr', name: 'n' },
      execution: { mountPoint: '/home/me/drive' },
    });

    await component.apply();

    expect(guide.apply).toHaveBeenCalledWith(
      expect.objectContaining({ operationType: 'mount' }),
      expect.objectContaining({ flow: 'stream' }),
      expect.objectContaining({ startOnLogin: true })
    );
    expect(component.step()).toBe('done');
    expect(component.doneKey()).toBe('stream');
    expect(component.openablePath()).toBe('/home/me/drive');
  });

  describe("the guide's settings", () => {
    it('reads them when it opens', async () => {
      guide.settings.mockResolvedValue({
        afterRemote: false,
        setting: 'profile',
        destination: 'profile',
      });
      const component = await create();
      component.ngOnInit();
      await settle();
      expect(component.afterRemote()).toBe(false);
      expect(component.destinationSetting()).toBe('profile');
    });

    it('opens and closes the settings without leaving the step', async () => {
      const component = await create();
      component.chooseGoal('download');
      component.toggleSettings();
      expect(component.settingsOpen()).toBe(true);
      component.toggleSettings();
      expect(component.settingsOpen()).toBe(false);
      expect(component.step()).not.toBe('goal');
    });

    it('saves whether the guide follows a new cloud', async () => {
      const component = await create();
      component.setAfterRemote(false);
      expect(component.afterRemote()).toBe(false);
      expect(guide.saveAfterRemote).toHaveBeenCalledWith(false);
    });

    it('saves the destination and uses it for what the guide sets up from now on', async () => {
      guide.resolveDestination.mockResolvedValue('profile');
      const component = await create();
      await component.setDestinationSetting('profile');
      expect(guide.saveDestination).toHaveBeenCalledWith('profile');
      expect(component.destinationSetting()).toBe('profile');
      expect(component.destination()).toBe('profile');
    });
  });

  describe('what is already set up', () => {
    const none = { startup: false, watch: false, cron: null };
    const setup = {
      key: 'quick_run:qr-1',
      kind: 'quick_run',
      id: 'qr-1',
      name: 'Docs backup',
      remoteName: 'drive',
      operationType: 'copy',
      flow: 'upload',
      summaryKey: 'upload_copy',
      local: '/home/me/Docs',
      cloud: 'drive › Docs',
      cloudFolder: 'Docs',
      target: '',
      targetRemote: '',
      automation: none,
      signature: 'upload|/home/me/Docs|drive|Docs||',
    };
    const mount = {
      ...setup,
      key: 'profile:drive:mount:Default',
      kind: 'profile',
      id: undefined,
      name: 'Default',
      operationType: 'mount',
      flow: 'stream',
      summaryKey: 'stream',
      local: '/home/me/drive',
      cloudFolder: '',
      signature: 'stream|/home/me/drive|drive||',
    };

    it('lists them with the state of their last run', async () => {
      guide.loadSetups.mockResolvedValue([setup]);
      guide.setupStatus.mockReturnValue({
        state: 'ok',
        at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      });
      const component = await create();
      await settle();
      const [row] = component.setupRows();
      expect(guide.loadSetups).toHaveBeenCalledWith(['drive', 'onedrive']);
      expect(row.setup.name).toBe('Docs backup');
      expect(row.statusKey).toBe('job.ok');
      expect(row.icon).toBe('cloud-arrow-up');
      expect(row.statusTone).toBe('primary');
      expect(row.when).toMatch(/2 hours ago/);
    });

    it('says a mount is connected or not instead of when it last ran', async () => {
      guide.loadSetups.mockResolvedValue([mount]);
      guide.setupStatus.mockReturnValue({ state: 'failed', at: '2026-11-01T10:00:00Z' });
      const component = await create();
      await settle();
      expect(component.setupRows()[0].statusKey).toBe('stream.idle');
      guide.setupStatus.mockReturnValue({ state: 'running' });
      // The real service reads signals; the mock needs a nudge to compute again.
      component.setups.set([...component.setups()]);
      expect(component.setupRows()[0].statusKey).toBe('stream.running');
    });

    it('shows the real folders and lists what starts a setup by itself', async () => {
      guide.loadSetups.mockResolvedValue([
        { ...setup, automation: { startup: true, watch: true, cron: '0 2 * * *' } },
        mount,
      ]);
      const component = await create();
      await settle();
      const [first, second] = component.setupRows();
      expect(first.path).toBe('/home/me/Docs → Docs');
      expect(first.auto.map(a => a.icon)).toEqual(['power-off', 'bolt', 'calendar']);
      expect(first.auto[0].key).toBe('startup');
      expect(first.auto[2].text).toBeTruthy();
      expect(first.kind).toBe('quickRun');
      expect(second.path).toBe('/home/me/drive');
      expect(second.auto.map(a => a.key)).toEqual(['manual']);
      expect(second.kind).toBe('profile');
    });

    it('writes the folders in the direction the files go', async () => {
      const other = (flow: string, extra: object = {}): unknown => ({
        ...setup,
        flow,
        local: '/home/me/Pics',
        cloudFolder: '',
        ...extra,
      });
      guide.loadSetups.mockResolvedValue([
        other('download', { cloudFolder: 'Pics' }),
        other('twoWay', { cloudFolder: 'Notes' }),
        other('twoWay'),
        other('cloudToCloud', { target: 'box › old' }),
        other('cloudToCloud', { target: 'box', cloudFolder: 'Pics' }),
        other('share', { local: '' }),
        other('share', { local: '', cloudFolder: 'Photos' }),
      ]);
      const component = await create();
      await settle();
      expect(component.setupRows().map(r => r.path)).toEqual([
        'Pics → /home/me/Pics',
        '/home/me/Pics ⇄ Notes',
        '/home/me/Pics',
        '→ box › old',
        'Pics → box',
        '',
        'Photos',
      ]);
    });

    it('says a mount mounts and a share serves when the app starts', async () => {
      guide.loadSetups.mockResolvedValue([
        { ...mount, automation: { startup: true, watch: false, cron: null } },
      ]);
      const component = await create();
      await settle();
      expect(component.setupRows()[0].auto[0].key).toBe('startupStream');
      guide.loadSetups.mockResolvedValue([
        {
          ...setup,
          flow: 'share',
          automation: { startup: true, watch: false, cron: null },
        },
        { ...setup, key: 'y', automation: { startup: true, watch: false, cron: null } },
      ]);
      await component.load();
      await settle();
      expect(component.setupRows().map(r => r.auto[0].key)).toEqual(['startupShare', 'startup']);
    });

    it('colours a mount that is up like a run that went fine', async () => {
      guide.loadSetups.mockResolvedValue([mount, setup]);
      guide.setupStatus.mockReturnValue({ state: 'running' });
      const component = await create();
      await settle();
      expect(component.setupRows().map(r => r.statusTone)).toEqual(['primary', 'accent']);
    });

    it('groups them by cloud and counts what runs and what failed', async () => {
      guide.loadSetups.mockResolvedValue([
        setup,
        { ...mount, key: 'm2', remoteName: 'onedrive' },
        { ...setup, key: 'qr-2', id: 'qr-2', signature: 'other' },
      ]);
      guide.setupStatus.mockImplementation((s: { key: string }) =>
        s.key === 'qr-2' ? { state: 'failed', error: 'no space left' } : { state: 'running' }
      );
      const component = await create();
      await settle();
      expect(component.setupGroups().map(g => [g.remote.name, g.rows.length])).toEqual([
        ['drive', 2],
        ['onedrive', 1],
      ]);
      expect(component.setupCounts()).toEqual({ running: 2, failed: 1 });
      expect(component.setupRows()[2].status.error).toBe('no space left');
    });

    it('flags a setup that does the same as an earlier one', async () => {
      guide.loadSetups.mockResolvedValue([mount, { ...mount, key: 'm2', name: 'drive folder' }]);
      const component = await create();
      await settle();
      expect(component.setupRows().map(r => r.sameAs)).toEqual([null, 'Default']);
    });

    it('opens the list from the goals and goes back', async () => {
      guide.loadSetups.mockResolvedValue([setup]);
      const component = await create();
      await settle();
      component.openSetups();
      expect(component.step()).toBe('setups');
      component.back();
      expect(component.step()).toBe('goal');
    });

    it('works without the list when it cannot be read', async () => {
      guide.loadSetups.mockRejectedValue(new Error('no settings'));
      const component = await create();
      await settle();
      expect(component.setups()).toEqual([]);
      expect(component.step()).toBe('goal');
    });

    it('opens the Quick Run or the profile of a setup', async () => {
      const component = await create();
      component.showSetup(setup as never);
      expect(close).toHaveBeenCalled();
      expect(navigateToQuickRun).toHaveBeenCalledWith('qr-1');
      component.showSetup({
        ...setup,
        kind: 'profile',
        id: undefined,
        operationType: 'mount',
      } as never);
      expect(navigateToRemote).toHaveBeenCalledWith('drive', 'mount', {
        operationType: 'mount',
        name: 'Docs backup',
      });
    });

    it('removes a setup after the question and reads the list again', async () => {
      guide.loadSetups.mockResolvedValue([setup]);
      guide.undo.mockResolvedValue(undefined);
      const component = await create();
      await settle();
      guide.loadSetups.mockResolvedValue([]);
      await component.removeSetup(setup as never);
      expect(confirmModal).toHaveBeenCalledWith(
        'modals.intentGuide.undo.title',
        expect.stringContaining('Docs backup'),
        'modals.intentGuide.setups.remove',
        'common.cancel',
        { icon: 'trash', color: 'warn' }
      );
      expect(guide.undo).toHaveBeenCalledWith(
        { name: 'Docs backup', quickRun: { id: 'qr-1' } },
        'drive',
        'copy'
      );
      expect(component.removingKey()).toBeNull();
      expect(component.setups()).toEqual([]);
    });

    it('says in the question that removing a running setup stops it first', async () => {
      guide.loadSetups.mockResolvedValue([setup]);
      guide.undo.mockResolvedValue(undefined);
      const component = await create();
      await settle();
      await component.removeSetup(setup as never);
      expect(confirmModal.mock.calls[0][1]).toContain('undo.confirm:');

      confirmModal.mockClear();
      guide.setupStatus.mockReturnValue({ state: 'running' });
      await component.removeSetup(setup as never);
      expect(confirmModal.mock.calls[0][1]).toContain('undo.confirmRunning');
    });

    it('starts a setup that is not running and stops one that is', async () => {
      guide.loadSetups.mockResolvedValue([setup]);
      guide.startSetup.mockResolvedValue(undefined);
      guide.stopSetup.mockResolvedValue(undefined);
      const component = await create();
      await settle();
      const idle = component.setupRows()[0];
      expect(idle.running).toBe(false);
      expect(idle.actionKey).toBe('automation.actions.run');
      expect(idle.actionIcon).toBe('play');
      await component.toggleSetup(idle);
      expect(guide.startSetup).toHaveBeenCalledWith(setup);

      guide.setupStatus.mockReturnValue({ state: 'running' });
      component.setups.set([setup as never]);
      const running = component.setupRows()[0];
      expect(running.running).toBe(true);
      await component.toggleSetup(running);
      expect(guide.stopSetup).toHaveBeenCalledWith(setup);
      expect(component.busyKey()).toBeNull();
    });

    it('words the button like the mount and serve cards', async () => {
      const share = { ...setup, key: 'x', flow: 'share', operationType: 'serve' };
      guide.loadSetups.mockResolvedValue([mount, share, setup]);
      const component = await create();
      await settle();
      const label = (): string[][] => component.setupRows().map(r => [r.actionKey, r.actionIcon]);
      expect(label()).toEqual([
        ['actions.mount', 'mount'],
        ['actions.serve', 'serve'],
        ['automation.actions.run', 'play'],
      ]);

      guide.setupStatus.mockReturnValue({ state: 'running' });
      component.setups.set([...component.setups()]);
      expect(label()).toEqual([
        ['dashboard.appDetail.unmount', 'eject'],
        ['actions.stop', 'stop'],
        ['actions.stop', 'stop'],
      ]);
    });

    it('reports a failure and frees the buttons again', async () => {
      guide.loadSetups.mockResolvedValue([setup]);
      guide.startSetup.mockRejectedValue(new Error('busy'));
      const component = await create();
      await settle();
      await component.toggleSetup(component.setupRows()[0]);
      expect(component.busyKey()).toBeNull();
    });

    it('does not start a second action while one is under way', async () => {
      guide.loadSetups.mockResolvedValue([setup]);
      const component = await create();
      await settle();
      component.busyKey.set('other');
      await component.toggleSetup(component.setupRows()[0]);
      expect(guide.startSetup).not.toHaveBeenCalled();
    });

    it('keeps the setup when the question is answered with no', async () => {
      guide.loadSetups.mockResolvedValue([setup]);
      confirmModal.mockResolvedValue(false);
      const component = await create();
      await settle();
      await component.removeSetup(setup as never);
      expect(guide.undo).not.toHaveBeenCalled();
      expect(component.setups()).toHaveLength(1);
    });

    it('keeps the setup when removing fails', async () => {
      guide.loadSetups.mockResolvedValue([setup]);
      guide.undo.mockRejectedValue(new Error('busy'));
      const component = await create();
      await settle();
      await component.removeSetup(setup as never);
      expect(component.removingKey()).toBeNull();
      expect(component.setups()).toHaveLength(1);
    });

    it('points out a setup that already does what the review shows', async () => {
      guide.loadSetups.mockResolvedValue([setup]);
      const component = await create();
      await settle();
      component.chooseGoal('backup');
      component.answer('keep');
      await settle();
      component.localPath.set('/home/me/Docs/');
      component.remotePath.set('Docs');
      toReview(component);
      expect(component.sameSetup()?.name).toBe('Docs backup');
      component.remotePath.set('Other');
      expect(component.sameSetup()).toBeNull();
    });
  });

  describe('taking the setup back', () => {
    const toDone = async (): Promise<IntentGuideModalComponent> => {
      const component = await create();
      component.chooseGoal('access');
      await settle();
      toReview(component);
      guide.apply.mockResolvedValue({
        destination: 'quick_run',
        name: 'drive folder',
        quickRun: { id: 'qr', name: 'drive folder' },
        execution: null,
      });
      await component.apply();
      return component;
    };

    it('asks first, and does nothing when the answer is no', async () => {
      const component = await toDone();
      confirmModal.mockResolvedValue(false);
      await component.undo();
      expect(confirmModal).toHaveBeenCalled();
      expect(guide.undo).not.toHaveBeenCalled();
      expect(component.undoState()).toBe('idle');
    });

    it('removes what was set up and says so', async () => {
      const component = await toDone();
      guide.undo.mockResolvedValue(undefined);
      await component.undo();
      expect(guide.undo).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'drive folder' }),
        'drive',
        'mount'
      );
      expect(component.undoState()).toBe('removed');
    });

    it('reports a failure and lets the user try again', async () => {
      const component = await toDone();
      guide.undo.mockRejectedValue(new Error('busy'));
      await component.undo();
      expect(component.undoState()).toBe('failed');
      guide.undo.mockResolvedValue(undefined);
      await component.undo();
      expect(component.undoState()).toBe('removed');
    });

    it('starts clean when another setup begins', async () => {
      const component = await toDone();
      guide.undo.mockResolvedValue(undefined);
      await component.undo();
      component.startOver();
      expect(component.undoState()).toBe('idle');
      expect(component.step()).toBe('goal');
    });
  });

  it('shows why the first sync stopped, in rclone words', async () => {
    const component = await create();
    component.chooseGoal('devices');
    await settle();
    toReview(component);
    guide.apply.mockResolvedValue({
      destination: 'quick_run',
      name: 'drive sync',
      quickRun: { id: 'qr', name: 'drive sync' },
      execution: { executeId: 'exec-1' },
      firstRunDone: false,
    });
    guide.job.mockReturnValue({ error: "  couldn't reach the cloud  " });
    await component.apply();
    expect(component.doneKey()).toBe('twoWayFailed');
    expect(component.failureReason()).toBe("couldn't reach the cloud");

    guide.apply.mockResolvedValue({
      destination: 'quick_run',
      name: 'drive sync',
      quickRun: { id: 'qr', name: 'drive sync' },
      execution: { executeId: 'exec-1' },
      firstRunDone: true,
    });
    await component.apply();
    expect(component.failureReason()).toBeNull();
  });

  describe('where the result is kept', () => {
    const toMountReview = async (): Promise<IntentGuideModalComponent> => {
      const component = await create();
      component.chooseGoal('access');
      await settle();
      toReview(component);
      return component;
    };

    it('starts from the setting and lets the review change it for this run', async () => {
      guide.settings.mockResolvedValue({
        afterRemote: true,
        setting: 'auto',
        destination: 'profile',
      });
      const component = await create();
      component.ngOnInit();
      await settle();
      expect(component.destination()).toBe('profile');
      expect(component.destinationSetting()).toBe('auto');

      component.chooseGoal('access');
      await settle();
      toReview(component);
      component.destination.set('quick_run');
      guide.apply.mockResolvedValue({
        destination: 'quick_run',
        name: 'n',
        quickRun: { id: 'qr', name: 'n' },
        execution: {},
      });
      await component.apply();

      expect(guide.apply).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ destination: 'quick_run' })
      );
    });

    it('shows a profile on the remote page of its tab', async () => {
      const component = await toMountReview();
      guide.apply.mockResolvedValue({ destination: 'profile', name: 'n', execution: {} });
      await component.apply();
      component.showWhere();
      expect(close).toHaveBeenCalled();
      expect(navigateToRemote).toHaveBeenCalledWith('drive', 'mount', {
        operationType: 'mount',
        name: 'n',
      });
      expect(navigateToQuickRun).not.toHaveBeenCalled();
    });

    it('opens a copy profile on the operations tab', async () => {
      const component = await create();
      component.showSetup({
        ...{ name: 'Nightly', remoteName: 'drive', kind: 'profile', operationType: 'copy' },
      } as never);
      expect(navigateToRemote).toHaveBeenCalledWith('drive', 'operations', {
        operationType: 'copy',
        name: 'Nightly',
      });
    });

    it('shows a Quick Run in Flow', async () => {
      const component = await toMountReview();
      guide.apply.mockResolvedValue({
        destination: 'quick_run',
        name: 'n',
        quickRun: { id: 'qr', name: 'n' },
        execution: {},
      });
      await component.apply();
      component.showWhere();
      expect(navigateToQuickRun).toHaveBeenCalledWith('qr');
      expect(navigateToRemote).not.toHaveBeenCalled();
    });
  });

  it('stays on the review when setting up fails', async () => {
    const component = await create();
    component.chooseGoal('download');
    await settle();
    toReview(component);
    guide.apply.mockResolvedValue(null);
    await component.apply();
    expect(component.step()).toBe('review');
    expect(component.applyFailed()).toBe(true);
  });

  it('does not offer to open a folder on a server', async () => {
    guide.loadEnvironment.mockResolvedValue({ ...ENV, isServer: true });
    const component = await create();
    component.chooseGoal('download');
    await settle();
    expect(component.localPlace()).toBe('server');
    expect(component.openablePath()).toBeNull();
  });

  it('hands everything it filled in to the full editor', async () => {
    const component = await create();
    component.chooseGoal('devices');
    await settle();
    component.chooseHomeFolder('Notes');
    component.openAdvanced();
    expect(close).toHaveBeenCalled();
    expect(openQuickRunEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        initialOpType: 'bisync',
        initialRemoteName: 'drive',
        cloneData: expect.objectContaining({
          config: expect.objectContaining({
            rclone: { path1: '/home/me/Notes', path2: 'drive:Notes', resync: true },
          }),
        }),
      })
    );
  });

  describe('when step', () => {
    const toWhen = async (
      goal: 'backup' | 'devices' | 'access' | 'share',
      answer?: string
    ): Promise<IntentGuideModalComponent> => {
      const component = await create();
      component.chooseGoal(goal);
      if (answer) component.answer(answer);
      await settle();
      if (goal === 'backup' || goal === 'devices') component.chooseHomeFolder('Notes');
      if (goal === 'share') component.sharePassword.set('secret');
      component.afterWhere();
      return component;
    };

    it('starts a backup on a daily schedule the user can combine with the other triggers', async () => {
      const component = await toWhen('backup', 'keep');
      expect(component.step()).toBe('when');
      expect(component.schedule()).toMatchObject({
        startup: false,
        watch: false,
        cron: '0 2 * * *',
      });
      expect(component.scheduleOptions()).toEqual({ startup: true, watch: true, cron: true });

      component.scheduleWatch.set(true);
      component.scheduleStartup.set(true);
      component.onCronChange('0 8,20 * * *');
      expect(component.schedule()).toMatchObject({
        startup: true,
        watch: true,
        cron: '0 8,20 * * *',
      });
      expect(component.scheduleLines().map(l => l.key)).toEqual(['watch', 'cron', 'startup']);
    });

    it('lets the user choose the delays and keeps the defaults when they are left alone', async () => {
      const component = await toWhen('backup', 'keep');
      expect(component.schedule()).toMatchObject({ watchDelay: 5, startupDelay: 0 });

      component.scheduleWatch.set(true);
      component.scheduleStartup.set(true);
      component.setDelay('watch', 30);
      component.setDelay('startup', '15');
      expect(component.schedule()).toMatchObject({ watchDelay: 30, startupDelay: 15 });

      component.toReview();
      guide.apply.mockResolvedValue({ quickRun: { id: 'qr', name: 'n' }, execution: null });
      await component.apply();
      expect(guide.apply.mock.calls[0][0].config.app).toMatchObject({
        watchEnabled: true,
        watchDelay: 30,
        autoStart: true,
        autoStartDelay: 15,
      });
    });

    it('ignores a delay that is not a whole number of seconds from zero', async () => {
      const component = await toWhen('backup', 'keep');
      component.setDelay('watch', 12.9);
      expect(component.scheduleWatchDelay()).toBe(12);
      for (const bad of [-1, NaN, 'abc', Infinity]) component.setDelay('watch', bad);
      expect(component.scheduleWatchDelay()).toBe(12);
    });

    it('can be turned off completely, which means it runs only when started', async () => {
      const component = await toWhen('backup', 'keep');
      component.toggleCron();
      expect(component.schedule().cron).toBeNull();
      expect(component.scheduleLines()).toEqual([{ key: 'manual' }]);
    });

    it('does not continue while the schedule is invalid', async () => {
      const component = await toWhen('backup', 'keep');
      component.onCronValidation({ isValid: false });
      expect(component.scheduleValid()).toBe(false);
      component.toReview();
      expect(component.step()).toBe('when');
      component.onCronValidation({ isValid: true });
      component.toReview();
      expect(component.step()).toBe('review');
    });

    it('reminds a two-way copy that watching does not see the cloud', async () => {
      const component = await toWhen('devices');
      expect(component.schedule()).toMatchObject({
        startup: false,
        watch: true,
        cron: '0 * * * *',
      });
      expect(component.needsCloudSchedule()).toBe(false);
      component.toggleCron();
      expect(component.needsCloudSchedule()).toBe(true);
    });

    it('sets up exactly the schedule that was chosen', async () => {
      const component = await toWhen('backup', 'keep');
      component.scheduleWatch.set(true);
      component.toReview();
      guide.apply.mockResolvedValue({ quickRun: { id: 'qr', name: 'n' }, execution: null });
      await component.apply();
      expect(guide.apply.mock.calls[0][0].config.app).toEqual({
        watchEnabled: true,
        cronEnabled: true,
        cronExpression: '0 2 * * *',
      });
    });

    it('only offers a mount to start with the app and comes back to the folders', async () => {
      const component = await toWhen('access');
      expect(component.scheduleOptions()).toEqual({ startup: true, watch: false, cron: false });
      component.back();
      expect(component.step()).toBe('where');
    });

    it('skips the step when nothing can run on its own', async () => {
      const component = await toWhen('share', 'tv');
      expect(component.hasWhen()).toBe(false);
      expect(component.step()).toBe('review');
      component.back();
      expect(component.step()).toBe('where');
    });

    it('counts the extra step in the progress', async () => {
      const component = await toWhen('backup', 'keep');
      expect(component.stepTotal()).toBe(5);
      expect(component.stepNumber()).toBe(4);
    });
  });

  describe('adding a cloud on the way', () => {
    it('hands its choices to the quick add dialog', async () => {
      const component = await create();
      component.chooseGoal('migrate');
      component.answer('keep');
      await settle();
      component.addRemote();
      expect(close).toHaveBeenCalled();
      expect(openQuickAddRemote).toHaveBeenCalledWith({
        remoteName: 'drive',
        goal: 'migrate',
        answers: { keepOld: 'keep' },
      });
    });

    it('hands over nothing before a goal is chosen', async () => {
      const component = await create();
      component.addRemote();
      expect(openQuickAddRemote).toHaveBeenCalledWith(undefined);
    });

    it('carries on at the folders step with the new cloud as the target', async () => {
      guide.loadEnvironment.mockResolvedValue({
        ...ENV,
        remotes: [
          { name: 'drive', type: 'drive' },
          { name: 'onedrive', type: 'onedrive' },
          { name: 'box', type: 'box' },
        ],
      });
      const component = await create({
        remoteName: 'box',
        resume: { remoteName: 'drive', goal: 'migrate', answers: { keepOld: 'move' } },
      });
      await settle();
      expect(component.remoteName()).toBe('drive');
      expect(component.step()).toBe('where');
      expect(component.plan()?.operationType).toBe('move');
      expect(component.targetRemote()).toBe('box');
    });

    it('starts at the goals when the saved answers are incomplete', async () => {
      const component = await create({
        remoteName: 'onedrive',
        resume: { remoteName: 'drive', goal: 'migrate', answers: {} },
      });
      expect(component.remoteName()).toBe('drive');
      expect(component.step()).toBe('goal');
    });
  });

  it('offers to add a remote when there is none', async () => {
    guide.loadEnvironment.mockResolvedValue({ ...ENV, remotes: [] });
    const component = await create();
    expect(component.remoteName()).toBe('');
    component.addRemote();
    expect(openQuickAddRemote).toHaveBeenCalled();
  });
});
