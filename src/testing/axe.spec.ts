import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { axeViolations } from './axe';
import { WindowControlsComponent } from 'src/app/shared/components/window-controls/window-controls.component';
import { OverviewHeaderComponent } from 'src/app/shared/overviews-shared/overview-header/overview-header.component';
import { WindowService } from 'src/app/services/ui/window.service';
import { DEFAULT_WINDOW_BUTTON_LAYOUT } from 'src/app/shared/utils';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';

@Component({
  template: `<button type="button"><span aria-hidden="true">+</span></button>`,
})
class UnnamedButtonComponent {}

function useEnglish(): void {
  const translate = TestBed.inject(TranslateService);
  translate.setTranslation('en', {
    titlebar: { minimize: 'Minimize', maximize: 'Maximize', close: 'Close' },
    overviews: { headers: { general: 'RClone Manager', mount: 'Mount Overview' } },
    shared: {
      overviewHeader: {
        manageBackends: 'Manage Backends',
        backendSwitchAria: 'Current mode: {{title}} - Click to switch backend',
      },
    },
    generalOverview: { layout: { edit: 'Edit Layout' } },
  });
  translate.use('en');
}

describe('axe-core component checks', () => {
  it('reports an icon button without a name', async () => {
    const fixture = TestBed.createComponent(UnnamedButtonComponent);
    fixture.detectChanges();
    expect(await axeViolations(fixture.nativeElement)).toEqual([
      expect.stringContaining('button-name'),
    ]);
  });

  it('finds nothing in the window controls', async () => {
    TestBed.configureTestingModule({
      imports: [WindowControlsComponent, MatIconTestingModule],
      providers: [
        provideTranslateService(),
        {
          provide: WindowService,
          useValue: {
            isMaximized: signal(false),
            buttonLayout: signal(DEFAULT_WINDOW_BUTTON_LAYOUT),
            minimize: vi.fn(),
            maximize: vi.fn(),
            close: vi.fn(),
          },
        },
        { provide: UiStateService, useValue: { platform: 'linux' } },
      ],
    });
    useEnglish();
    const fixture = TestBed.createComponent(WindowControlsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('button').length).toBe(3);
    expect(await axeViolations(fixture.nativeElement)).toEqual([]);
  });

  it('finds nothing in the overview header', async () => {
    TestBed.configureTestingModule({
      imports: [OverviewHeaderComponent, MatIconTestingModule],
      providers: [
        provideTranslateService(),
        { provide: BackendService, useValue: { activeBackend: signal('Local') } },
        { provide: RcloneStatusService, useValue: { rcloneStatus: signal('active') } },
        { provide: UiStateService, useValue: { isEditingLayout: signal(false) } },
      ],
    });
    useEnglish();
    const fixture = TestBed.createComponent(OverviewHeaderComponent);
    fixture.componentRef.setInput('mode', 'mount');
    fixture.detectChanges();
    expect(await axeViolations(fixture.nativeElement)).toEqual([]);
  });
});
