import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { BackendUpdateStatus, UpdateInfo } from '@app/types';
import { AppSettingsService } from '../../settings/app-settings.service';
import { UpdateSettingsManager } from './update-settings-manager';

describe('UpdateSettingsManager availability', () => {
  it('retains a skipped version while downloading, installing or waiting for restart', async () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AppSettingsService,
          useValue: {
            getSettingValue: vi.fn(async (key: string) =>
              key.endsWith('skipped') ? ['1.2.0'] : null
            ),
          },
        },
      ],
    });
    const settings = new UpdateSettingsManager(TestBed.inject(AppSettingsService), {
      namespace: 'runtime',
      skippedVersionsKey: 'skipped',
      updateChannelKey: 'channel',
      autoCheckKey: 'auto',
    });
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
});
