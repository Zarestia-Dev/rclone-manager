import { inject, Injectable } from '@angular/core';
import { NautilusService } from '@app/services';
import { NautilusActionsService } from './nautilus-actions.service';
import { NautilusTabService } from './nautilus-tab.service';
import { FileBrowserItem, Entry } from '@app/types';

@Injectable()
export class NautilusSelectionService {
  private readonly tabSvc = inject(NautilusTabService);
  private readonly nautilusService = inject(NautilusService);
  private readonly actions = inject(NautilusActionsService);

  private lastSelectedIndex: Record<0 | 1, number | null> = { 0: null, 1: null };

  isItemSelectable(item: Entry): boolean {
    const state = this.nautilusService.filePickerState();
    if (!state.isOpen) return true;
    const opts = state.options;
    if (!opts) return true;

    if (opts.selection === 'folders' && !item.IsDir) return false;
    if (opts.selection === 'files' && item.IsDir) return false;
    if (!item.IsDir && opts.allowedExtensions?.length) {
      const name = item.Name.toLowerCase();
      if (!opts.allowedExtensions.some(ext => name.endsWith(ext.toLowerCase()))) {
        return false;
      }
    }
    return true;
  }

  getItemKey(item: FileBrowserItem | null): string {
    if (!item) return '';
    return `${item.meta.remote}:${item.entry.Path}`;
  }

  getSelectedItemsList(currentFiles: FileBrowserItem[]): FileBrowserItem[] {
    const selection =
      this.tabSvc.activePaneIndex() === 0
        ? this.tabSvc.selectedItems()
        : this.tabSvc.selectedItemsRight();
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
    const multi = !pickerState.isOpen || !!pickerState.options?.multi;
    const itemKey = this.getItemKey(item);
    const newSel = new Set<string>();

    if (event.shiftKey && this.lastSelectedIndex[paneIndex] !== null && multi) {
      const start = Math.min(this.lastSelectedIndex[paneIndex]!, index);
      const end = Math.max(this.lastSelectedIndex[paneIndex]!, index);
      for (let i = start; i <= end; i++) {
        if (currentFiles[i]) newSel.add(this.getItemKey(currentFiles[i]));
      }
    } else if (event.ctrlKey || event.metaKey) {
      currentSel.forEach(k => newSel.add(k));
      if (newSel.has(itemKey)) newSel.delete(itemKey);
      else newSel.add(itemKey);
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
    this.actions.contextMenuItem.set(item);

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
    this.tabSvc.syncSelection(new Set(currentFiles.map(f => this.getItemKey(f))), paneIndex);
  }
}
