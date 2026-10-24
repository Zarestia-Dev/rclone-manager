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

describe('BannerComponent collapsed content', () => {
  let fixture: ComponentFixture<BannerComponent>;
  const buildType = signal('flatpak');

  beforeEach(() => {
    buildType.set('flatpak');
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
});
