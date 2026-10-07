import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';

import {
  TemplateManagerModalComponent,
  TemplateManagerModalData,
} from './template-manager-modal.component';
import { UserTemplateService } from 'src/app/services/remote/user-template.service';
import { RemotePresetsService } from 'src/app/services/remote/remote-presets';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { UserPresetTemplate } from '@app/types';

describe('TemplateManagerModalComponent', () => {
  let fixture: ComponentFixture<TemplateManagerModalComponent>;
  let component: TemplateManagerModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let notificationServiceSpy: { confirmModal: ReturnType<typeof vi.fn> };
  let userTemplatesSignal: ReturnType<typeof signal<UserPresetTemplate[]>>;
  let userTemplateServiceSpy: {
    userTemplates: typeof userTemplatesSignal;
    saveTemplate: ReturnType<typeof vi.fn>;
    updateTemplate: ReturnType<typeof vi.fn>;
    deleteTemplate: ReturnType<typeof vi.fn>;
  };
  let remotePresetsServiceSpy: {
    resolvePresets: ReturnType<typeof vi.fn>;
  };

  const sampleTemplate: UserPresetTemplate = {
    id: 'tpl-1',
    name: 'Fast S3',
    description: 'Optimized S3 transfer settings',
    values: {
      vfs: { dir_cache_time: '1h' },
    },
  };

  const mockData: TemplateManagerModalData = {
    mode: 'save',
    currentValues: {
      vfs: { dir_cache_time: '30m' },
    },
  };

  beforeEach(async () => {
    dialogRefSpy = { close: vi.fn() };
    notificationServiceSpy = { confirmModal: vi.fn().mockResolvedValue(true) };
    userTemplatesSignal = signal<UserPresetTemplate[]>([sampleTemplate]);
    userTemplateServiceSpy = {
      userTemplates: userTemplatesSignal,
      saveTemplate: vi.fn().mockImplementation((input: Omit<UserPresetTemplate, 'id'>) => ({
        id: 'tpl-new',
        ...input,
      })),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
    };
    remotePresetsServiceSpy = {
      resolvePresets: vi.fn().mockReturnValue({
        vfs: { dir_cache_time: '15m' },
      }),
    };

    await TestBed.configureTestingModule({
      imports: [TemplateManagerModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: mockData },
        { provide: NotificationService, useValue: notificationServiceSpy },
        { provide: UserTemplateService, useValue: userTemplateServiceSpy },
        { provide: RemotePresetsService, useValue: remotePresetsServiceSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TemplateManagerModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create and initialize in save mode with entries extracted from currentValues', () => {
    expect(component).toBeTruthy();
    expect(component.mode()).toBe('save');
    expect(component.settingEntries().length).toBe(1);
    expect(component.settingEntries()[0].key).toBe('dir_cache_time');
    expect(component.settingEntries()[0].value).toBe('30m');
    expect(component.selectedKeysCount()).toBe(1);
  });

  it('should toggle search visibility and reset query when closed', () => {
    expect(component.isSearchVisible()).toBe(false);
    component.toggleSearch();
    expect(component.isSearchVisible()).toBe(true);

    component.keySearchQuery.set('dir_cache');
    component.toggleSearch();
    expect(component.isSearchVisible()).toBe(false);
    expect(component.keySearchQuery()).toBe('');
  });

  it('should handle key selection methods (toggle, select all, deselect all, remove)', () => {
    const entryId = component.settingEntries()[0].id;

    component.toggleEntry(entryId);
    expect(component.settingEntries()[0].selected).toBe(false);
    expect(component.selectedKeysCount()).toBe(0);

    component.selectAllKeys();
    expect(component.settingEntries()[0].selected).toBe(true);
    expect(component.selectedKeysCount()).toBe(1);

    component.deselectAllKeys();
    expect(component.settingEntries()[0].selected).toBe(false);
    expect(component.selectedKeysCount()).toBe(0);

    component.removeSaveKey(entryId);
    expect(component.settingEntries().length).toBe(0);
  });

  it('should save template and transition to manage mode', () => {
    component.saveForm.setValue({
      name: 'My New Template',
      description: 'Test description',
    });

    component.onSaveTemplate();

    expect(userTemplateServiceSpy.saveTemplate).toHaveBeenCalledWith({
      name: 'My New Template',
      description: 'Test description',
      values: {
        vfs: { dir_cache_time: '30m' },
      },
    });
    expect(component.mode()).toBe('manage');
    expect(component.selectedTemplateId()).toBe('tpl-new');
  });

  it('should not save template when form is invalid', () => {
    component.saveForm.setValue({
      name: '   ',
      description: '',
    });

    component.onSaveTemplate();
    expect(userTemplateServiceSpy.saveTemplate).not.toHaveBeenCalled();
  });

  it('should prompt confirmation when deleting template and delete on accept', async () => {
    component.mode.set('manage');
    component.selectedTemplateId.set('tpl-1');

    await component.onDeleteUserTemplate('tpl-1');

    expect(notificationServiceSpy.confirmModal).toHaveBeenCalled();
    expect(userTemplateServiceSpy.deleteTemplate).toHaveBeenCalledWith('tpl-1');
  });

  it('should not delete template when user cancels confirmation', async () => {
    notificationServiceSpy.confirmModal.mockResolvedValue(false);
    component.mode.set('manage');
    component.selectedTemplateId.set('tpl-1');

    await component.onDeleteUserTemplate('tpl-1');

    expect(notificationServiceSpy.confirmModal).toHaveBeenCalled();
    expect(userTemplateServiceSpy.deleteTemplate).not.toHaveBeenCalled();
  });

  it('should detect dirty state in manage mode when draft differs from saved template', () => {
    component.mode.set('manage');
    component.selectedTemplateId.set('tpl-1');
    fixture.detectChanges();

    expect(component.isManageDirty()).toBe(false);

    component.updateTemplateName('Renamed S3');
    expect(component.isManageDirty()).toBe(true);

    component.updateTemplateName(sampleTemplate.name);
    expect(component.isManageDirty()).toBe(false);

    component.updateTemplateDesc('Different description');
    expect(component.isManageDirty()).toBe(true);
  });

  it('should update template in manage mode', () => {
    component.mode.set('manage');
    component.selectedTemplateId.set('tpl-1');
    component.updateTemplateName('Updated Name');
    component.updateTemplateDesc('Updated Desc');

    component.onSaveManageTemplate();

    expect(userTemplateServiceSpy.updateTemplate).toHaveBeenCalledWith({
      id: 'tpl-1',
      name: 'Updated Name',
      description: 'Updated Desc',
      values: sampleTemplate.values,
    });
  });

  it('should add a key to a category in save mode and manage mode', () => {
    component.mode.set('save');
    component.addKeyToCategory('mount', 'read_only', 'true');

    const mountEntry = component.settingEntries().find(e => e.id === 'mount:read_only');
    expect(mountEntry).toBeDefined();
    expect(mountEntry?.value).toBe(true);

    component.mode.set('manage');
    component.addKeyToCategory('mount', 'allow_other', 'true');

    expect(component.draftValues().mount?.['allow_other']).toBe(true);

    component.removeKeyFromCategory('mount', 'allow_other');
    expect(component.draftValues().mount?.['allow_other']).toBeUndefined();
  });

  it('should apply default presets in save mode', () => {
    component.mode.set('save');
    component.applyDefaultPresets();

    expect(remotePresetsServiceSpy.resolvePresets).toHaveBeenCalled();
    const vfsEntry = component.settingEntries().find(e => e.id === 'vfs:dir_cache_time');
    expect(vfsEntry?.value).toBe('15m');
  });

  it('should close dialog when onClose is called', () => {
    component.onClose();
    expect(dialogRefSpy.close).toHaveBeenCalled();
  });

  it('should show empty state without manage-control-bar when no templates exist in manage mode', async () => {
    userTemplatesSignal.set([]);
    component.mode.set('manage');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.selectedTemplate()).toBeNull();
    const compiled = fixture.nativeElement as HTMLElement;
    const emptyState = compiled.querySelector('.empty-state');
    expect(emptyState).toBeTruthy();
  });

  it('should switch to save mode and reset form when createNewDraftTemplate is called from empty state', () => {
    component.mode.set('manage');
    component.saveForm.setValue({
      name: 'Existing',
      description: 'Desc',
    });

    component.createNewDraftTemplate();

    expect(component.mode()).toBe('save');
    expect(component.saveForm.getRawValue()).toEqual({
      name: '',
      description: '',
    });
    expect(component.settingEntries()).toEqual([]);
  });

  it('should reactively compute saveCategories and filter by search query', () => {
    const vfsCat = component.saveCategories().find(c => c.category === 'vfs');
    expect(vfsCat).toBeDefined();
    expect(vfsCat?.totalCount).toBe(1);
    expect(vfsCat?.selectedCount).toBe(1);
    expect(vfsCat?.entries.length).toBe(1);
    expect(vfsCat?.isVisible).toBe(true);

    // Search for a matching key
    component.keySearchQuery.set('dir_cache');
    const matchedVfs = component.saveCategories().find(c => c.category === 'vfs');
    expect(matchedVfs?.isVisible).toBe(true);
    expect(matchedVfs?.entries.length).toBe(1);

    // Search for a non-matching key
    component.keySearchQuery.set('non_existent_key_xyz');
    const unmatchedVfs = component.saveCategories().find(c => c.category === 'vfs');
    expect(unmatchedVfs?.isVisible).toBe(false);
    expect(unmatchedVfs?.entries.length).toBe(0);
    expect(component.hasAnyMatchingSaveCategory()).toBe(false);
  });

  it('should reactively compute manageCategories and display values', () => {
    component.mode.set('manage');
    component.selectedTemplateId.set('tpl-1');

    const vfsManage = component.manageCategories().find(c => c.category === 'vfs');
    expect(vfsManage).toBeDefined();
    expect(vfsManage?.totalCount).toBe(1);
    expect(vfsManage?.entries[0].key).toBe('dir_cache_time');
    expect(vfsManage?.entries[0].displayValue).toBe('1h');
  });

  it('should reset manage draft back to selectedTemplate on onReset', () => {
    component.mode.set('manage');
    component.selectedTemplateId.set('tpl-1');
    fixture.detectChanges();

    expect(component.isManageDirty()).toBe(false);

    component.updateTemplateName('Modified S3 Name');
    component.addKeyToCategory('mount', 'attr_timeout', '5s');
    expect(component.isManageDirty()).toBe(true);

    component.onReset();
    expect(component.draftName()).toBe(sampleTemplate.name);
    expect(component.draftValues()).toEqual(sampleTemplate.values);
    expect(component.isManageDirty()).toBe(false);
  });

  it('should update draftValues and dirty state in real-time when handleManageJsonInput receives valid JSON', () => {
    component.mode.set('manage');
    component.selectedTemplateId.set('tpl-1');
    fixture.detectChanges();

    expect(component.isManageDirty()).toBe(false);

    const updatedJson = JSON.stringify({
      vfs: { dir_cache_time: '2h' },
      mount: { read_only: true },
    });
    (component as unknown as { handleManageJsonInput: (t: string) => void }).handleManageJsonInput(
      updatedJson
    );

    expect(component.jsonParseError()).toBeNull();
    expect(component.draftValues()).toEqual({
      vfs: { dir_cache_time: '2h' },
      mount: { read_only: true },
    });
    expect(component.isManageDirty()).toBe(true);

    const vfsCat = component.manageCategories().find(c => c.category === 'vfs');
    expect(vfsCat?.entries[0].displayValue).toBe('2h');
  });

  it('should set jsonParseError and not update draftValues when handleManageJsonInput receives invalid JSON', () => {
    component.mode.set('manage');
    component.selectedTemplateId.set('tpl-1');
    fixture.detectChanges();

    const previousValues = component.draftValues();
    (component as unknown as { handleManageJsonInput: (t: string) => void }).handleManageJsonInput(
      '{ invalid json'
    );

    expect(component.jsonParseError()).toBeTruthy();
    expect(component.draftValues()).toEqual(previousValues);
  });
});
