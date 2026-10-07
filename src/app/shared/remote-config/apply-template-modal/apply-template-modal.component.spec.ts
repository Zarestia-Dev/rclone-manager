import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';

import {
  ApplyTemplateModalComponent,
  ApplyTemplateModalData,
} from './apply-template-modal.component';
import { UserPresetTemplate } from '@app/types';

describe('ApplyTemplateModalComponent', () => {
  let fixture: ComponentFixture<ApplyTemplateModalComponent>;
  let component: ApplyTemplateModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };

  const sampleTemplate: UserPresetTemplate = {
    id: 'tpl-1',
    name: 'Streaming Preset',
    description: 'VFS full caching for Plex',
    values: {
      vfs: {
        dir_cache_time: '1000h',
        vfs_cache_mode: 'full',
      },
      mount: {
        allow_other: true,
      },
    },
  };

  const mockData: ApplyTemplateModalData = {
    template: sampleTemplate,
    currentValues: {
      vfs: {
        dir_cache_time: '1h', // will be modified
      },
    },
  };

  beforeEach(async () => {
    dialogRefSpy = { close: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [ApplyTemplateModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: mockData },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ApplyTemplateModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create and compute diff result accurately', () => {
    expect(component).toBeTruthy();
    expect(component.template.name).toBe('Streaming Preset');

    const diff = component.diffResult();
    expect(diff.totalCount).toBe(3);
    expect(diff.totalModified).toBe(1); // dir_cache_time: 1h -> 1000h
    expect(diff.totalAdded).toBe(2); // vfs_cache_mode & allow_other
    expect(diff.totalUnchanged).toBe(0);
    expect(diff.hasChanges).toBe(true);
    expect(component.filteredKeysCount()).toBe(3);
  });

  it('should toggle strategy between overwrite and fill-empty', () => {
    expect(component.strategy()).toBe('overwrite');
    expect(component.filteredKeysCount()).toBe(3);

    component.setStrategy('fill-empty');
    expect(component.strategy()).toBe('fill-empty');

    // In fill-empty strategy, dir_cache_time is already set in currentValues,
    // so only the 2 unset keys (vfs_cache_mode and allow_other) should be applied.
    expect(component.filteredKeysCount()).toBe(2);

    const values = component.filteredValues();
    expect(values.vfs?.['dir_cache_time']).toBeUndefined();
    expect(values.vfs?.['vfs_cache_mode']).toBe('full');
    expect(values.mount?.['allow_other']).toBe(true);
  });

  it('should toggle category selection', () => {
    expect(component.isCategorySelected('mount')).toBe(true);

    component.toggleCategory('mount');
    expect(component.isCategorySelected('mount')).toBe(false);

    // Only VFS remains selected
    const values = component.filteredValues();
    expect(values.vfs).toBeDefined();
    expect(values.mount).toBeUndefined();

    // Toggle mount back on
    component.toggleCategory('mount');
    expect(component.isCategorySelected('mount')).toBe(true);
  });

  it('should render categories and diff rows even when all values are unchanged', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ApplyTemplateModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            template: sampleTemplate,
            currentValues: sampleTemplate.values,
          },
        },
      ],
    }).compileComponents();

    const unchangedFixture = TestBed.createComponent(ApplyTemplateModalComponent);
    const unchangedComp = unchangedFixture.componentInstance;
    unchangedFixture.detectChanges();

    expect(unchangedComp.diffResult().hasChanges).toBe(false);
    expect(unchangedComp.diffResult().totalUnchanged).toBe(3);

    const compiled = unchangedFixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.no-diff-banner')).toBeTruthy();
    expect(compiled.querySelectorAll('.category-diff-card').length).toBe(2);
    expect(compiled.querySelectorAll('.diff-row').length).toBe(3);
  });

  it('should close dialog with applied result on onApply', () => {
    component.onApply();

    expect(dialogRefSpy.close).toHaveBeenCalledWith({
      applied: true,
      values: component.filteredValues(),
      strategy: 'overwrite',
    });
  });

  it('should restrict diff and categories to applicableCategories when provided in dialog data', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ApplyTemplateModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            template: sampleTemplate,
            currentValues: mockData.currentValues,
            applicableCategories: ['vfs'],
          },
        },
      ],
    }).compileComponents();

    const scopedFixture = TestBed.createComponent(ApplyTemplateModalComponent);
    const scopedComp = scopedFixture.componentInstance;
    scopedFixture.detectChanges();

    expect(scopedComp.diffResult().categories).toEqual(['vfs']);
    expect(scopedComp.diffResult().byCategory.mount).toBeUndefined();
    expect(scopedComp.filteredValues().mount).toBeUndefined();
    expect(scopedComp.filteredValues().vfs).toBeDefined();
  });

  it('should close dialog on onClose without result', () => {
    component.onClose();
    expect(dialogRefSpy.close).toHaveBeenCalledWith();
  });
});
