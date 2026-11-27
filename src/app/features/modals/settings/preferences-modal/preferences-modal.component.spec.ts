import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesModalComponent } from './preferences-modal.component';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { ValidatorRegistryService } from 'src/app/services/ui/validation/validator-registry.service';
import { ModalService } from 'src/app/services/ui/modal.service';

describe('PreferencesModalComponent search', () => {
  let component: PreferencesModalComponent;
  const openTransferOptions = vi.fn();
  const getSettingValue = vi.fn();
  const dialogData: { category?: string; title?: string } = {};
  /** The file browser's preferences, as its menu opens them. */
  const openFileBrowserPreferences = (): void => {
    dialogData.category = 'nautilus';
    dialogData.title = 'modals.preferences.fileBrowserTitle';
    component = TestBed.createComponent(PreferencesModalComponent).componentInstance;
  };

  beforeEach(() => {
    delete dialogData.category;
    delete dialogData.title;
    TestBed.configureTestingModule({
      imports: [PreferencesModalComponent],
      providers: [
        provideTranslateService({ lang: 'tr' }),
        { provide: MatDialogRef, useValue: {} },
        { provide: MAT_DIALOG_DATA, useValue: dialogData },
        { provide: FileSystemService, useValue: {} },
        { provide: LocalStorageService, useValue: {} },
        { provide: ValidatorRegistryService, useValue: {} },
        { provide: ModalService, useValue: { openTransferOptions } },
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
              'nautilus.starred': {
                default: [],
                value: [],
                metadata: { hidden: true },
              },
              'nautilus.ask_transfer_options': {
                default: false,
                value: true,
                metadata: { label: 'settings.askLabel' },
              },
            }),
            getSettingValue,
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

  it('moves between the tabs with the arrow keys, Home and End', () => {
    // Only the selected tab is in the Tab order, so the keys are the only way to the others.
    const list = document.createElement('div');
    const buttons = component.tabs.map(() => {
      const button = document.createElement('button');
      button.setAttribute('role', 'tab');
      button.addEventListener('keydown', event =>
        (component as unknown as { onTabKey(e: KeyboardEvent): void }).onTabKey(event)
      );
      list.appendChild(button);
      return button;
    });
    document.body.appendChild(list);
    const press = (key: string): void => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      );
    };

    buttons[0].focus();
    press('ArrowRight');
    expect(component.selectedTabIndex()).toBe(1);
    expect(document.activeElement).toBe(buttons[1]);
    press('End');
    expect(component.selectedTabIndex()).toBe(buttons.length - 1);
    press('ArrowRight');
    expect(component.selectedTabIndex()).toBe(0);
    press('ArrowLeft');
    expect(component.selectedTabIndex()).toBe(buttons.length - 1);
    press('Home');
    expect(component.selectedTabIndex()).toBe(0);
    expect(document.activeElement).toBe(buttons[0]);
    list.remove();
  });

  it("keeps the file browser's preferences out of the app's and opens them alone", () => {
    expect(component.tabs.map(tab => tab.key)).toEqual(['general', 'core', 'developer']);
    expect(component.title).toBe('modals.preferences.title');
    component.onSearchTextChange('ask_transfer');
    expect(component.searchResults()).toEqual([]);

    openFileBrowserPreferences();
    expect(component.tabs.map(tab => tab.key)).toEqual(['nautilus']);
    expect(component.title).toBe('modals.preferences.fileBrowserTitle');
    component.onSearchTextChange('ask_transfer');
    expect(component.searchResults()).toEqual([
      { category: 'nautilus', key: 'ask_transfer_options' },
    ]);
  });

  it('leaves the data a feature keeps off its tab and out of the search', () => {
    openFileBrowserPreferences();
    expect(component.selectedTabKeys()).toEqual(['ask_transfer_options']);
    component.onSearchTextChange('starred');
    expect(component.searchResults()).toEqual([]);
  });

  it('edits the options every file browser transfer starts from', async () => {
    const defaults = { copy: { check_first: true } };
    getSettingValue.mockResolvedValueOnce(defaults);
    openFileBrowserPreferences();
    await component.openDefaultTransferOptions();
    expect(getSettingValue).toHaveBeenCalledExactlyOnceWith('nautilus.transfer_options');
    expect(openTransferOptions).toHaveBeenCalledExactlyOnceWith({
      mode: 'default',
      values: defaults,
    });
  });

  it('treats whitespace as an empty search and requires all words', () => {
    component.onSearchTextChange(' \t ');
    expect(component.hasSearchResults()).toBe(false);
    expect(component.searchResults()).toEqual([]);
    component.onSearchTextChange('arka unrelated');
    expect(component.searchResults()).toEqual([]);
  });
});
