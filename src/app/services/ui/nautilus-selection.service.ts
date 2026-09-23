import { inject, Injectable } from '@angular/core';
import { NautilusService } from './nautilus.service';
import { NautilusTabService } from './nautilus-tab.service';
import { FileBrowserItem, Entry, fileBrowserItemKey } from '@app/types';

@Injectable()
export class NautilusSelectionService {
  private readonly tabSvc = inject(NautilusTabService);
  private readonly nautilusService = inject(NautilusService);

  private lastSelectedIndex: Record<0 | 1, number | null> = { 0: null, 1: null };

  isItemSelectable(item: Entry): boolean {
    const state = this.nautilusService.filePickerState();
    if (!state.isOpen) return true;
    const opts = state.options;
    if (!opts) return true;

    // Folders are always selectable and navigable in picker mode
    if (item.IsDir) return true;

    // When picking folders only, files are not selectable
    if (opts.selection === 'folders') return false;

    // Check allowed file extensions
    if (opts.allowedExtensions?.length) {
      const name = item.Name.toLowerCase();
      if (
        !opts.allowedExtensions.some(ext => {
          const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
          return name.endsWith(normalized);
        })
      ) {
        return false;
      }
    }
    return true;
  }

  getItemKey(item: FileBrowserItem | null): string {
    return fileBrowserItemKey(item);
  }

  getSelectedItemsList(currentFiles: FileBrowserItem[]): FileBrowserItem[] {
    const selection = this.tabSvc.activeSelection();
    return currentFiles.filter((item: FileBrowserItem) => selection.has(this.getItemKey(item)));
  }

  handleItemClick(
    item: FileBrowserItem,
    event: MouseEvent,
    index: number,
    paneIndex: 0 | 1,
    currentFiles: FileBrowserItem[]
  ): void {
    if (this.nautilusService.filePickerState().isOpen && !this.isItemSelectable(item.entry)) return;

    if (this.tabSvc.activePaneIndex() !== paneIndex) {
      this.tabSvc.switchPane(paneIndex);
    }

    const currentSel =
      paneIndex === 0 ? this.tabSvc.selectedItems() : this.tabSvc.selectedItemsRight();
    const pickerState = this.nautilusService.filePickerState();
    const isPicker = pickerState.isOpen;
    const multi = !isPicker || !!pickerState.options?.multi;
    const isFileOnlyPicker = isPicker && pickerState.options?.selection === 'files';
    const itemKey = this.getItemKey(item);
    const newSel = new Set<string>();

    const lastIdx = this.lastSelectedIndex[paneIndex];
    if (event.shiftKey && lastIdx !== null && multi) {
      if (event.ctrlKey || event.metaKey) {
        currentSel.forEach(k => newSel.add(k));
      }
      const safeLastIdx = Math.max(0, Math.min(lastIdx, currentFiles.length - 1));
      const safeIdx = Math.max(0, Math.min(index, currentFiles.length - 1));
      const start = Math.min(safeLastIdx, safeIdx);
      const end = Math.max(safeLastIdx, safeIdx);
      for (let i = start; i <= end; i++) {
        const f = currentFiles[i];
        if (f && (!isFileOnlyPicker || !f.entry.IsDir)) {
          newSel.add(this.getItemKey(f));
        }
      }
    } else if (event.ctrlKey || event.metaKey) {
      currentSel.forEach(k => newSel.add(k));
      if (newSel.has(itemKey)) {
        newSel.delete(itemKey);
      } else if (!isFileOnlyPicker || !item.entry.IsDir) {
        newSel.add(itemKey);
      }
      this.lastSelectedIndex[paneIndex] = index;
    } else {
      newSel.add(itemKey);
      this.lastSelectedIndex[paneIndex] = index;
    }

    this.tabSvc.syncSelection(newSel, paneIndex);
  }

  handleContextItem(
    item: FileBrowserItem | null,
    paneIndex: 0 | 1,
    currentFiles: FileBrowserItem[]
  ): void {
    if (item) {
      if (this.tabSvc.activePaneIndex() !== paneIndex) {
        this.tabSvc.switchPane(paneIndex);
      }

      const currentSelection =
        paneIndex === 0 ? this.tabSvc.selectedItems() : this.tabSvc.selectedItemsRight();
      if (!currentSelection.has(this.getItemKey(item))) {
        this.tabSvc.syncSelection(new Set<string>([this.getItemKey(item)]), paneIndex);
        this.lastSelectedIndex[paneIndex] = currentFiles.findIndex(
          f => this.getItemKey(f) === this.getItemKey(item)
        );
      }
    }
  }

  clearSelection(paneIndex?: 0 | 1): void {
    this.tabSvc.syncSelection(new Set(), paneIndex);
    if (paneIndex !== undefined) {
      this.lastSelectedIndex[paneIndex] = null;
    } else {
      this.lastSelectedIndex[0] = null;
      this.lastSelectedIndex[1] = null;
    }
  }

  selectAll(paneIndex: 0 | 1, currentFiles: FileBrowserItem[]): void {
    const isFileOnlyPicker =
      this.nautilusService.filePickerState().isOpen &&
      this.nautilusService.filePickerState().options?.selection === 'files';

    const selectableFiles = currentFiles.filter(
      f => this.isItemSelectable(f.entry) && (!isFileOnlyPicker || !f.entry.IsDir)
    );
    this.tabSvc.syncSelection(new Set(selectableFiles.map(f => this.getItemKey(f))), paneIndex);
  }
}
