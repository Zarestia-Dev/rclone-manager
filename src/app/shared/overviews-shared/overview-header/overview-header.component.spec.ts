import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { describe, expect, it } from 'vitest';
import { OverviewHeaderComponent } from './overview-header.component';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';

describe('OverviewHeaderComponent', () => {
  const render = (mode: string): HTMLElement => {
    TestBed.configureTestingModule({
      imports: [OverviewHeaderComponent, MatIconTestingModule],
      providers: [
        provideTranslateService(),
        { provide: BackendService, useValue: { activeBackend: signal('Local') } },
        { provide: RcloneStatusService, useValue: { rcloneStatus: signal('active') } },
        { provide: UiStateService, useValue: { isEditingLayout: signal(false) } },
      ],
    });
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      overviews: { headers: { general: 'RClone Manager', mount: 'Mount Overview' } },
      shared: {
        overviewHeader: { backendSwitchAria: 'Current mode: {{title}} - Click to switch backend' },
      },
    });
    translate.use('en');
    const fixture = TestBed.createComponent(OverviewHeaderComponent);
    fixture.componentRef.setInput('mode', mode);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('names the backend switch with the translated title, not its key', () => {
    const button = render('mount').querySelector('.header-btn');
    expect(button?.getAttribute('aria-label')).toBe(
      'Current mode: Mount Overview - Click to switch backend'
    );
  });

  it('shows the same translated title it announces', () => {
    const header = render('general');
    expect(header.querySelector('.header-title')?.textContent?.trim()).toBe('RClone Manager');
    expect(header.querySelector('.header-btn')?.getAttribute('aria-label')).toContain(
      'Current mode: RClone Manager'
    );
  });
});
