import { Directive, HostListener, inject, WritableSignal, Signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { NautilusService, NautilusTabService, NautilusFileOperationsService } from '@app/services';
import { FileBrowserItem } from '@app/types';

export interface KeyboardCallbacks {
  navigateTo: (item: FileBrowserItem) => void;
  getSelectedItems: () => FileBrowserItem[];
  setContextItem: (item: FileBrowserItem | null) => void;
  openInNewTab: () => void;
  openInNewWindow: () => void;
  openRename: () => Promise<void>;
  openNewFolder: () => Promise<void>;
  openProperties: () => void;
  deleteSelected: () => Promise<void>;
  selectAll: () => void;
  clearSelection: () => void;
  clearClipboard: () => void;
  pasteItems: () => Promise<void>;
  refresh: () => void;
  toggleSplit: () => void;
  toggleSearch: () => void;
  toggleShowHidden: (v: boolean) => void;
  isEditingPath: WritableSignal<boolean>;
  pathSegments: Signal<{ name: string; path: string }[]>;
  showHidden: Signal<boolean>;
  isPickerMode: Signal<boolean>;
  navigateToSegment: (index: number) => void;
}

@Directive({
  selector: '[appNautilusKeyboard]',
  standalone: true,
})
export class NautilusKeyboardDirective {
  private readonly dialog = inject(MatDialog);
  private readonly nautilusService: NautilusService = inject(NautilusService);
  private readonly tabSvc: NautilusTabService = inject(NautilusTabService);
  private readonly fileOps: NautilusFileOperationsService = inject(NautilusFileOperationsService);

  private callbacks!: KeyboardCallbacks;

  register(callbacks: KeyboardCallbacks): void {
    this.callbacks = callbacks;
  }

  @HostListener('window:keydown', ['$event'])
  async handleKeyDown(event: KeyboardEvent): Promise<void> {
    if (this.dialog.openDialogs.length > 0 || !this.callbacks) {
      return;
    }

    if (this.isInputFocused(event)) {
      if (event.key === 'Escape') (event.target as HTMLElement).blur();
      return;
    }

    const isCtrl = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;
    const isAlt = event.altKey;

    if (await this.handleClipboardShortcuts(event, isCtrl, isShift)) return;
    if (this.handleNavigationShortcuts(event, isCtrl, isAlt, isShift)) return;
    if (this.handleSelectionShortcuts(event, isCtrl)) return;
    if (await this.handleFileOperationsShortcuts(event, isCtrl, isShift)) return;
  }

  private isInputFocused(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement;
    return (
      target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
    );
  }

  private async handleClipboardShortcuts(
    event: KeyboardEvent,
    isCtrl: boolean,
    isShift: boolean
  ): Promise<boolean> {
    if (!isCtrl) return false;
    switch (event.key.toLowerCase()) {
      case 'c':
        event.preventDefault();
        this.fileOps.copyItems(this.callbacks.getSelectedItems());
        return true;
      case 'x':
        event.preventDefault();
        this.fileOps.cutItems(this.callbacks.getSelectedItems());
        return true;
      case 'v':
        event.preventDefault();
        await this.callbacks.pasteItems();
        return true;
      case 'z':
        event.preventDefault();
        if (isShift) await this.fileOps.redoLastOperation();
        else await this.fileOps.undoLastOperation();
        return true;
      case 'y':
        event.preventDefault();
        await this.fileOps.redoLastOperation();
        return true;
    }
    return false;
  }

  private handleNavigationShortcuts(
    event: KeyboardEvent,
    isCtrl: boolean,
    isAlt: boolean,
    isShift: boolean
  ): boolean {
    if (isCtrl && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      this.callbacks.isEditingPath.set(true);
      return true;
    }

    if (event.key === 'Backspace' || (isAlt && event.key === 'ArrowUp')) {
      if (this.callbacks.pathSegments().length > 0) {
        event.preventDefault();
        this.callbacks.navigateToSegment(this.callbacks.pathSegments().length - 2);
      }
      return true;
    }

    if (isAlt && event.key === 'ArrowLeft' && this.tabSvc.canGoBack()) {
      event.preventDefault();
      this.tabSvc.goBack();
      return true;
    }

    if (isAlt && event.key === 'ArrowRight' && this.tabSvc.canGoForward()) {
      event.preventDefault();
      this.tabSvc.goForward();
      return true;
    }

    if (event.key === 'Enter' && !isAlt) {
      const selected = this.callbacks.getSelectedItems();
      if (selected.length === 1) {
        event.preventDefault();
        const item = selected[0];

        if (isCtrl) {
          this.callbacks.setContextItem(item);
          this.callbacks.openInNewTab();
        } else if (isShift) {
          this.callbacks.setContextItem(item);
          this.callbacks.openInNewWindow();
        } else {
          this.callbacks.navigateTo(item);
        }
        return true;
      }
    }

    if (isCtrl && event.key === 'Tab') {
      event.preventDefault();
      const count = this.tabSvc.tabs().length;
      if (count > 0) {
        const next = isShift
          ? (this.tabSvc.activeTabIndex() - 1 + count) % count
          : (this.tabSvc.activeTabIndex() + 1) % count;
        this.tabSvc.switchTab(next);
      }
      return true;
    }

    if (isCtrl && event.key.toLowerCase() === 't') {
      event.preventDefault();
      if (isShift) this.tabSvc.duplicateTab(this.tabSvc.activeTabIndex());
      else this.tabSvc.createTab(this.tabSvc.activeRemote(), this.tabSvc.activePath());
      return true;
    }

    if (isCtrl && event.key.toLowerCase() === 'w') {
      event.preventDefault();
      this.tabSvc.closeTab(this.tabSvc.activeTabIndex());
      return true;
    }

    return false;
  }

  private handleSelectionShortcuts(event: KeyboardEvent, isCtrl: boolean): boolean {
    if (isCtrl && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.callbacks.selectAll();
      return true;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.callbacks.isPickerMode()) {
        this.nautilusService.closeFilePicker(null);
        return true;
      }
      if (this.tabSvc.activePaneIndex() === 0) {
        if (this.tabSvc.selectedItems().size > 0) this.callbacks.clearSelection();
        else this.fileOps.clearClipboard();
      } else {
        if (this.tabSvc.selectedItemsRight().size > 0) this.callbacks.clearSelection();
        else this.fileOps.clearClipboard();
      }
      return true;
    }

    return false;
  }

  private async handleFileOperationsShortcuts(
    event: KeyboardEvent,
    isCtrl: boolean,
    isShift: boolean
  ): Promise<boolean> {
    if (event.key === 'F2') {
      const selected = this.callbacks.getSelectedItems();
      if (selected.length === 1) {
        event.preventDefault();
        this.callbacks.setContextItem(selected[0]);
        await this.callbacks.openRename();
        return true;
      }
    }

    if (event.key === 'Delete') {
      event.preventDefault();
      await this.callbacks.deleteSelected();
      return true;
    }

    if (event.key === 'F5' || (isCtrl && event.key.toLowerCase() === 'r')) {
      event.preventDefault();
      this.callbacks.refresh();
      return true;
    }

    if (isCtrl && isShift && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      await this.callbacks.openNewFolder();
      return true;
    }

    if (event.altKey && event.key === 'Enter') {
      event.preventDefault();
      this.callbacks.openProperties();
      return true;
    }

    if (isCtrl && event.key === '/') {
      event.preventDefault();
      this.tabSvc.toggleSplit();
      return true;
    }

    if (isCtrl && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.callbacks.toggleSearch();
      return true;
    }

    if (isCtrl && event.key.toLowerCase() === 'h') {
      event.preventDefault();
      this.callbacks.toggleShowHidden(!this.callbacks.showHidden());
      return true;
    }

    return false;
  }
}
