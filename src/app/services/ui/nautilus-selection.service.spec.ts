import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NautilusSelectionService } from './nautilus-selection.service';
import { NautilusService } from './nautilus.service';
import { NautilusTabService } from './nautilus-tab.service';
import { Entry, FileBrowserItem, FilePickerConfig } from '@app/types';

describe('NautilusSelectionService', () => {
  let service: NautilusSelectionService;
  let pickerStateSignal: ReturnType<typeof signal<{ isOpen: boolean; options?: FilePickerConfig }>>;
  let selectedItemsSignal: ReturnType<typeof signal<Set<string>>>;
  let selectedItemsRightSignal: ReturnType<typeof signal<Set<string>>>;
  let activeSelectionSignal: ReturnType<typeof signal<Set<string>>>;
  let syncSelectionMock: ReturnType<typeof vi.fn>;

  const folderEntry: Entry = {
    Name: 'Documents',
    Path: 'Documents',
    IsDir: true,
    Size: -1,
    ModTime: '2026-01-01T00:00:00Z',
    ID: '1',
    MimeType: 'inode/directory',
  };

  const fileEntry: Entry = {
    Name: 'report.pdf',
    Path: 'report.pdf',
    IsDir: false,
    Size: 1024,
    ModTime: '2026-01-01T00:00:00Z',
    ID: '2',
    MimeType: 'application/pdf',
  };

  const imageEntry: Entry = {
    Name: 'photo.jpg',
    Path: 'photo.jpg',
    IsDir: false,
    Size: 2048,
    ModTime: '2026-01-01T00:00:00Z',
    ID: '3',
    MimeType: 'image/jpeg',
  };

  const folderItem: FileBrowserItem = {
    entry: folderEntry,
    meta: { remote: 'local', isLocal: true },
  };

  const fileItem: FileBrowserItem = {
    entry: fileEntry,
    meta: { remote: 'local', isLocal: true },
  };

  const imageItem: FileBrowserItem = {
    entry: imageEntry,
    meta: { remote: 'local', isLocal: true },
  };

  beforeEach(() => {
    pickerStateSignal = signal({ isOpen: false });
    selectedItemsSignal = signal(new Set<string>());
    selectedItemsRightSignal = signal(new Set<string>());
    activeSelectionSignal = signal(new Set<string>());
    syncSelectionMock = vi.fn((sel: Set<string>) => {
      selectedItemsSignal.set(sel);
      activeSelectionSignal.set(sel);
    });

    const mockNautilusService = {
      filePickerState: pickerStateSignal,
    };

    const mockTabService = {
      activePaneIndex: signal(0),
      switchPane: vi.fn(),
      selectedItems: selectedItemsSignal,
      selectedItemsRight: selectedItemsRightSignal,
      activeSelection: activeSelectionSignal,
      syncSelection: syncSelectionMock,
    };

    TestBed.configureTestingModule({
      providers: [
        NautilusSelectionService,
        { provide: NautilusService, useValue: mockNautilusService },
        { provide: NautilusTabService, useValue: mockTabService },
      ],
    });

    service = TestBed.inject(NautilusSelectionService);
  });

  describe('isItemSelectable', () => {
    it('returns true for all items when file picker is closed', () => {
      pickerStateSignal.set({ isOpen: false });

      expect(service.isItemSelectable(folderEntry)).toBe(true);
      expect(service.isItemSelectable(fileEntry)).toBe(true);
      expect(service.isItemSelectable(imageEntry)).toBe(true);
    });

    it('allows folders when selection is files', () => {
      pickerStateSignal.set({
        isOpen: true,
        options: { mode: 'local', selection: 'files' },
      });

      // Folders must always be selectable/navigable in files mode
      expect(service.isItemSelectable(folderEntry)).toBe(true);
      expect(service.isItemSelectable(fileEntry)).toBe(true);
    });

    it('filters files by allowedExtensions when selection is files', () => {
      pickerStateSignal.set({
        isOpen: true,
        options: { mode: 'local', selection: 'files', allowedExtensions: ['.jpg', '.png'] },
      });

      // Folder must remain selectable/navigable
      expect(service.isItemSelectable(folderEntry)).toBe(true);
      // photo.jpg matches allowed extension
      expect(service.isItemSelectable(imageEntry)).toBe(true);
      // report.pdf does not match
      expect(service.isItemSelectable(fileEntry)).toBe(false);
    });

    it('normalizes extensions without leading dot', () => {
      pickerStateSignal.set({
        isOpen: true,
        options: { mode: 'local', selection: 'files', allowedExtensions: ['jpg', 'png'] },
      });

      expect(service.isItemSelectable(imageEntry)).toBe(true);
      expect(service.isItemSelectable(fileEntry)).toBe(false);
    });

    it('rejects files when selection is folders', () => {
      pickerStateSignal.set({
        isOpen: true,
        options: { mode: 'local', selection: 'folders' },
      });

      expect(service.isItemSelectable(folderEntry)).toBe(true);
      expect(service.isItemSelectable(fileEntry)).toBe(false);
      expect(service.isItemSelectable(imageEntry)).toBe(false);
    });
  });

  describe('handleItemClick', () => {
    it('does nothing when clicking an unselectable item in picker mode', () => {
      pickerStateSignal.set({
        isOpen: true,
        options: { mode: 'local', selection: 'folders' },
      });

      const event = new MouseEvent('click');
      service.handleItemClick(fileItem, event, 0, 0, [fileItem]);

      expect(syncSelectionMock).not.toHaveBeenCalled();
    });

    it('selects item on single click', () => {
      const event = new MouseEvent('click');
      service.handleItemClick(fileItem, event, 0, 0, [fileItem]);

      expect(syncSelectionMock).toHaveBeenCalledWith(new Set([service.getItemKey(fileItem)]), 0);
    });

    it('excludes folders from multi-selection range when selection is files', () => {
      pickerStateSignal.set({
        isOpen: true,
        options: { mode: 'local', selection: 'files', multi: true },
      });

      const files = [fileItem, folderItem, imageItem];

      // First click on fileItem
      service.handleItemClick(fileItem, new MouseEvent('click'), 0, 0, files);

      // Shift-click on imageItem (spanning across folderItem)
      const shiftEvent = new MouseEvent('click', { shiftKey: true });
      service.handleItemClick(imageItem, shiftEvent, 2, 0, files);

      const lastCall = syncSelectionMock.mock.calls.at(-1);
      const selectedSet = lastCall ? (lastCall[0] as Set<string>) : new Set<string>();

      expect(selectedSet.has(service.getItemKey(fileItem))).toBe(true);
      expect(selectedSet.has(service.getItemKey(imageItem))).toBe(true);
      // Folder should not be in multi-file selection
      expect(selectedSet.has(service.getItemKey(folderItem))).toBe(false);
    });
  });

  describe('selectAll', () => {
    it('selects all selectable files and excludes folders in files picker mode', () => {
      pickerStateSignal.set({
        isOpen: true,
        options: { mode: 'local', selection: 'files', allowedExtensions: ['.jpg'] },
      });

      const files = [fileItem, folderItem, imageItem];
      service.selectAll(0, files);

      const lastCall = syncSelectionMock.mock.calls.at(-1);
      const selectedSet = lastCall ? (lastCall[0] as Set<string>) : new Set<string>();

      // imageItem matches .jpg
      expect(selectedSet.has(service.getItemKey(imageItem))).toBe(true);
      // fileItem is .pdf (unselectable)
      expect(selectedSet.has(service.getItemKey(fileItem))).toBe(false);
      // folderItem is a directory (excluded in files picker)
      expect(selectedSet.has(service.getItemKey(folderItem))).toBe(false);
    });
  });
});
