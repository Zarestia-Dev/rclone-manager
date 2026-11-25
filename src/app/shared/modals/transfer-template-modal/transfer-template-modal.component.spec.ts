import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserPresetTemplate } from '@app/types';
import { UserTemplateService } from 'src/app/services/remote/user-template.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import {
  TransferTemplateModalComponent,
  TransferTemplateModalData,
} from './transfer-template-modal.component';

describe('TransferTemplateModalComponent', () => {
  const templates = signal<UserPresetTemplate[]>([]);
  const close = vi.fn();
  const saveSetting = vi.fn();
  const openTemplateManager = vi.fn();

  const create = (
    data: Partial<TransferTemplateModalData> = {}
  ): TransferTemplateModalComponent => {
    TestBed.configureTestingModule({
      providers: [
        { provide: MatDialogRef, useValue: { close } },
        {
          provide: MAT_DIALOG_DATA,
          useValue: { selected: '', operation: 'copy', count: 2, destination: 'drive:', ...data },
        },
        { provide: UserTemplateService, useValue: { userTemplates: templates } },
        { provide: AppSettingsService, useValue: { saveSetting } },
        { provide: ModalService, useValue: { openTemplateManager } },
      ],
    }).overrideComponent(TransferTemplateModalComponent, { set: { template: '', imports: [] } });
    return TestBed.createComponent(TransferTemplateModalComponent).componentInstance;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    saveSetting.mockResolvedValue(undefined);
    templates.set([
      {
        id: 'usr-tpl-1',
        name: 'Verified',
        values: {
          copy: { check_first: true },
          move: { delete_empty_src_dirs: true },
          filter: { exclude: ['*.tmp'] },
          backend: { low_level_retries: 20 },
          sync: { track_renames: true },
        },
      },
    ]);
  });

  it('shows what the template sets for this kind of transfer only', () => {
    const modal = create({ selected: 'usr-tpl-1' });
    expect(modal.optionGroups()).toEqual([
      { category: 'copy', entries: [{ key: 'check_first', value: 'true' }] },
      { category: 'filter', entries: [{ key: 'exclude', value: '["*.tmp"]' }] },
      { category: 'backend', entries: [{ key: 'low_level_retries', value: '20' }] },
    ]);
  });

  it('offers no deleted default and starts with nothing for none', async () => {
    const modal = create({ selected: 'usr-tpl-gone' });
    expect(modal.selected()).toBe('');
    expect(modal.chosen()).toBeUndefined();
    await modal.start();
    expect(close).toHaveBeenCalledExactlyOnceWith('');
    expect(saveSetting).not.toHaveBeenCalled();
  });

  it('saves the choice as default and stops asking when the user says so', async () => {
    const modal = create({ operation: 'move' });
    modal.select('usr-tpl-1');
    expect(modal.optionGroups()[0].category).toBe('move');
    modal.useAsDefault.set(true);
    modal.dontAskAgain.set(true);
    await modal.start();
    expect(saveSetting.mock.calls).toEqual([
      ['file_browser', 'transfer_template', 'usr-tpl-1'],
      ['file_browser', 'ask_transfer_template', false],
    ]);
    expect(close).toHaveBeenCalledExactlyOnceWith('usr-tpl-1');
  });

  it('selects a template created in the template manager', () => {
    const modal = create();
    openTemplateManager.mockReturnValueOnce({
      afterClosed: () => {
        templates.update(list => [{ id: 'usr-tpl-new', name: 'New', values: {} }, ...list]);
        return of(undefined);
      },
    });
    modal.openTemplateManager('save');
    expect(openTemplateManager).toHaveBeenCalledExactlyOnceWith({ mode: 'save' });
    expect(modal.selected()).toBe('usr-tpl-new');
  });

  it('closes with nothing when cancelled', () => {
    create().cancel();
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });
});
