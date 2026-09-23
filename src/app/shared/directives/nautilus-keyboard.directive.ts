import { Directive, HostListener, inject, WritableSignal, Signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { NautilusTabService } from 'src/app/services/ui/nautilus-tab.service';
import { NautilusFileOperationsService } from 'src/app/services/ui/nautilus-file-operations.service';
import { FileBrowserItem } from '@app/types';
import { isInputFocused, matchesShortcut } from '../utils/keyboard-utils';

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
  isSearchMode?: Signal<boolean>;
  navigateToSegment: (index: number) => void;
}

@Directive({
  selector: '[appNautilusKeyboard]',
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

    if (isInputFocused(event)) {
      if (event.key === 'Escape') (event.target as HTMLElement).blur();
      return;
    }

    if (await this.handleClipboardShortcuts(event)) return;
    if (this.handleNavigationShortcuts(event)) return;
    if (this.handleSelectionShortcuts(event)) return;
    if (await this.handleFileOperationsShortcuts(event)) return;
  }

  @HostListener('window:paste', ['$event'])
  async handlePasteEvent(event: ClipboardEvent): Promise<void> {
    if (this.dialog.openDialogs.length > 0 || !this.callbacks) return;
    if (isInputFocused(event)) return;

    const files = event.clipboardData?.files;
    if (files && files.length > 0) {
      event.preventDefault();
      const activeRemote = this.tabSvc.activeRemote();
      const activePath = this.tabSvc.activePath();
      if (activeRemote) {
        await this.fileOps.uploadWebFiles(activeRemote, activePath, files);
        this.tabSvc.refresh(this.tabSvc.activePaneIndex());
      }
      return;
    }

    const textData =
      event.clipboardData?.getData('text/uri-list') || event.clipboardData?.getData('text/plain');
    if (textData) {
      const paths = this.fileOps.parseClipboardPaths(textData);
      if (paths.length > 0) {
        event.preventDefault();
        await this.callbacks.pasteItems();
      }
    }
  }

  private async handleClipboardShortcuts(event: KeyboardEvent): Promise<boolean> {
    if (matchesShortcut('Ctrl + C', event)) {
      event.preventDefault();
      this.fileOps.copyItems(this.callbacks.getSelectedItems());
      return true;
    }
    if (matchesShortcut('Ctrl + X', event)) {
      event.preventDefault();
      this.fileOps.cutItems(this.callbacks.getSelectedItems());
      return true;
    }
    if (matchesShortcut('Ctrl + V', event)) {
      event.preventDefault();
      await this.callbacks.pasteItems();
      return true;
    }
    if (matchesShortcut('Ctrl + Shift + Z / Ctrl + Y', event)) {
      event.preventDefault();
      await this.fileOps.redoLastOperation();
      return true;
    }
    if (matchesShortcut('Ctrl + Z', event)) {
      event.preventDefault();
      await this.fileOps.undoLastOperation();
      return true;
    }
    return false;
  }

  private handleNavigationShortcuts(event: KeyboardEvent): boolean {
    if (matchesShortcut('Ctrl + L', event)) {
      event.preventDefault();
      this.callbacks.isEditingPath.set(true);
      return true;
    }

    if (matchesShortcut('Backspace / Alt + Up', event)) {
      if (this.callbacks.pathSegments().length > 0) {
        event.preventDefault();
        this.callbacks.navigateToSegment(this.callbacks.pathSegments().length - 2);
      }
      return true;
    }

    if (matchesShortcut('Alt + Left', event) && this.tabSvc.canGoBack()) {
      event.preventDefault();
      this.tabSvc.goBack();
      return true;
    }

    if (matchesShortcut('Alt + Right', event) && this.tabSvc.canGoForward()) {
      event.preventDefault();
      this.tabSvc.goForward();
      return true;
    }

    if (event.key === 'Enter' && !event.altKey) {
      const selected = this.callbacks.getSelectedItems();
      if (selected.length === 1) {
        event.preventDefault();
        const item = selected[0];

        if (event.ctrlKey || event.metaKey) {
          this.callbacks.setContextItem(item);
          this.callbacks.openInNewTab();
        } else if (event.shiftKey) {
          this.callbacks.setContextItem(item);
          this.callbacks.openInNewWindow();
        } else {
          this.callbacks.navigateTo(item);
        }
        return true;
      }
    }

    if (matchesShortcut('Ctrl + Shift + Tab', event)) {
      event.preventDefault();
      const count = this.tabSvc.tabs().length;
      if (count > 0) {
        const next = (this.tabSvc.activeTabIndex() - 1 + count) % count;
        this.tabSvc.switchTab(next);
      }
      return true;
    }

    if (matchesShortcut('Ctrl + Tab', event)) {
      event.preventDefault();
      const count = this.tabSvc.tabs().length;
      if (count > 0) {
        const next = (this.tabSvc.activeTabIndex() + 1) % count;
        this.tabSvc.switchTab(next);
      }
      return true;
    }

    if (matchesShortcut('Ctrl + Shift + T', event)) {
      event.preventDefault();
      this.tabSvc.duplicateTab(this.tabSvc.activeTabIndex());
      return true;
    }

    if (matchesShortcut('Ctrl + T', event)) {
      event.preventDefault();
      this.tabSvc.createTab(this.tabSvc.activeRemote(), this.tabSvc.activePath());
      return true;
    }

    if (matchesShortcut('Ctrl + W', event)) {
      event.preventDefault();
      this.tabSvc.closeTab(this.tabSvc.activeTabIndex());
      return true;
    }

    return false;
  }

  private handleSelectionShortcuts(event: KeyboardEvent): boolean {
    if (matchesShortcut('Ctrl + A', event)) {
      event.preventDefault();
      this.callbacks.selectAll();
      return true;
    }

    if (matchesShortcut('Escape', event)) {
      event.preventDefault();
      if (this.callbacks.isSearchMode?.()) {
        this.callbacks.toggleSearch();
        return true;
      }
      if (this.callbacks.isPickerMode()) {
        this.nautilusService.closeFilePicker(null);
        return true;
      }
      if (this.tabSvc.activeSelection().size > 0) {
        this.callbacks.clearSelection();
      } else {
        this.fileOps.clearClipboard();
      }
      return true;
    }

    return false;
  }

  private async handleFileOperationsShortcuts(event: KeyboardEvent): Promise<boolean> {
    if (matchesShortcut('F2', event)) {
      const selected = this.callbacks.getSelectedItems();
      if (selected.length === 1) {
        event.preventDefault();
        this.callbacks.setContextItem(selected[0]);
        await this.callbacks.openRename();
        return true;
      }
    }

    if (matchesShortcut('Delete', event)) {
      event.preventDefault();
      await this.callbacks.deleteSelected();
      return true;
    }

    if (matchesShortcut('F5 / Ctrl + R', event)) {
      event.preventDefault();
      this.callbacks.refresh();
      return true;
    }

    if (matchesShortcut('Ctrl + Shift + N', event)) {
      event.preventDefault();
      await this.callbacks.openNewFolder();
      return true;
    }

    if (matchesShortcut('Alt + Enter', event)) {
      event.preventDefault();
      this.callbacks.openProperties();
      return true;
    }

    if (matchesShortcut('Ctrl + /', event)) {
      event.preventDefault();
      this.tabSvc.toggleSplit();
      return true;
    }

    if (matchesShortcut('Ctrl + F', event)) {
      event.preventDefault();
      this.callbacks.toggleSearch();
      return true;
    }

    if (matchesShortcut('Ctrl + H', event)) {
      event.preventDefault();
      this.callbacks.toggleShowHidden(!this.callbacks.showHidden());
      return true;
    }

    return false;
  }
}
