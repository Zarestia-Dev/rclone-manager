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
        overviewHeader: { manageBackends: 'Manage Backends' },
      },
    });
    translate.use('en');
    const fixture = TestBed.createComponent(OverviewHeaderComponent);
    fixture.componentRef.setInput('mode', mode);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('names the backend switch with its visible title and backend, not a key', () => {
    const button = render('mount').querySelector('.header-btn') as HTMLElement;
    // No aria-label: the name is the visible text, so speech input can say what it sees.
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(button.querySelector('.header-title')?.textContent?.trim()).toBe('Mount Overview');
    expect(button.querySelector('.backend-label')?.textContent?.trim()).toBe('Local');
    expect(button.getAttribute('title')).toBe('Manage Backends');
  });

  it('does not repeat the title through the logo', () => {
    const header = render('general');
    expect(header.querySelector('.header-title')?.textContent?.trim()).toBe('RClone Manager');
    expect(header.querySelector('.app-logo')?.getAttribute('alt')).toBe('');
  });
});
