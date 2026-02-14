import { Component, HostListener, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { ModalService } from '@app/services';

@Component({
  selector: 'app-keyboard-shortcuts-modal',
  imports: [
    MatTableModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    MatButtonModule,
    SearchContainerComponent,
    TranslateModule,
  ],
  templateUrl: './keyboard-shortcuts-modal.component.html',
  styleUrls: ['./keyboard-shortcuts-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class KeyboardShortcutsModalComponent {
  searchText = '';
  searchVisible = false; // Controls the visibility of search field

  @ViewChild(SearchContainerComponent) searchContainer!: SearchContainerComponent;

  private translate = inject(TranslateService);

  // Schema using translation keys
  private defaultShortcuts = [
    {
      keys: 'Ctrl + Q',
      description: 'shortcuts.actions.quit',
      category: 'shortcuts.categories.global',
    },
    {
      keys: 'Ctrl + ?',
      description: 'shortcuts.actions.showShortcuts',
      category: 'shortcuts.categories.application',
    },
    {
      keys: 'Ctrl + ,',
      description: 'shortcuts.actions.openPreferences',
      category: 'shortcuts.categories.application',
    },
    {
      keys: 'Ctrl + .',
      description: 'shortcuts.actions.openConfig',
      category: 'shortcuts.categories.application',
    },
    {
      keys: 'Ctrl + Shift + M',
      description: 'shortcuts.actions.forceCheck',
      category: 'shortcuts.categories.remoteManagement',
    },
    {
      keys: 'Ctrl + N',
      description: 'shortcuts.actions.newRemoteDetailed',
      category: 'shortcuts.categories.remoteManagement',
    },
    {
      keys: 'Ctrl + R',
      description: 'shortcuts.actions.newRemoteQuick',
      category: 'shortcuts.categories.remoteManagement',
    },
    {
      keys: 'Ctrl + I',
      description: 'shortcuts.actions.loadConfig',
      category: 'shortcuts.categories.fileOperations',
    },
    {
      keys: 'Ctrl + E',
      description: 'shortcuts.actions.exportConfig',
      category: 'shortcuts.categories.fileOperations',
    },
    {
      keys: 'Ctrl + B',
      description: 'shortcuts.actions.toggleBrowser',
      category: 'shortcuts.categories.fileBrowser',
    },
    {
      keys: 'Escape',
      description: 'shortcuts.actions.closeDialog',
      category: 'shortcuts.categories.navigation',
    },
  ];

  private nautilusShortcuts = [
    {
      keys: 'Ctrl + C',
      description: 'nautilus.contextMenu.copy',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + X',
      description: 'nautilus.contextMenu.cut',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + V',
      description: 'nautilus.contextMenu.paste',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Delete',
      description: 'nautilus.contextMenu.delete',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + A',
      description: 'nautilus.contextMenu.selectAll',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'F5 / Ctrl + R',
      description: 'nautilus.contextMenu.refresh',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + Shift + N',
      description: 'nautilus.contextMenu.newFolder',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + F',
      description: 'nautilus.contextMenu.search',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + H',
      description: 'nautilus.view.showHidden',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Alt + Enter',
      description: 'nautilus.contextMenu.properties',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Backspace / Alt + Up',
      description: 'nautilus.contextMenu.goUp',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Alt + Left',
      description: 'nautilus.contextMenu.goBack',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Alt + Right',
      description: 'nautilus.contextMenu.goForward',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Enter',
      description: 'nautilus.contextMenu.open',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + L',
      description: 'nautilus.contextMenu.focusPath',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + T',
      description: 'nautilus.contextMenu.newTab',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + Tab',
      description: 'nautilus.contextMenu.nextTab',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + Shift + Tab',
      description: 'nautilus.contextMenu.previousTab',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + Shift + T',
      description: 'nautilus.contextMenu.duplicateTab',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + W',
      description: 'nautilus.contextMenu.closeTab',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + /',
      description: 'nautilus.contextMenu.toggleSplit',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Ctrl + I',
      description: 'nautilus.contextMenu.switchPane',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
    {
      keys: 'Escape',
      description: 'shortcuts.actions.closeDialog',
      category: 'shortcuts.categories.fileBrowserNautilus',
    },
  ];

  shortcuts: { keys: string; description: string; category: string }[] = [];
  title = 'shortcuts.title';

  private data = inject(MAT_DIALOG_DATA, { optional: true }) as { nautilus?: boolean } | null;

  constructor() {
    if (this.data?.nautilus) {
      // Nautilus context: show only nautilus shortcuts
      this.shortcuts = [...this.nautilusShortcuts];
      this.title = 'nautilus.shortcuts.title';
    } else {
      // App-level: show only default shortcuts
      this.shortcuts = [...this.defaultShortcuts];
      this.title = 'shortcuts.title';
    }
    this.filteredShortcuts = [...this.shortcuts];
  }

  filteredShortcuts: { keys: string; description: string; category: string }[] = [];

  private dialogRef = inject(MatDialogRef<KeyboardShortcutsModalComponent>);
  private modalService = inject(ModalService);

  @HostListener('document:keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }

  @HostListener('document:keydown.control.f')
  onF3(): void {
    this.toggleSearch();
    if (this.searchVisible && this.searchContainer) {
      this.searchContainer.focus();
    }
  }

  toggleSearch(): void {
    this.searchVisible = !this.searchVisible;
    if (!this.searchVisible) {
      this.clearSearch();
    }
  }

  onSearchTextChange(searchText: string): void {
    this.searchText = searchText;
    this.filterShortcuts();
  }

  filterShortcuts(): void {
    const searchTerm = this.searchText.toLowerCase().trim();

    if (!searchTerm) {
      this.filteredShortcuts = [...this.shortcuts];
      return;
    }

    this.filteredShortcuts = this.shortcuts.filter(shortcut => {
      const description = this.translate.instant(shortcut.description).toLowerCase();
      // const category = this.translate.instant(shortcut.category).toLowerCase(); // If we were searching categories

      return (
        description.includes(searchTerm) ||
        shortcut.keys.toLowerCase().includes(searchTerm) ||
        // Also search individual key parts
        shortcut.keys.split('+').some(key => key.trim().toLowerCase().includes(searchTerm))
      );
    });
  }

  clearSearch(): void {
    this.searchText = '';
    this.filteredShortcuts = [...this.shortcuts];
    if (this.searchContainer) {
      this.searchContainer.clear();
    }
  }
}
