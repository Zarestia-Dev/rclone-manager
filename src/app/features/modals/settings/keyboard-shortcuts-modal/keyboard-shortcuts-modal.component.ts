import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import { ModalService } from '@app/services';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';

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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyboardShortcutsModalComponent {
  private readonly translate = inject(TranslateService);
  private readonly dialogRef = inject(MatDialogRef<KeyboardShortcutsModalComponent>);
  private readonly modalService = inject(ModalService);
  private readonly data = inject(MAT_DIALOG_DATA, { optional: true }) as {
    nautilus?: boolean;
  } | null;

  readonly searchContainer = viewChild(SearchContainerComponent);

  // Signals
  readonly searchText = signal('');
  readonly searchVisible = signal(false);

  // Schema using translation keys
  private readonly defaultShortcuts = [
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

  private readonly nautilusShortcuts = [
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

  readonly shortcuts: { keys: string; description: string; category: string }[];
  readonly title: string;

  readonly filteredShortcuts = computed(() => {
    const term = this.searchText().toLowerCase().trim();
    if (!term) return this.shortcuts;

    return this.shortcuts.filter(shortcut => {
      const description = this.translate.instant(shortcut.description).toLowerCase();
      return (
        description.includes(term) ||
        shortcut.keys.toLowerCase().includes(term) ||
        shortcut.keys.split('+').some(key => key.trim().toLowerCase().includes(term))
      );
    });
  });

  constructor() {
    if (this.data?.nautilus) {
      this.shortcuts = [...this.nautilusShortcuts];
      this.title = 'nautilus.shortcuts.title';
    } else {
      this.shortcuts = [...this.defaultShortcuts];
      this.title = 'shortcuts.title';
    }
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }

  @HostListener('document:keydown.control.f')
  onF3(): void {
    this.toggleSearch();
    if (this.searchVisible()) {
      this.searchContainer()?.focus();
    }
  }

  toggleSearch(): void {
    this.searchVisible.update(v => !v);
    if (!this.searchVisible()) {
      this.clearSearch();
    }
  }

  onSearchTextChange(text: string): void {
    this.searchText.set(text);
  }

  clearSearch(): void {
    this.searchText.set('');
    this.searchContainer()?.clear();
  }
}
