import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { MultiRenameModalComponent, MultiRenameData } from './multi-rename-modal.component';
import { PathService } from '../../../services/infrastructure/platform/path.service';
import { RemoteFileOperationsService } from '../../../services/remote/remote-file-operations.service';
import { NotificationService } from '../../../services/ui/notification.service';
import { FileBrowserItem, ExplorerRoot } from '@app/types';

describe('MultiRenameModalComponent', () => {
  let fixture: ComponentFixture<MultiRenameModalComponent>;
  let component: MultiRenameModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let pathServiceSpy: {
    normalizeRemoteForRclone: ReturnType<typeof vi.fn>;
    normalizeExplorerRoot: ReturnType<typeof vi.fn>;
    getParentPath: ReturnType<typeof vi.fn>;
    joinPath: ReturnType<typeof vi.fn>;
  };
  let remoteOpsSpy: {
    rename: ReturnType<typeof vi.fn>;
    renameBatch: ReturnType<typeof vi.fn>;
  };
  let notificationServiceSpy: {
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };

  const mockRemote: ExplorerRoot = {
    name: 'my-remote',
    label: 'My Remote',
    type: 'drive',
    isLocal: false,
  };

  const mockItems: FileBrowserItem[] = [
    {
      entry: {
        ID: 'id-1',
        Path: 'photos/photo1.jpg',
        Name: 'photo1.jpg',
        Size: 1024,
        MimeType: 'image/jpeg',
        ModTime: '2025-01-01T00:00:00Z',
        IsDir: false,
      },
      meta: {
        remote: 'my-remote',
        isLocal: false,
      },
    },
    {
      entry: {
        ID: 'id-2',
        Path: 'photos/photo2.PNG',
        Name: 'photo2.PNG',
        Size: 2048,
        MimeType: 'image/png',
        ModTime: '2025-01-01T00:00:00Z',
        IsDir: false,
      },
      meta: {
        remote: 'my-remote',
        isLocal: false,
      },
    },
    {
      entry: {
        ID: 'id-3',
        Path: 'photos/vacation_folder',
        Name: 'vacation_folder',
        Size: -1,
        MimeType: 'inode/directory',
        ModTime: '2025-01-01T00:00:00Z',
        IsDir: true,
      },
      meta: {
        remote: 'my-remote',
        isLocal: false,
      },
    },
  ];

  const mockData: MultiRenameData = {
    items: mockItems,
    remote: mockRemote,
  };

  beforeEach(async () => {
    dialogRefSpy = { close: vi.fn() };
    pathServiceSpy = {
      normalizeRemoteForRclone: vi.fn().mockReturnValue('my-remote:'),
      normalizeExplorerRoot: vi.fn().mockReturnValue('my-remote:'),
      getParentPath: vi.fn().mockReturnValue('photos'),
      joinPath: vi.fn().mockImplementation((parent, name) => `${parent}/${name}`),
    };
    remoteOpsSpy = {
      rename: vi.fn().mockResolvedValue({}),
      renameBatch: vi.fn().mockResolvedValue('job-123'),
    };
    notificationServiceSpy = {
      showSuccess: vi.fn(),
      showError: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [MultiRenameModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: mockData },
        { provide: PathService, useValue: pathServiceSpy },
        { provide: RemoteFileOperationsService, useValue: remoteOpsSpy },
        { provide: NotificationService, useValue: notificationServiceSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MultiRenameModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should initialize with default values and preview matching original names', () => {
    expect(component.mode()).toBe('template');
    expect(component.form.controls.targetScope.value).toBe('all');
    expect(component.form.controls.caseTransform.value).toBe('none');
    expect(component.form.controls.preserveExtension.value).toBe(true);

    const previews = component.previewItems();
    expect(previews.length).toBe(3);
    expect(previews[0].newName).toBe('photo1.jpg');
    expect(previews[1].newName).toBe('photo2.PNG');
    expect(previews[2].newName).toBe('vacation_folder');
    expect(component.hasChanges()).toBe(false);
    expect(component.hasErrors()).toBe(false);
  });

  it('should format names with template, prefix, suffix, and counter', () => {
    component.form.patchValue({
      template: 'item_[Counter]',
      counterStart: 1,
      counterStep: 1,
      counterPadding: 3,
      prefix: 'IMG_',
      suffix: '_raw',
    });

    const previews = component.previewItems();
    expect(previews[0].newName).toBe('IMG_item_001_raw.jpg');
    expect(previews[1].newName).toBe('IMG_item_002_raw.PNG');
    expect(previews[2].newName).toBe('IMG_item_003_raw');
    expect(component.hasChanges()).toBe(true);
    expect(component.changedCount()).toBe(3);
  });

  it('should format names with [ModDate] placeholder', () => {
    component.form.patchValue({
      template: 'item_[ModDate]',
    });

    const previews = component.previewItems();
    expect(previews[0].newName).toBe('item_2025-01-01.jpg');
    expect(previews[1].newName).toBe('item_2025-01-01.PNG');
    expect(previews[2].newName).toBe('item_2025-01-01');
  });

  it('should filter targets based on targetScope', () => {
    // 1. Files only
    component.form.patchValue({
      targetScope: 'files',
      template: 'file_[Counter]',
    });

    let previews = component.previewItems();
    expect(previews[0].newName).toBe('file_01.jpg');
    expect(previews[1].newName).toBe('file_02.PNG');
    expect(previews[2].newName).toBe('vacation_folder'); // Unchanged directory
    expect(component.changedCount()).toBe(2);
    expect(component.unchangedCount()).toBe(1);

    // 2. Folders only
    component.form.patchValue({
      targetScope: 'folders',
      template: 'folder_[Counter]',
    });

    previews = component.previewItems();
    expect(previews[0].newName).toBe('photo1.jpg'); // Unchanged file
    expect(previews[1].newName).toBe('photo2.PNG'); // Unchanged file
    expect(previews[2].newName).toBe('folder_01'); // Renamed directory
    expect(component.changedCount()).toBe(1);
    expect(component.unchangedCount()).toBe(2);
  });

  it('should apply case conversions correctly', () => {
    component.form.patchValue({
      caseTransform: 'uppercase',
    });

    let previews = component.previewItems();
    expect(previews[0].newName).toBe('PHOTO1.jpg'); // Extension preserved in lowercase
    expect(previews[1].newName).toBe('PHOTO2.PNG');
    expect(previews[2].newName).toBe('VACATION_FOLDER');

    component.form.patchValue({
      caseTransform: 'lowercase',
    });

    previews = component.previewItems();
    expect(previews[0].newName).toBe('photo1.jpg');
    expect(previews[1].newName).toBe('photo2.PNG');
    expect(previews[2].newName).toBe('vacation_folder');

    component.form.patchValue({
      template: 'my vacation folder',
      caseTransform: 'titlecase',
    });

    previews = component.previewItems();
    expect(previews[2].newName).toBe('My Vacation Folder');
  });

  it('should replace text in find and replace mode (standard and regex)', () => {
    component.setMode('replace');

    // Standard literal replace
    component.form.patchValue({
      findText: 'photo',
      replaceWith: 'image_',
    });

    let previews = component.previewItems();
    expect(previews[0].newName).toBe('image_1.jpg');
    expect(previews[1].newName).toBe('image_2.PNG');
    expect(previews[2].newName).toBe('vacation_folder');

    // Regex replace
    component.form.patchValue({
      findText: '(\\d+)',
      replaceWith: '00$1',
      useRegex: true,
    });

    previews = component.previewItems();
    expect(previews[0].newName).toBe('photo001.jpg');
    expect(previews[1].newName).toBe('photo002.PNG');
  });

  it('should detect invalid regex and expose regexError', () => {
    component.setMode('replace');
    component.form.patchValue({
      findText: '[unclosed',
      useRegex: true,
    });

    expect(component.regexError()).toBeTruthy();
    expect(component.hasErrors()).toBe(true);
  });

  it('should detect illegal filename characters and flag errors', () => {
    component.form.patchValue({
      template: 'invalid:name*?',
    });

    const previews = component.previewItems();
    expect(previews[0].hasError).toBe(true);
    expect(component.hasErrors()).toBe(true);
  });

  it('should detect duplicate names and flag errors', () => {
    component.form.patchValue({
      template: 'same_name',
    });

    component.previewItems();
    // photo1.jpg -> same_name.jpg
    // photo2.PNG -> same_name.PNG
    // vacation_folder -> same_name
    expect(component.hasErrors()).toBe(false);

    // Make both files conflict
    component.form.patchValue({
      template: 'same_name',
      preserveExtension: false,
    });

    expect(component.hasErrors()).toBe(true);
    expect(component.conflictCount()).toBeGreaterThan(0);
  });

  it('should execute batch rename and dismiss on confirm', async () => {
    component.form.patchValue({
      template: 'renamed_[Counter]',
    });

    await component.onConfirm();

    expect(remoteOpsSpy.renameBatch).toHaveBeenCalledTimes(1);
    expect(remoteOpsSpy.renameBatch).toHaveBeenCalledWith(
      [
        {
          remote: 'my-remote:',
          srcPath: 'photos/photo1.jpg',
          dstPath: 'photos/renamed_01.jpg',
          isDir: false,
        },
        {
          remote: 'my-remote:',
          srcPath: 'photos/photo2.PNG',
          dstPath: 'photos/renamed_02.PNG',
          isDir: false,
        },
        {
          remote: 'my-remote:',
          srcPath: 'photos/vacation_folder',
          dstPath: 'photos/renamed_03',
          isDir: true,
        },
      ],
      'filemanager'
    );
    expect(notificationServiceSpy.showSuccess).toHaveBeenCalled();
    expect(dialogRefSpy.close).toHaveBeenCalledWith(true);
  });

  it('should handle rename error and notify user', async () => {
    remoteOpsSpy.renameBatch.mockRejectedValueOnce(new Error('Batch failed'));

    component.form.patchValue({
      template: 'renamed_[Counter]',
    });

    await component.onConfirm();

    expect(notificationServiceSpy.showError).toHaveBeenCalled();
    expect(component.isSaving()).toBe(false);
    expect(dialogRefSpy.close).not.toHaveBeenCalled();
  });
});
