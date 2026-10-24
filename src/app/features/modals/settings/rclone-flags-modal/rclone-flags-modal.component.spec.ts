import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RcloneFlagsModalComponent } from './rclone-flags-modal.component';
import { FlagConfigService } from 'src/app/services/remote/flag-config.service';
import { RcloneBackendOptionsService } from 'src/app/services/settings/rclone-backend-options.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { JsonEditorComponent } from 'src/app/shared/components/json-editor/json-editor.component';
import { MatIconRegistry } from '@angular/material/icon';
import { By } from '@angular/platform-browser';
import { Observable, of } from 'rxjs';

describe('RcloneFlagsModalComponent search', () => {
  let component: RcloneFlagsModalComponent;
  let fixture: ComponentFixture<RcloneFlagsModalComponent>;
  const jsonMode = signal(false);

  beforeEach(async () => {
    jsonMode.set(false);
    TestBed.configureTestingModule({
      imports: [RcloneFlagsModalComponent],
      providers: [
        provideTranslateService({ lang: 'tr' }),
        { provide: MatDialogRef, useValue: {} },
        { provide: RcloneBackendOptionsService, useValue: {} },
        { provide: NotificationService, useValue: { showError: vi.fn() } },
        { provide: UiStateService, useValue: { showJsonMode: jsonMode } },
        {
          provide: AppSettingsService,
          useValue: { selectSetting: (): Observable<{ value: boolean }> => of({ value: false }) },
        },
        {
          provide: MatIconRegistry,
          useValue: {
            getNamedSvgIcon: (): Observable<SVGElement> =>
              of(document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
          },
        },
        {
          provide: FlagConfigService,
          useValue: {
            getGroupedOptions: vi.fn().mockResolvedValue({
              vfs: {
                General: [
                  {
                    Name: 'vfs_cache_mode',
                    FieldName: 'CacheMode',
                    Help: 'Cache mode',
                    Type: 'string',
                    DefaultStr: 'off',
                  },
                  {
                    Name: 'vfs_read_ahead',
                    FieldName: 'ReadAhead',
                    Help: 'Read ahead',
                    Type: 'SizeSuffix',
                    DefaultStr: '0',
                  },
                ],
              },
            }),
          },
        },
      ],
    }).overrideComponent(JsonEditorComponent, { set: { template: '', imports: [] } });
    TestBed.inject(TranslateService).setTranslation('tr', {
      vfs_cache_mode: { title: 'Önbellek modu', help: 'Dosya önbelleğini yapılandır.' },
    });
    fixture = TestBed.createComponent(RcloneFlagsModalComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
  });

  it.each(['general', 'vfs', 'general cache'])(
    'keeps results visible after following a %s search result',
    query => {
      component.searchQuery.set(query);
      const results = component.globalSearchResults();
      expect(results.length).toBeGreaterThan(0);
      const first = results[0];
      component.navigateTo(first.service, first.category, first.option.Name);
      expect(component.virtualScrollData()).toEqual(results.map(r => r.option));
    }
  );

  it('finds full flags and translated text in both views', () => {
    for (const query of ['--vfs-cache-mode', 'Önbellek modu', 'dosya yapılandır']) {
      component.searchQuery.set(query);
      expect(component.globalSearchResults().map(r => r.option.Name)).toEqual(['vfs_cache_mode']);
      component.navigateTo('vfs', 'General');
      expect(component.virtualScrollData().map(f => f.Name)).toEqual(['vfs_cache_mode']);
    }
  });

  it('preserves the category JSON editor and invalid input while filtering its chips', async () => {
    jsonMode.set(true);
    component.navigateTo('vfs', 'General');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const editor = fixture.debugElement.query(By.directive(JsonEditorComponent))
      .componentInstance as JsonEditorComponent;
    (editor as unknown as { applyEditorChanges: (text: string) => void }).applyEditorChanges('{');
    expect(component.rcloneOptionsForm.hasError('jsonParse')).toBe(true);
    component.searchQuery.set('unrelated');
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(JsonEditorComponent))?.componentInstance).toBe(
      editor
    );
    component.searchQuery.set('');
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(JsonEditorComponent))?.componentInstance).toBe(
      editor
    );
    expect(editor.parseError()?.key).toBe('shared.jsonEditor.parseError');
  });

  it('clears results immediately when closing search or deleting the query', () => {
    vi.useFakeTimers();
    try {
      component.toggleSearchVisibility();
      component.onSearchInput('cache');
      vi.advanceTimersByTime(200);
      expect(component.searchQuery()).toBe('cache');
      component.toggleSearchVisibility();
      expect(component.searchQuery()).toBe('');
      component.toggleSearchVisibility();
      component.onSearchInput('cache');
      vi.advanceTimersByTime(200);
      expect(component.searchQuery()).toBe('cache');
      component.onSearchInput(' \t ');
      expect(component.searchQuery()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending search when the search panel closes', () => {
    vi.useFakeTimers();
    try {
      component.toggleSearchVisibility();
      component.onSearchInput('cache');
      vi.advanceTimersByTime(100);
      component.toggleSearchVisibility();
      component.toggleSearchVisibility();
      vi.advanceTimersByTime(200);
      expect(component.searchQuery()).toBe('');
      component.onSearchInput('read');
      vi.advanceTimersByTime(200);
      expect(component.searchQuery()).toBe('read');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not manufacture results from whitespace or unmatched terms', () => {
    component.searchQuery.set(' \t ');
    expect(component.globalSearchResults()).toEqual([]);
    component.navigateTo('vfs', 'General');
    expect(component.virtualScrollData()).toHaveLength(2);
    component.searchQuery.set('cache nonexistent');
    expect(component.globalSearchResults()).toEqual([]);
    expect(component.virtualScrollData()).toEqual([]);
  });
});
