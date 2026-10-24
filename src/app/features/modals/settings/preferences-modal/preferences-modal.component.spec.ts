import { TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { PreferencesModalComponent } from './preferences-modal.component';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { ValidatorRegistryService } from 'src/app/services/ui/validation/validator-registry.service';

describe('PreferencesModalComponent search', () => {
  let component: PreferencesModalComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PreferencesModalComponent],
      providers: [
        provideTranslateService({ lang: 'tr' }),
        { provide: MatDialogRef, useValue: {} },
        { provide: FileSystemService, useValue: {} },
        { provide: LocalStorageService, useValue: {} },
        { provide: ValidatorRegistryService, useValue: {} },
        {
          provide: AppSettingsService,
          useValue: {
            options$: of({
              'general.background_enabled': {
                value_type: 'bool',
                default: false,
                value: false,
                metadata: {
                  label: 'settings.backgroundLabel',
                  description: 'settings.backgroundHelp',
                },
              },
              'unknown.hidden': { default: false, metadata: { label: 'settings.backgroundLabel' } },
            }),
          },
        },
      ],
    }).overrideComponent(PreferencesModalComponent, { set: { template: '', imports: [] } });
    TestBed.inject(TranslateService).setTranslation('tr', {
      settings: {
        backgroundLabel: 'Arka planda çalış',
        backgroundHelp: 'Pencere kapalıyken devam et.',
      },
    });
    component = TestBed.createComponent(PreferencesModalComponent).componentInstance;
  });

  it.each([
    '  arka  planda ',
    'kapalıyken devam',
    'background enabled',
    'general.background_enabled',
  ])('finds translated settings and technical keys using %s', query => {
    component.onSearchTextChange(query);
    expect(component.searchResults()).toEqual([{ category: 'general', key: 'background_enabled' }]);
  });

  it('treats whitespace as an empty search and requires all words', () => {
    component.onSearchTextChange(' \t ');
    expect(component.hasSearchResults()).toBe(false);
    expect(component.searchResults()).toEqual([]);
    component.onSearchTextChange('arka unrelated');
    expect(component.searchResults()).toEqual([]);
  });
});
