import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { Observable, of } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WizardState } from './wizard.state';
import { NavigationDispatcherService } from 'src/app/services/ui/navigation-dispatcher.service';
import { WizardEnvironment, WizardService } from 'src/app/services/flow/wizard.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { NavigationHistoryService } from 'src/app/services/ui/navigation-history.service';

const ENV: WizardEnvironment = {
  remotes: [
    { name: 'drive', type: 'drive' },
    { name: 'onedrive', type: 'onedrive' },
  ],
  home: '/home/me',
  homeFree: 60,
  isServer: false,
  isAndroid: false,
  canUseDriveLetter: false,
  canStartOnLogin: true,
  startsOnLogin: false,
};

describe('WizardState', () => {
  const close = vi.fn();
  const mountPluginMissing = signal(false);
  const mountPluginCheckSkipped = signal(false);
  const wizard = {
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
    saveShowMascot: vi.fn(),
    portFree: vi.fn(),
    nextFreePort: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
    cancel: vi.fn(),
    job: vi.fn(),
    openFolder: vi.fn(),
    installMountPlugin: vi.fn(),
    undo: vi.fn(),
    planProfile: vi.fn(),
    loadSetups: vi.fn(),
  };
  const openRemoteInFiles = vi.fn();
  const openQuickRunEditor = vi.fn();
  const openRemoteConfig = vi.fn();
  const openQuickAddRemote = vi.fn();
  const openJobDetail = vi.fn();
  let standalone = false;
  const confirmModal = vi.fn();
  const navigateToRemote = vi.fn();
  const navigateToQuickRun = vi.fn();
  /** The history entries the wizard opened: what to call when the system takes one away, and how it gives one back. */
  let layers: { close: () => void; release: ReturnType<typeof vi.fn> }[] = [];

  const create = async (data: unknown = null): Promise<WizardState> => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MatDialogRef,
          useValue: { close, afterClosed: (): Observable<undefined> => of(undefined) },
        },
        { provide: MAT_DIALOG_DATA, useValue: data },
        {
          provide: WizardService,
          useValue: { ...wizard, mountPluginMissing, mountPluginCheckSkipped },
        },
        { provide: RemoteFacadeService, useValue: { openRemoteInFiles } },
        {
          provide: NavigationDispatcherService,
          useValue: { navigateToRemote, navigateToQuickRun },
        },
        {
          provide: QuickRunService,
          useValue: { generateUniqueQuickRunName: (base: string): string => base },
        },
        {
          provide: ModalService,
          useValue: {
            openQuickRunEditor,
            openRemoteConfig,
            openQuickAddRemote,
            openJobDetail,
            isDialogStandalone: (): boolean => standalone,
          },
        },
        {
          provide: BackendTranslationService,
          useValue: { translateBackendMessage: (e: unknown): string => `translated:${String(e)}` },
        },
        { provide: IconService, useValue: { getIconName: (n: string): string => n } },
        { provide: NotificationService, useValue: { showError: vi.fn(), confirmModal } },
        {
          provide: NavigationHistoryService,
          useValue: {
            openLayer: (close: () => void): (() => void) => {
              const release = vi.fn();
              layers.push({ close, release });
              return release;
            },
          },
        },
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
    const component = TestBed.runInInjectionContext(() => new WizardState());
    await component.load();
    return component;
  };

  /** From the folders to the review, through the schedule step when there is one. */
  const toReview = (component: WizardState): void => {
    component.afterWhere();
    if (component.step() === 'when') component.toReview();
  };

  /** Lets the fire-and-forget measurements and folder loads settle. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    mountPluginMissing.set(false);
    mountPluginCheckSkipped.set(false);
    close.mockReset();
    openRemoteInFiles.mockReset();
    openQuickRunEditor.mockReset();
    openRemoteConfig.mockReset();
    openQuickAddRemote.mockReset();
    openJobDetail.mockReset();
    standalone = false;
    layers = [];
    confirmModal.mockReset().mockResolvedValue(true);
    navigateToRemote.mockReset();
    navigateToQuickRun.mockReset();
    for (const fn of Object.values(wizard)) fn.mockReset();
    wizard.loadEnvironment.mockResolvedValue(ENV);
    wizard.loadSetups.mockResolvedValue([]);
    wizard.cloudUsage.mockResolvedValue({ used: 180, free: 20 });
    wizard.localFree.mockResolvedValue(60);
    wizard.folderSize.mockResolvedValue(10);
    wizard.localFolders.mockResolvedValue(['Documents', 'Notes']);
    wizard.defaultLocalPath.mockResolvedValue('/home/me/drive');
    wizard.presets.mockReturnValue({ vfs: { vfs_cache_mode: 'full' }, mount: {} });
    wizard.settings.mockResolvedValue({
      afterRemote: true,
      setting: 'quick_run',
      destination: 'quick_run',
    });
    wizard.saveAfterRemote.mockResolvedValue(undefined);
    wizard.saveDestination.mockResolvedValue(undefined);
    wizard.saveShowMascot.mockResolvedValue(undefined);
    wizard.network.mockResolvedValue({ hostName: 'my-pc', addresses: ['192.168.1.20'] });
    wizard.portFree.mockResolvedValue(true);
    wizard.nextFreePort.mockResolvedValue(8081);
  });

  it('starts with the remote that was just created, with its real usage', async () => {
    const component = await create({ remoteName: 'onedrive' });
    await settle();
    expect(component.remoteName()).toBe('onedrive');
    expect(component.cloud()).toEqual({ used: 180, free: 20 });
    expect(component.appBrand()).toBe('OneDrive');
  });

  it('knows it opened by itself because a cloud was just added, and not when asked for', async () => {
    expect((await create({ remoteName: 'onedrive' })).openedAfterCloud).toBe(true);
    TestBed.resetTestingModule();
    expect((await create()).openedAfterCloud).toBe(false);
  });

  it('falls back to the first remote and reports a failed load', async () => {
    const component = await create({ remoteName: 'gone' });
    expect(component.remoteName()).toBe('drive');

    TestBed.resetTestingModule();
    wizard.loadEnvironment.mockRejectedValue(new Error('down'));
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
    expect(wizard.defaultLocalPath).toHaveBeenCalledWith('drive', 'mount');
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
      // The field holds what the wizard suggested.
      expect(component.cloudGroup.controls.path.value).toBe('Documents');
      // The folder is measured when typing pauses, not on every key.
      expect(wizard.folderSize).not.toHaveBeenCalled();
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
      wizard.folderSize.mockClear();
      for (const text of ['/h', '/ho', '/home', '/home/me/Docs']) {
        component.localGroup.controls.path.setValue(text);
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(600);
      expect(wizard.folderSize).toHaveBeenCalledTimes(1);
      expect(wizard.folderSize).toHaveBeenCalledWith('/home/me/Docs');
      expect(component.localPath()).toBe('/home/me/Docs');
    } finally {
      vi.useRealTimers();
    }
  });

  it('measures the cloud folder once when typing pauses, whether typed or suggested', async () => {
    vi.useFakeTimers();
    try {
      const component = await create();
      component.chooseGoal('devices');
      await settle();
      wizard.folderSize.mockClear();
      for (const text of ['/home/me/D', '/home/me/Do', '/home/me/Docs']) {
        component.localGroup.controls.path.setValue(text);
        await vi.advanceTimersByTimeAsync(100);
      }
      // The suggested cloud folder follows the typing, but no size is asked for in the middle of it.
      expect(component.remotePath()).toBe('Docs');
      expect(wizard.folderSize).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(wizard.folderSize).toHaveBeenCalledTimes(1);
      expect(wizard.folderSize).toHaveBeenCalledWith('drive:Docs');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a folder suggestion that arrives after the step was left', async () => {
    const component = await create();
    let late!: (path: string) => void;
    wizard.defaultLocalPath.mockReturnValueOnce(new Promise<string>(resolve => (late = resolve)));
    component.chooseGoal('access');
    component.back();
    wizard.defaultLocalPath.mockResolvedValueOnce('');
    component.chooseGoal('access');
    await settle();
    late('/home/me/old-suggestion');
    await settle();
    expect(component.localPath()).toBe('');
  });

  it('names what the local folder is for, and marks the home folder it ends in', async () => {
    const component = await create();
    component.chooseGoal('devices');
    await settle();
    expect(component.localWhereKey()).toBe('devices');
    component.chooseHomeFolder('Documents');
    expect(component.localFolderName()).toBe('Documents');

    component.back();
    component.chooseGoal('access');
    await settle();
    expect(component.localWhereKey()).toBe('stream');
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

  it('opens the file browser before closing a wizard that has a window of its own', async () => {
    standalone = true;
    const calls: string[] = [];
    openRemoteInFiles.mockImplementation(async () => void calls.push('open'));
    close.mockImplementation(() => void calls.push('close'));
    const component = await create();
    component.chooseGoal('explore');
    component.answer('browse');
    await settle();
    expect(calls).toEqual(['open', 'close']);
  });

  describe('the back button of the system', () => {
    /** The effect that keeps the entries in step with the screens runs on a change detection pass. */
    const sync = async (): Promise<void> => {
      TestBed.tick();
      await settle();
    };

    it('opens one history entry for each step forward and gives them back going back', async () => {
      const component = await create();
      await sync();
      expect(layers).toHaveLength(0);

      component.chooseGoal('backup');
      await sync();
      expect(layers).toHaveLength(1);

      component.answer('keep');
      await settle();
      await sync();
      expect(component.step()).toBe('where');
      expect(layers).toHaveLength(2);

      component.back();
      await sync();
      expect(layers[1].release).toHaveBeenCalledTimes(1);
      expect(layers[0].release).not.toHaveBeenCalled();
    });

    it('goes one step back, not out of the wizard, when the system takes an entry away', async () => {
      const component = await create();
      component.chooseGoal('backup');
      component.answer('keep');
      await settle();
      await sync();
      expect(component.step()).toBe('where');

      layers[1].close();
      expect(component.step()).toBe('question');
      expect(close).not.toHaveBeenCalled();
      await sync();
      // The entry the system took is not given back a second time.
      expect(layers).toHaveLength(2);
    });

    it('closes the wizard settings first', async () => {
      const component = await create();
      component.chooseGoal('backup');
      await sync();
      component.toggleSettings();
      await sync();
      expect(layers).toHaveLength(2);

      layers[1].close();
      expect(component.settingsOpen()).toBe(false);
      expect(component.step()).toBe('question');
    });

    it('keeps the screen while it saves, and puts the entry back', async () => {
      const component = await create();
      component.step.set('working');
      await sync();
      const before = layers.length;
      layers[before - 1].close();
      expect(component.step()).toBe('working');
      await settle();
      // One new entry stands in for the one the system took.
      expect(layers.length).toBe(before + 1);
      expect(layers[before].release).not.toHaveBeenCalled();
    });

    it('lets the system go back from the end to the first screen', async () => {
      const component = await create();
      component.chooseGoal('download');
      await settle();
      toReview(component);
      wizard.apply.mockResolvedValue({
        quickRun: { id: 'qr', name: 'n' },
        execution: { executeId: 'e' },
      });
      await component.apply();
      expect(component.step()).toBe('done');
      await sync();
      expect(layers.filter(l => l.release.mock.calls.length === 0)).toHaveLength(1);

      layers[layers.length - 1].close();
      expect(component.step()).toBe('goal');
    });

    it('gives every entry back when the wizard goes away', async () => {
      const component = await create();
      component.chooseGoal('backup');
      component.answer('keep');
      await settle();
      await sync();
      TestBed.resetTestingModule();
      expect(layers.every(l => l.release.mock.calls.length === 1)).toBe(true);
      expect(component.step()).toBe('where');
    });
  });

  describe('the end of the wizard', () => {
    it('opens the cloud folder of a backup as drive:folder, never as a folder on this computer', async () => {
      const component = await create();
      component.chooseGoal('backup');
      component.answer('keep');
      await settle();
      component.localGroup.controls.path.setValue('/home/me/Docs');
      component.afterWhere();
      expect(component.remotePath()).toBe('Docs');
      await component.openInFiles();
      expect(openRemoteInFiles).toHaveBeenCalledWith('drive', 'drive:Docs');
    });

    it('opens the cloud a move goes to, not the one it comes from', async () => {
      const component = await create();
      component.chooseGoal('migrate');
      component.answer('keep');
      await settle();
      component.targetGroup.controls.path.setValue('old');
      expect(component.browseTarget()).toEqual({ remote: 'onedrive', path: 'old' });
      await component.openInFiles();
      expect(openRemoteInFiles).toHaveBeenCalledWith('onedrive', 'onedrive:old');
    });

    it('says where the cloud button goes in words, and leads with the run of a check', async () => {
      const component = await create();
      component.chooseGoal('explore');
      component.answer('compareClouds');
      await settle();
      expect(component.browseLabel()).toBe('');
      expect(component.doneMain()).toBe('where');

      const backup = await (async (): Promise<WizardState> => {
        TestBed.resetTestingModule();
        const c = await create();
        c.chooseGoal('migrate');
        c.answer('keep');
        await settle();
        c.targetGroup.controls.path.setValue('old');
        return c;
      })();
      expect(backup.browseLabel()).toBe('onedrive › old');
    });

    it('has no cloud to browse after a check, and says what a check does', async () => {
      const component = await create();
      component.chooseGoal('explore');
      component.answer('compare');
      await settle();
      expect(component.browseTarget()).toBeNull();
      expect(component.doneKey()).toBe('checkStarted');
      await component.openInFiles();
      expect(openRemoteInFiles).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });

    it('compares two clouds as they are, without a folder named after the first', async () => {
      const component = await create();
      component.chooseGoal('explore');
      component.answer('compareClouds');
      await settle();
      expect(component.targetPath()).toBe('');
      expect(component.browseTarget()).toBeNull();
      expect(component.doneKey()).toBe('checkStarted');
    });

    it('still copies into a folder named after the cloud it comes from', async () => {
      const component = await create();
      component.chooseGoal('migrate');
      component.answer('keep');
      await settle();
      expect(component.targetPath()).toBe('drive');
    });

    it('shows the run of a check', async () => {
      const job = { jobid: 7, execute_id: 'e1' };
      wizard.job.mockReturnValue(job);
      const component = await create();
      component.chooseGoal('explore');
      component.answer('compareClouds');
      await settle();
      component.afterWhere();
      wizard.apply.mockResolvedValue({
        destination: 'quick_run',
        name: 'drive check',
        quickRun: { id: 'qr' },
        execution: { executeId: 'e1' },
      });
      await component.apply();
      expect(component.step()).toBe('done');
      expect(component.resultJob()).toBe(job);
      component.openRun();
      expect(close).toHaveBeenCalled();
      expect(openJobDetail).toHaveBeenCalledWith(job);
    });

    it('has no run to show for a mount', async () => {
      wizard.job.mockReturnValue({ jobid: 7, execute_id: 'e1' });
      const component = await create();
      component.chooseGoal('access');
      await settle();
      toReview(component);
      wizard.apply.mockResolvedValue({
        destination: 'quick_run',
        name: 'mount',
        quickRun: { id: 'qr2' },
        execution: { executeId: 'e1' },
      });
      await component.apply();
      expect(component.resultJob()).toBeUndefined();
    });

    it('says why a setup could not be taken back, in the words of the app', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const component = await create();
      component.chooseGoal('backup');
      component.answer('keep');
      await settle();
      component.localGroup.controls.path.setValue('/home/me/Docs');
      toReview(component);
      wizard.apply.mockResolvedValue({
        destination: 'quick_run',
        name: 'drive backup',
        quickRun: { id: 'qr' },
        execution: null,
      });
      await component.apply();
      wizard.undo.mockRejectedValue('device busy');
      await component.undo();
      expect(component.undoState()).toBe('failed');
      expect(component.undoReason()).toBe('translated:device busy');
    });

    it('reads what is set up again once something was added or taken back', async () => {
      const component = await create();
      component.chooseGoal('backup');
      component.answer('keep');
      await settle();
      component.localGroup.controls.path.setValue('/home/me/Docs');
      toReview(component);
      wizard.loadSetups.mockClear();
      wizard.apply.mockResolvedValue({
        destination: 'quick_run',
        name: 'drive backup',
        quickRun: { id: 'qr' },
        execution: null,
      });
      await component.apply();
      await settle();
      expect(wizard.loadSetups).toHaveBeenCalledTimes(1);

      wizard.undo.mockResolvedValue(undefined);
      await component.undo();
      await settle();
      expect(wizard.loadSetups).toHaveBeenCalledTimes(2);
    });
  });

  it('draws the review in the colour, icon and direction of its operation', async () => {
    const component = await create();
    component.chooseGoal('devices');
    await settle();
    expect(component.operationTone()).toBe('purple');
    expect(component.operationIcon()).toBe('right-left');
    expect(component.flowDirection()).toBe('both');
  });

  it('draws a backup one way', async () => {
    const backup = await create();
    backup.chooseGoal('backup');
    backup.answer('keep');
    await settle();
    expect(backup.flowDirection()).toBe('right');
  });

  it('draws a mount as a link, not as a copy', async () => {
    const component = await create();
    component.chooseGoal('access');
    await settle();
    expect(component.flowDirection()).toBe('link');
    expect(component.operationIcon()).toBe('mount');
  });

  it('draws a check without a direction', async () => {
    const component = await create();
    component.chooseGoal('explore');
    component.answer('compare');
    await settle();
    expect(component.flowDirection()).toBe('none');
    expect(component.operationTone()).toBe('accent');
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
    const toShare = async (device: 'tv' | 'folder' | 'browser'): Promise<WizardState> => {
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
        wizard.portFree.mockResolvedValue(false);
        const component = await toShare('folder');
        component.sharePassword.set('secret');
        await vi.advanceTimersByTimeAsync(10);
        expect(wizard.portFree).toHaveBeenCalledWith(8080);
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
        expect(wizard.nextFreePort).not.toHaveBeenCalled();
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
        wizard.portFree.mockResolvedValue(false);
        wizard.nextFreePort.mockResolvedValue(9091);

        component.setSharePort(9090);
        await vi.advanceTimersByTimeAsync(600);
        expect(component.sharePort()).toBe(9090);
        expect(component.sharePortBusy()).toBe(true);
        expect(component.freePortSuggestion()).toBe(9091);
        expect(component.whereValid()).toBe(false);

        wizard.portFree.mockResolvedValue(true);
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
        wizard.portFree.mockClear();
        for (const port of [9, 90, 909, 9090]) {
          component.setSharePort(port);
          await vi.advanceTimersByTimeAsync(100);
        }
        await vi.advanceTimersByTimeAsync(600);
        expect(wizard.portFree).toHaveBeenCalledTimes(1);
        expect(wizard.portFree).toHaveBeenCalledWith(9090);
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats an unknown answer as a free port', async () => {
      vi.useFakeTimers();
      try {
        wizard.portFree.mockResolvedValue(null);
        const component = await toShare('folder');
        component.sharePassword.set('secret');
        await vi.advanceTimersByTimeAsync(600);
        expect(component.sharePortBusy()).toBe(false);
        expect(component.whereValid()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows where to connect, with the port and the user, and says once what devices may do', async () => {
      const component = await toShare('folder');
      component.sharePassword.set('secret');
      component.setSharePort(9090);
      const keys = component.details().map(d => d.key);
      expect(keys).toEqual(['address', 'address', 'port', 'user']);
      expect(component.details()[0].value).toBe('http://192.168.1.20:9090');

      expect(component.effects().map(e => e.key)).toContain('shareReadOnly');
      component.shareReadOnly.set(false);
      expect(component.details().map(d => d.key)).toEqual(keys);
      expect(component.effects().map(e => e.key)).toContain('shareWrite');
    });

    it('sets the share up with the chosen port and read-only access', async () => {
      const component = await toShare('folder');
      component.sharePassword.set('secret');
      component.setSharePort(9090);
      component.afterWhere();
      expect(component.step()).toBe('review');
      wizard.apply.mockResolvedValue({
        quickRun: { id: 'qr', name: 'n' },
        execution: { serveAddr: '[::]:9090' },
      });
      await component.apply();
      expect(wizard.apply.mock.calls[0][0].config.rclone).toEqual({
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
      wizard.network.mockResolvedValue(null);
      const component = await toShare('folder');
      component.sharePassword.set('secret');
      expect(component.details().map(d => d.key)).toEqual(['addressUnknown', 'port', 'user']);
      component.afterWhere();
      wizard.apply.mockResolvedValue({ quickRun: { id: 'qr', name: 'n' }, execution: null });
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
      expect(component.details().map(d => d.key)).toEqual(['address', 'address', 'port', 'user']);
      component.afterWhere();
      wizard.apply.mockResolvedValue({
        quickRun: { id: 'qr', name: 'n' },
        execution: { serveAddr: '[::]:8080' },
      });
      await component.apply();
      expect(wizard.apply.mock.calls[0][0].config.rclone).toMatchObject({
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
      wizard.apply.mockResolvedValue({ quickRun: { id: 'qr', name: 'n' }, execution: null });
      await component.apply();
      expect(wizard.apply.mock.calls[0][0].config.rclone).toEqual({
        fs: 'drive:',
        type: 'dlna',
        name: 'Living room',
      });
      expect(component.doneKey()).toBe('shareDlna');
    });

    it('does not look up the network for anything but a share', async () => {
      wizard.network.mockClear();
      const component = await create();
      component.chooseGoal('backup');
      component.answer('keep');
      await settle();
      expect(wizard.network).not.toHaveBeenCalled();
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
    wizard.presets.mockReturnValue({
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

  it('picks the other remote to check a cloud against and does not ask for a folder', async () => {
    const component = await create();
    component.chooseGoal('explore');
    component.answer('compareClouds');
    await settle();
    expect(component.step()).toBe('where');
    expect(component.plan()?.flow).toBe('cloudCompare');
    expect(component.showsLocal()).toBe(false);
    expect(component.targetRemote()).toBe('onedrive');
    expect(component.whereValid()).toBe(true);
  });

  it('summarises what the dry run found and tolerates a failed one', async () => {
    const component = await create();
    component.chooseGoal('download');
    await settle();
    toReview(component);
    expect(component.step()).toBe('review');

    const files = Array.from({ length: 120 }, (_, i) => ({ path: `old-${i}.txt` }));
    wizard.preview.mockResolvedValue({
      counts: { transfers: 3, bytes: 1200, deletes: 120, errors: 0 },
      matched: 7,
      fileLevel: true,
      groups: [
        { kind: 'delete', files, bytes: 0 },
        { kind: 'add', files: [{ path: 'new.txt', size: 10 }], bytes: 10 },
      ],
    });
    await component.runPreview();

    expect(component.preview().state).toBe('done');
    // The files to be deleted are the one list the user must see; the rest of them are counted.
    expect(component.previewDeleted()?.files).toHaveLength(50);
    expect(component.previewDeleted()?.more).toBe(70);

    expect(wizard.preview.mock.calls[0][0]).toMatchObject({
      operationType: 'copy',
      config: { rclone: { srcFs: 'drive:', dstFs: '/home/me/drive' } },
    });

    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    wizard.preview.mockRejectedValue(new Error('denied'));
    await component.runPreview();
    expect(component.preview().state).toBe('failed');
    // The reason is kept for whoever reads the log; the screen offers another try.
    expect(logged).toHaveBeenCalledWith('[Wizard] The dry run failed:', expect.any(Error));
    logged.mockRestore();
    wizard.preview.mockResolvedValue({
      counts: { transfers: 0, bytes: 0, deletes: 0, errors: 0 },
      matched: 0,
      fileLevel: true,
      groups: [],
    });
    await component.runPreview();
    expect(component.preview().state).toBe('done');
  });

  it('shows no deleted files when the dry run would change nothing', async () => {
    const component = await create();
    component.chooseGoal('download');
    await settle();
    toReview(component);
    wizard.preview.mockResolvedValue({
      counts: { transfers: 0, bytes: 0, deletes: 0, errors: 0 },
      matched: 12,
      fileLevel: true,
      groups: [],
    });
    await component.runPreview();
    expect(component.previewDeleted()).toBeNull();
  });

  it('cancels a running preview', async () => {
    const component = await create();
    component.preview.set({ state: 'running', executeId: 'exec-1' });
    await component.cancelPreview();
    expect(component.preview().state).toBe('idle');
    expect(wizard.cancel).toHaveBeenCalledWith('exec-1');
  });

  it('sets the mount up, turns on start with the system and lands on done', async () => {
    const component = await create();
    component.chooseGoal('access');
    await settle();
    component.afterWhere();
    expect(component.step()).toBe('when');
    expect(component.offersStartOnLogin()).toBe(true);
    component.toReview();
    wizard.apply.mockResolvedValue({
      quickRun: { id: 'qr', name: 'n' },
      execution: { mountPoint: '/home/me/drive' },
    });

    await component.apply();

    expect(wizard.apply).toHaveBeenCalledWith(
      expect.objectContaining({ operationType: 'mount' }),
      expect.objectContaining({ flow: 'stream' }),
      expect.objectContaining({ startOnLogin: true })
    );
    expect(component.step()).toBe('done');
    expect(component.doneKey()).toBe('stream');
    expect(component.openablePath()).toBe('/home/me/drive');
  });

  describe("the wizard's settings", () => {
    it('reads them when it opens', async () => {
      wizard.settings.mockResolvedValue({
        afterRemote: false,
        setting: 'profile',
        destination: 'profile',
      });
      const component = await create();
      component.init();
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

    it('saves whether the wizard follows a new cloud', async () => {
      const component = await create();
      component.setAfterRemote(false);
      expect(component.afterRemote()).toBe(false);
      expect(wizard.saveAfterRemote).toHaveBeenCalledWith(false);
    });

    it('saves whether the mascot is shown, off by default', async () => {
      const component = await create();
      expect(component.showMascot()).toBe(false);
      component.setShowMascot(true);
      expect(component.showMascot()).toBe(true);
      expect(wizard.saveShowMascot).toHaveBeenCalledWith(true);
    });

    it('saves the destination and uses it for what the wizard sets up from now on', async () => {
      wizard.resolveDestination.mockResolvedValue('profile');
      const component = await create();
      await component.setDestinationSetting('profile');
      expect(wizard.saveDestination).toHaveBeenCalledWith('profile');
      expect(component.destinationSetting()).toBe('profile');
      expect(component.destination()).toBe('profile');
    });
  });

  describe('a setup that already exists', () => {
    const setup = {
      key: 'quick_run:qr-1',
      kind: 'quick_run',
      id: 'qr-1',
      name: 'Docs backup',
      remoteName: 'drive',
      operationType: 'copy',
      signature: 'upload|/home/me/Docs|drive|Docs||',
    };

    it('works without the list when it cannot be read', async () => {
      wizard.loadSetups.mockRejectedValue(new Error('no settings'));
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

    it('points out a setup that already does what the review shows', async () => {
      wizard.loadSetups.mockResolvedValue([setup]);
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
    const toDone = async (): Promise<WizardState> => {
      const component = await create();
      component.chooseGoal('access');
      await settle();
      toReview(component);
      wizard.apply.mockResolvedValue({
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
      expect(wizard.undo).not.toHaveBeenCalled();
      expect(component.undoState()).toBe('idle');
    });

    it('removes what was set up and says so', async () => {
      const component = await toDone();
      wizard.undo.mockResolvedValue(undefined);
      await component.undo();
      expect(wizard.undo).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'drive folder' }),
        'drive',
        'mount'
      );
      expect(component.undoState()).toBe('removed');
    });

    it('reports a failure and lets the user try again', async () => {
      const component = await toDone();
      wizard.undo.mockRejectedValue(new Error('busy'));
      await component.undo();
      expect(component.undoState()).toBe('failed');
      wizard.undo.mockResolvedValue(undefined);
      await component.undo();
      expect(component.undoState()).toBe('removed');
    });

    it('starts clean when another setup begins', async () => {
      const component = await toDone();
      wizard.undo.mockResolvedValue(undefined);
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
    wizard.apply.mockResolvedValue({
      destination: 'quick_run',
      name: 'drive sync',
      quickRun: { id: 'qr', name: 'drive sync' },
      execution: { executeId: 'exec-1' },
      firstRunDone: false,
    });
    wizard.job.mockReturnValue({ error: "  couldn't reach the cloud  " });
    await component.apply();
    expect(component.doneKey()).toBe('twoWayFailed');
    expect(component.failureReason()).toBe("couldn't reach the cloud");

    wizard.apply.mockResolvedValue({
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
    const toMountReview = async (): Promise<WizardState> => {
      const component = await create();
      component.chooseGoal('access');
      await settle();
      toReview(component);
      return component;
    };

    it('starts from the setting and lets the review change it for this run', async () => {
      wizard.settings.mockResolvedValue({
        afterRemote: true,
        setting: 'auto',
        destination: 'profile',
      });
      const component = await create();
      component.init();
      await settle();
      expect(component.destination()).toBe('profile');
      expect(component.destinationSetting()).toBe('auto');

      component.chooseGoal('access');
      await settle();
      toReview(component);
      component.destination.set('quick_run');
      wizard.apply.mockResolvedValue({
        destination: 'quick_run',
        name: 'n',
        quickRun: { id: 'qr', name: 'n' },
        execution: {},
      });
      await component.apply();

      expect(wizard.apply).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ destination: 'quick_run' })
      );
    });

    it('shows a profile on the remote page of its tab', async () => {
      const component = await toMountReview();
      wizard.apply.mockResolvedValue({ destination: 'profile', name: 'n', execution: {} });
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
      wizard.apply.mockResolvedValue({
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
    wizard.apply.mockResolvedValue(null);
    await component.apply();
    expect(component.step()).toBe('review');
    expect(component.applyFailed()).toBe(true);
  });

  describe('on Android', () => {
    const phone = { ...ENV, isAndroid: true };

    it('opens the Files app for a mount that lives there', async () => {
      wizard.loadEnvironment.mockResolvedValue(phone);
      wizard.presets.mockReturnValue({ vfs: {}, mount: { mountType: 'saf' } });
      const component = await create();
      component.chooseGoal('access');
      await settle();
      expect(component.usesSaf()).toBe(true);
      expect(component.openablePath()).toBe('saf://drive');
      expect(component.doneMain()).toBe('folder');

      await component.openFolder();
      expect(wizard.openFolder).toHaveBeenCalledWith('saf://drive');
    });

    it('has no folder to open for anything else on a phone', async () => {
      wizard.loadEnvironment.mockResolvedValue(phone);
      const component = await create();
      component.chooseGoal('download');
      await settle();
      expect(component.openablePath()).toBeNull();
    });
  });

  it('draws this machine as a monitor, a phone or a server, never as the mobile data switch', async () => {
    const desktop = await create();
    expect(desktop.localPlaceIcon()).toBe('desktop');

    TestBed.resetTestingModule();
    wizard.loadEnvironment.mockResolvedValue({ ...ENV, isAndroid: true });
    expect((await create()).localPlaceIcon()).toBe('smartphone');

    TestBed.resetTestingModule();
    wizard.loadEnvironment.mockResolvedValue({ ...ENV, isServer: true });
    expect((await create()).localPlaceIcon()).toBe('server');
  });

  it('lists what can lose files first, and keeps the order of the rest', async () => {
    const component = await create();
    component.chooseGoal('access');
    await settle();
    const keys = component.effects().map(e => e.key);
    // A mount deletes in the cloud what is deleted here: that line leads.
    expect(keys[0]).toBe('streamDelete');
    expect(keys.slice(1)).toEqual(['streamOpen', 'streamSave']);
  });

  it('does not offer to open a folder on a server', async () => {
    wizard.loadEnvironment.mockResolvedValue({ ...ENV, isServer: true });
    const component = await create();
    component.chooseGoal('download');
    await settle();
    expect(component.localPlace()).toBe('server');
    expect(component.openablePath()).toBeNull();
  });

  it('calls any machine that is not a server "this device": it may be a Mac, a PC or a phone', async () => {
    const desktop = await create();
    expect(desktop.localPlace()).toBe('thisDevice');

    TestBed.resetTestingModule();
    wizard.loadEnvironment.mockResolvedValue({ ...ENV, isAndroid: true });
    const phone = await create();
    expect(phone.localPlace()).toBe('thisDevice');
  });

  describe('a mount without the mount plugin', () => {
    const planMount = async (missing: boolean, skipped = false): Promise<WizardState> => {
      mountPluginMissing.set(missing);
      mountPluginCheckSkipped.set(skipped);
      wizard.loadEnvironment.mockResolvedValue(ENV);
      const component = await create();
      component.chooseGoal('access');
      await settle();
      return component;
    };

    it('warns and blocks while the plugin check is on', async () => {
      const component = await planMount(true);
      expect(component.needsMountPlugin()).toBe(true);
      expect(component.blockedByMountPlugin()).toBe(true);
    });

    it('still warns but does not block when the plugin check is turned off', async () => {
      const component = await planMount(true, true);
      expect(component.needsMountPlugin()).toBe(true);
      expect(component.blockedByMountPlugin()).toBe(false);
    });

    it('does not warn when the plugin is there', async () => {
      const component = await planMount(false);
      expect(component.needsMountPlugin()).toBe(false);
      expect(component.blockedByMountPlugin()).toBe(false);
    });

    it('drops the warning and the block as soon as the plugin gets installed', async () => {
      const component = await planMount(true);
      expect(component.blockedByMountPlugin()).toBe(true);

      mountPluginMissing.set(false);

      expect(component.needsMountPlugin()).toBe(false);
      expect(component.blockedByMountPlugin()).toBe(false);
    });
  });

  describe('a mount on Windows', () => {
    const windows = { ...ENV, canUseDriveLetter: true };

    it('goes to a drive letter by default and says so', async () => {
      wizard.loadEnvironment.mockResolvedValue(windows);
      wizard.defaultLocalPath.mockResolvedValue('Z:');
      const component = await create();
      component.chooseGoal('access');
      await settle();
      expect(component.usesDriveLetter()).toBe(true);
      expect(component.localPath()).toBe('Z:');
      expect(component.localIsDrive()).toBe(true);
      expect(component.summaryKey()).toBe('streamDrive');
      expect(component.whereAbout()).toBe('streamWindows');
      expect(component.whereValid()).toBe(true);
      // A drive holds the cloud, so there is no folder to measure.
      expect(wizard.localFree).not.toHaveBeenCalledWith('Z:');
    });

    it('lets Windows choose the letter for the automatic drive', async () => {
      wizard.loadEnvironment.mockResolvedValue(windows);
      const component = await create();
      component.chooseGoal('access');
      await settle();
      component.setLocalPath('*');
      expect(component.summaryKey()).toBe('streamAutoDrive');
      expect(component.localLabel()).toBe('modals.wizard.places.automaticDrive');
      // There is no folder to open for a letter nobody has picked yet.
      expect(component.openablePath()).toBeNull();
    });

    it('keeps the plain wording for a folder', async () => {
      wizard.loadEnvironment.mockResolvedValue(windows);
      const component = await create();
      component.chooseGoal('access');
      await settle();
      component.setLocalPath('C:\\Users\\me\\drive');
      expect(component.localIsDrive()).toBe(false);
      expect(component.summaryKey()).toBe('stream');
    });

    it('starts the network drive from the presets and saves what the user chose', async () => {
      wizard.loadEnvironment.mockResolvedValue(windows);
      wizard.presets.mockReturnValue({ vfs: {}, mount: { network_mode: true } });
      const component = await create();
      component.chooseGoal('access');
      await settle();
      expect(component.mountNetworkMode.value).toBe(true);

      component.mountNetworkMode.setValue(false);
      component.mountVolumeName.setValue('My cloud');
      toReview(component);
      wizard.apply.mockResolvedValue({ quickRun: { id: 'qr', name: 'n' }, execution: {} });
      await component.apply();
      const input = wizard.apply.mock.calls[0][0];
      expect(input.config.rclone).toMatchObject({ network_mode: false, volname: 'My cloud' });
    });

    it('does not offer drives anywhere else', async () => {
      const component = await create();
      component.chooseGoal('access');
      await settle();
      expect(component.usesDriveLetter()).toBe(false);
      expect(component.summaryKey()).toBe('stream');
    });
  });

  describe('the full editor', () => {
    const openFor = async (destination: 'quick_run' | 'profile'): Promise<WizardState> => {
      const component = await create();
      component.destination.set(destination);
      component.chooseGoal('devices');
      await settle();
      component.chooseHomeFolder('Notes');
      return component;
    };

    it('opens the Quick Run editor with what was filled in when it is kept as a Quick Run', async () => {
      const component = await openFor('quick_run');
      await component.openAdvanced();
      expect(close).toHaveBeenCalled();
      expect(openRemoteConfig).not.toHaveBeenCalled();
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

    it('opens the profile editor of the remote, with the profile filled in, when it is kept as a profile', async () => {
      const settings = { bisyncConfigs: { 'Drive sync': { app: {}, rclone: { path1: '/a' } } } };
      wizard.planProfile.mockResolvedValue({ name: 'Drive sync', settings });
      const component = await openFor('profile');
      await component.openAdvanced();

      expect(close).toHaveBeenCalled();
      expect(openQuickRunEditor).not.toHaveBeenCalled();
      expect(openRemoteConfig).toHaveBeenCalledWith({
        remoteName: 'drive',
        remoteType: 'drive',
        editTarget: 'bisync',
        targetProfile: 'Drive sync',
        initialProfile: { type: 'bisync', name: 'Drive sync', settings },
      });
    });

    it('falls back to the Quick Run editor for an operation that has no profiles', async () => {
      wizard.planProfile.mockResolvedValue(null);
      const component = await openFor('profile');
      await component.openAdvanced();
      expect(openRemoteConfig).not.toHaveBeenCalled();
      expect(openQuickRunEditor).toHaveBeenCalled();
    });
  });

  describe('when step', () => {
    const toWhen = async (
      goal: 'backup' | 'devices' | 'access' | 'share',
      answer?: string
    ): Promise<WizardState> => {
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
      wizard.apply.mockResolvedValue({ quickRun: { id: 'qr', name: 'n' }, execution: null });
      await component.apply();
      expect(wizard.apply.mock.calls[0][0].config.app).toMatchObject({
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
      component.toggleSchedule('cron');
      expect(component.schedule().cron).toBeNull();
      expect(component.scheduleLines()).toEqual([{ key: 'manual', icon: 'play' }]);
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
      component.toggleSchedule('cron');
      expect(component.needsCloudSchedule()).toBe(true);
    });

    it('sets up exactly the schedule that was chosen', async () => {
      const component = await toWhen('backup', 'keep');
      component.scheduleWatch.set(true);
      component.toReview();
      wizard.apply.mockResolvedValue({ quickRun: { id: 'qr', name: 'n' }, execution: null });
      await component.apply();
      expect(wizard.apply.mock.calls[0][0].config.app).toEqual({
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
      wizard.loadEnvironment.mockResolvedValue({
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
    wizard.loadEnvironment.mockResolvedValue({ ...ENV, remotes: [] });
    const component = await create();
    expect(component.remoteName()).toBe('');
    component.addRemote();
    expect(openQuickAddRemote).toHaveBeenCalled();
  });
});
