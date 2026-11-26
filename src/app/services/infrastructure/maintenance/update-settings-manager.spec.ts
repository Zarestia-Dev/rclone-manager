import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { BackendUpdateStatus, UpdateInfo } from '@app/types';
import { AppSettingsService } from '../../settings/app-settings.service';
import { NotificationService } from '../../ui/notification.service';
import { UpdateSettingsManager, isUpdateInFlight } from './update-settings-manager';

describe('UpdateSettingsManager availability', () => {
  const saveSetting = vi.fn();
  const showError = vi.fn();

  function createManager(stored: Record<string, unknown>): UpdateSettingsManager {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AppSettingsService,
          useValue: {
            getSettingValue: vi.fn(async (key: string) => stored[key.split('.')[1]] ?? null),
            saveSetting,
          },
        },
        { provide: NotificationService, useValue: { showError } },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
      ],
    });
    return TestBed.runInInjectionContext(
      () =>
        new UpdateSettingsManager({
          namespace: 'runtime',
          skippedVersionsKey: 'skipped',
          updateChannelKey: 'channel',
          autoCheckKey: 'auto',
        })
    );
  }

  beforeEach(() => {
    saveSetting.mockReset().mockResolvedValue(undefined);
    showError.mockReset();
  });

  it('retains a skipped version while downloading, installing or waiting for restart', async () => {
    const settings = createManager({ skipped: ['1.2.0'] });
    await settings.initialize();
    const info: UpdateInfo = {
      version: '1.2.0',
      currentVersion: '1.1.0',
      updateAvailable: true,
      status: BackendUpdateStatus.Available,
    };
    expect(settings.computeAvailableUpdate(null)).toBeNull();
    expect(settings.computeAvailableUpdate(info)).toBeNull();
    for (const status of [
      BackendUpdateStatus.Downloading,
      BackendUpdateStatus.Installing,
      BackendUpdateStatus.ReadyToRestart,
    ]) {
      expect(settings.computeAvailableUpdate({ ...info, status })?.status).toBe(status);
    }
    expect(settings.computeAvailableUpdate({ ...info, version: '1.3.0' })?.version).toBe('1.3.0');
  });

  it('reads an unknown stored channel as stable, as the backend does', async () => {
    const settings = createManager({ channel: 'nightly' });
    await settings.initialize();
    expect(settings.updateChannel()).toBe('stable');
  });

  it('saves the new skipped list and keeps the old one when saving fails', async () => {
    const settings = createManager({ skipped: ['1.0.0'] });
    await settings.initialize();
    expect(await settings.skipVersion('1.1.0')).toBe(true);
    expect(saveSetting).toHaveBeenCalledWith('runtime', 'skipped', ['1.0.0', '1.1.0']);
    expect(settings.skippedVersions()).toEqual(['1.0.0', '1.1.0']);

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    saveSetting.mockRejectedValueOnce(new Error('disk full'));
    expect(await settings.unskipVersion('1.0.0')).toBe(false);
    expect(settings.skippedVersions()).toEqual(['1.0.0', '1.1.0']);
    expect(showError).toHaveBeenCalledWith('modals.about.updateSettingFailed');
  });
});

describe('isUpdateInFlight', () => {
  it('is true only while a download, installation or staged update is active', () => {
    expect(isUpdateInFlight(BackendUpdateStatus.Downloading)).toBe(true);
    expect(isUpdateInFlight(BackendUpdateStatus.Installing)).toBe(true);
    expect(isUpdateInFlight(BackendUpdateStatus.ReadyToRestart)).toBe(true);
    expect(isUpdateInFlight(BackendUpdateStatus.Available)).toBe(false);
    expect(isUpdateInFlight(undefined)).toBe(false);
  });
});
