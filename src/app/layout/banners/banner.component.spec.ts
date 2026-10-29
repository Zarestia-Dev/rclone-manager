import { CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslatePipe } from '@ngx-translate/core';
import { EMPTY } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BannerComponent } from './banner.component';
import { EventListenersService } from 'src/app/services/infrastructure/system/event-listeners.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { AppUpdaterService } from 'src/app/services/infrastructure/maintenance/app-updater.service';
import { AndroidKeepAliveService } from 'src/app/services/infrastructure/platform/android-keep-alive.service';
import { AndroidStorageAccessService } from 'src/app/services/infrastructure/platform/android-storage-access.service';

describe('BannerComponent collapsed content', () => {
  let fixture: ComponentFixture<BannerComponent>;
  const buildType = signal('flatpak');
  const showBatteryOptimizationPrompt = signal(false);
  const androidKeepAlive = {
    showBatteryOptimizationPrompt,
    requestIgnoreBatteryOptimizations: vi.fn(),
    dismissBatteryOptimizationPrompt: vi.fn(),
  };
  const showAllFilesAccessPrompt = signal(false);
  const androidStorageAccess = {
    showAllFilesAccessPrompt,
    requestAllFilesAccess: vi.fn(),
    dismissAllFilesAccessPrompt: vi.fn(),
  };

  beforeEach(() => {
    buildType.set('flatpak');
    showBatteryOptimizationPrompt.set(false);
    androidKeepAlive.requestIgnoreBatteryOptimizations.mockClear();
    androidKeepAlive.dismissBatteryOptimizationPrompt.mockClear();
    showAllFilesAccessPrompt.set(false);
    androidStorageAccess.requestAllFilesAccess.mockClear();
    androidStorageAccess.dismissAllFilesAccessPrompt.mockClear();
    TestBed.configureTestingModule({
      imports: [BannerComponent],
      providers: [
        provideTranslateService(),
        {
          provide: EventListenersService,
          useValue: {
            listenToEngineErrorState: (): typeof EMPTY => EMPTY,
            listenToNetworkStatusChanged: (): typeof EMPTY => EMPTY,
          },
        },
        {
          provide: AppSettingsService,
          useValue: {
            options: signal({ 'runtime.flatpak_warn': { value: true } }),
            saveSetting: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SystemInfoService,
          useValue: {
            minRcloneVersion: signal('1.70'),
            isNetworkMetered: vi.fn().mockResolvedValue(false),
          },
        },
        { provide: AppUpdaterService, useValue: { buildType } },
        { provide: AndroidKeepAliveService, useValue: androidKeepAlive },
        { provide: AndroidStorageAccessService, useValue: androidStorageAccess },
      ],
    }).overrideComponent(BannerComponent, {
      set: { imports: [TranslatePipe], schemas: [CUSTOM_ELEMENTS_SCHEMA] },
    });
    fixture = TestBed.createComponent(BannerComponent);
    fixture.componentInstance.showDevelopmentBanner.set(false);
    fixture.detectChanges();
  });

  it('keeps a visible warning and its link interactive', () => {
    const banner: HTMLElement = fixture.nativeElement.querySelector('.flatpak-warning-banner');
    expect(banner.inert).toBe(false);
    expect(banner.getAttribute('aria-hidden')).toBe('false');
    expect(banner.querySelector('a[href]')).not.toBeNull();
  });

  it('makes dismissed warning actions inert and hides them from assistive technology', async () => {
    await fixture.componentInstance.dismissFlatpakWarning();
    fixture.detectChanges();
    const banner: HTMLElement = fixture.nativeElement.querySelector('.flatpak-warning-banner');
    expect(banner.inert).toBe(true);
    expect(banner.getAttribute('aria-hidden')).toBe('true');
  });
  it('hides the battery prompt and its actions until the app is not exempt', () => {
    const banner: HTMLElement = fixture.nativeElement.querySelector('.battery-banner');
    expect(banner.inert).toBe(true);
    expect(banner.getAttribute('aria-hidden')).toBe('true');

    showBatteryOptimizationPrompt.set(true);
    fixture.detectChanges();
    expect(banner.inert).toBe(false);
    expect(banner.classList.contains('visible')).toBe(true);
  });

  it('requests the exemption and dismisses the battery prompt', () => {
    showBatteryOptimizationPrompt.set(true);
    fixture.detectChanges();
    const banner: HTMLElement = fixture.nativeElement.querySelector('.battery-banner');

    banner.querySelector<HTMLButtonElement>('button[matButton]')?.click();
    expect(androidKeepAlive.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);

    banner.querySelector<HTMLButtonElement>('button.action-button')?.click();
    expect(androidKeepAlive.dismissBatteryOptimizationPrompt).toHaveBeenCalledTimes(1);
  });

  it('hides the all files access prompt and its actions until access is missing', () => {
    const banner: HTMLElement = fixture.nativeElement.querySelector('.storage-banner');
    expect(banner.inert).toBe(true);
    expect(banner.getAttribute('aria-hidden')).toBe('true');

    showAllFilesAccessPrompt.set(true);
    fixture.detectChanges();
    expect(banner.inert).toBe(false);
    expect(banner.classList.contains('visible')).toBe(true);
  });

  it('requests all files access and dismisses its prompt', () => {
    showAllFilesAccessPrompt.set(true);
    fixture.detectChanges();
    const banner: HTMLElement = fixture.nativeElement.querySelector('.storage-banner');

    banner.querySelector<HTMLButtonElement>('button[matButton]')?.click();
    expect(androidStorageAccess.requestAllFilesAccess).toHaveBeenCalledTimes(1);

    banner.querySelector<HTMLButtonElement>('button.action-button')?.click();
    expect(androidStorageAccess.dismissAllFilesAccessPrompt).toHaveBeenCalledTimes(1);
  });
});
